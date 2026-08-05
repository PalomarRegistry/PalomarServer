import {
  COMMIT_RE,
  PALOMAR_ID_RE,
  digest,
  newAccessToken,
  newSubmissionId,
  newRecord,
  parseRepository,
  statePath,
  tokenDigest,
} from "./submission.js";
import {
  dispatchVerification,
  findVerificationRun,
  deleteState,
  listState,
  readState,
  repository as fetchRepository,
  resolveCommit,
  writeState,
} from "./github.js";
import { page, intakeForm, statusPage, errorPage } from "./html.js";

const SECURITY_HEADERS = {
  // The intake form checks the repository, the commit, and a cited Palomar ID
  // straight from the browser, so those two origins are reachable and nothing
  // else is. Neither answer is trusted: the server checks all three again.
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self' https://api.github.com https://raw.githubusercontent.com; " +
    "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
};

function html(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS, ...extra },
  });
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS },
  });
}

// Admission limits, until per-submitter quotas and backoff exist.
const RELATIONSHIPS = new Set(["maintainer", "approved"]);
// The verifier speaks the long form; the form and the record speak the short.
const RELATIONSHIP_LABELS = {
  maintainer: "I am a responsible author or maintainer",
  approved: "I have approval from a responsible author or maintainer",
};
const MAX_INFLIGHT_TOTAL = 12;
const MAX_INFLIGHT_PER_OWNER = 2;

const TERMINAL = new Set(["published", "withdrawn", "verification-failed"]);

/** The one-time exchange: fragment in, short-lived host-only cookie out. */
function sessionCookie(token) {
  return {
    "set-cookie":
      `palomar_session=${token}; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict`,
  };
}

function sessionToken(request) {
  const cookie = request.headers.get("cookie") ?? "";
  const match = /(?:^|;\s*)palomar_session=([0-9a-f]{64})(?:;|$)/.exec(cookie);
  return match ? match[1] : null;
}

function now() {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

/**
 * Intake, before any credential is involved.
 *
 * Everything checkable without the submitter's identity is checked here, so a
 * malformed submission never reaches the OAuth round trip.
 */
async function beginSubmission(request, env) {
  const form = await request.formData();
  const repositoryName = parseRepository(form.get("repository"));
  const commit = String(form.get("commit") ?? "").trim().toLowerCase();
  const existingId = String(form.get("existing_id") ?? "").trim();
  const context = String(form.get("context") ?? "").trim().slice(0, 4000);
  const relationship = String(form.get("authorization_relationship") ?? "").trim();
  const evidence = String(form.get("authorization_evidence") ?? "").trim().slice(0, 2000);

  const values = {
    repository: String(form.get("repository") ?? ""),
    commit: String(form.get("commit") ?? ""),
    existing_id: existingId,
    context,
    authorization_relationship: relationship,
    authorization_evidence: evidence,
  };
  const rejected = (...problems) => html(intakeForm(env, values, problems), 400);

  const problems = [];
  if (!repositoryName) problems.push("Repository must be a GitHub owner/name or URL.");
  if (!COMMIT_RE.test(commit)) {
    problems.push("Commit must be a full 40-character lowercase SHA. Branches and tags move.");
  }
  if (existingId && !PALOMAR_ID_RE.test(existingId)) {
    problems.push("Existing Palomar ID is malformed.");
  }
  if (!RELATIONSHIPS.has(relationship)) {
    problems.push("Say whether you maintain this formalization or have approval to submit it.");
  }
  if (problems.length) return rejected(...problems);

  const repo = await fetchRepository(env.GITHUB_TOKEN, repositoryName);
  if (!repo) {
    return rejected(`${repositoryName} could not be read. Palomar accepts public repositories only.`);
  }
  if (repo.private) {
    return rejected(
      "Palomar records point at source anyone can inspect, so submissions must be public.",
    );
  }
  if (!(await resolveCommit(env.SUBMISSION_TOKEN, repositoryName, commit))) {
    return rejected(`${commit} was not found in ${repositoryName}.`);
  }

  // A pending intake, so the callback can recover exactly what was asked for
  // without trusting anything the browser carries back except an opaque nonce.
  const nonce = newAccessToken();
  const pending = {
    schema_version: 1,
    repository: repositoryName,
    commit,
    existing_id: existingId || null,
    context: context || null,
    authorization_relationship: relationship,
    authorization_evidence: evidence || null,
    created_at: now(),
  };
  try {
    await writeState(
      env,
      `pending/${await digest(nonce)}.json`,
      pending,
      `Begin submission for ${repositoryName}`,
    );
  } catch (error) {
    // Nothing the submitter did wrong, and nothing they should have to retype.
    return rejected(
      "Palomar could not record that submission just now. Nothing was lost; try again.",
    );
  }

  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", env.OAUTH_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", `${new URL(request.url).origin}/oauth/callback`);
  authorize.searchParams.set("scope", "read:user");
  authorize.searchParams.set("state", nonce);
  return Response.redirect(authorize.toString(), 303);
}

/**
 * Prove the submitter can push to the repository they are submitting.
 *
 * The token is used once, here, and never stored. Push access is not the same
 * as authorship, and does not replace the declaration a submitter makes about
 * their relationship to the substantive formalization.
 */
async function completeSubmission(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const nonce = url.searchParams.get("state");
  if (!code || !nonce) return html(errorPage(env, "That sign-in did not complete", []), 400);

  const pendingPath = `pending/${await digest(nonce)}.json`;
  const pending = await readState(env, pendingPath);
  if (!pending.value) {
    return html(errorPage(env, "That sign-in has already been used", [
      "Start again from the submission form.",
    ]), 400);
  }
  // Consume the nonce before doing anything else, so a replayed callback
  // cannot produce a second submission.
  await fetch(
    `https://api.github.com/repos/${env.STATE_REPO}/contents/${encodeURI(pendingPath)}`,
    {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: "application/vnd.github+json",
        "user-agent": "palomar-server",
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "Consume pending intake", sha: pending.sha }),
    },
  );

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env.OAUTH_CLIENT_ID,
      client_secret: env.OAUTH_CLIENT_SECRET,
      code,
    }),
  });
  const granted = await tokenResponse.json();
  if (!granted?.access_token) {
    return html(errorPage(env, "GitHub declined that sign-in", []), 400);
  }

  const viewer = await fetchRepository(granted.access_token, pending.value.repository);
  const user = await (
    await fetch("https://api.github.com/user", {
      headers: {
        authorization: `Bearer ${granted.access_token}`,
        accept: "application/vnd.github+json",
        "user-agent": "palomar-server",
      },
    })
  ).json();

  if (!viewer?.permissions?.push) {
    return html(errorPage(env, "You cannot push to that repository", [
      `Palomar asks submitters to prove write access to ${pending.value.repository}.`,
      "If you are submitting someone else's formalization, ask a maintainer to submit it.",
    ]), 403);
  }

  // Anyone who can prove push access to any public repository can reach this
  // point, including on a repository they created a minute ago. Verification
  // is expensive and long-running, so admission is capped until real quotas
  // exist. This is deliberately blunt: refusing a genuine submitter with a
  // clear message is recoverable, exhausting the runners is not.
  const inflight = await readState(env, "index/inflight.json");
  const open = Array.isArray(inflight.value?.open) ? inflight.value.open : [];
  const owner = viewer.owner?.login ?? "";
  if (open.length >= MAX_INFLIGHT_TOTAL) {
    return html(errorPage(env, "Palomar is at capacity", [
      "Too many submissions are being verified right now. Please try again later.",
    ]), 503);
  }
  if (open.filter((item) => item.owner === owner).length >= MAX_INFLIGHT_PER_OWNER) {
    return html(errorPage(env, "You already have submissions in flight", [
      `Palomar verifies at most ${MAX_INFLIGHT_PER_OWNER} submissions at a time from one owner.`,
      "Wait for those to finish before submitting another.",
    ]), 429);
  }

  const id = newSubmissionId();
  const token = newAccessToken();
  const record = {
    ...newRecord({
      id,
      repositoryName: pending.value.repository,
      commit: pending.value.commit,
      owner: viewer.owner?.login ?? null,
      submitter: user?.login ?? null,
      existingId: pending.value.existing_id,
      context: pending.value.context,
      authorization: {
        relationship: pending.value.authorization_relationship,
        ...(pending.value.authorization_evidence
          ? { evidence: pending.value.authorization_evidence }
          : {}),
      },
    }),
    created_at: now(),
    token_sha256: await tokenDigest(env, token),
    events: [{ at: now(), status: "verifying", note: "Mechanical verification dispatched" }],
  };
  await writeState(env, statePath(id, "state.json"), record, `Open submission ${id}`);
  await writeState(
    env,
    "index/inflight.json",
    { open: [...open, { id, owner, at: record.created_at }] },
    `Admit ${id}`,
    inflight.sha,
  );
  await writeState(
    env,
    `index/tokens/${record.token_sha256}.json`,
    { id },
    `Index submission ${id}`,
  );
  await dispatchVerification(env, {
    repositoryName: record.repository,
    commit: record.commit,
    requestId: id,
    options: {
      authorization_relationship: RELATIONSHIP_LABELS[record.authorization.relationship],
      ...(record.authorization.evidence
        ? { authorization_evidence: record.authorization.evidence }
        : {}),
      ...(record.existing_id ? { existing_id: record.existing_id } : {}),
      ...(record.context ? { context: record.context } : {}),
    },
  });

  // The token goes in the fragment, which browsers never send to a server, so
  // it stays out of request logs and Referer headers. The page exchanges it
  // for a short-lived cookie.
  return Response.redirect(`${new URL(request.url).origin}/s#${token}`, 303);
}

async function loadByToken(env, token) {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const pointer = await readState(env, `index/tokens/${await tokenDigest(env, token)}.json`);
  if (!pointer.value?.id) return null;
  const record = await readState(env, statePath(pointer.value.id, "state.json"));
  return record.value ? { record: record.value, sha: record.sha } : null;
}

/** Refresh a verifying submission from the run it dispatched. */
async function refresh(env, entry) {
  const record = entry.record;
  if (record.status !== "verifying") return record;
  const run = await findVerificationRun(env, record.id);
  if (!run) return record;
  // The run is pinned the first time it is seen. A second run carrying the
  // same public submission id must not be able to take its place.
  if (record.run?.id && record.run.id !== run.id) return record;

  const next = { ...record, run };
  if (run.status === "completed") {
    next.status = run.conclusion === "success" ? "awaiting-review" : "verification-failed";
    next.events = [
      ...record.events,
      { at: now(), status: next.status, note: `Verification ${run.conclusion}` },
    ];
  }
  if (next.status !== "verifying" && record.status === "verifying") {
    await release(env, record.id);
  }
  if (JSON.stringify(next) !== JSON.stringify(record)) {
    await writeState(
      env,
      statePath(record.id, "state.json"),
      next,
      `Update ${record.id}: ${next.status}`,
      entry.sha,
    );
  }
  return next;
}

async function release(env, id) {
  const inflight = await readState(env, "index/inflight.json");
  const open = Array.isArray(inflight.value?.open) ? inflight.value.open : [];
  if (!open.some((item) => item.id === id)) return;
  await writeState(env, "index/inflight.json",
                   { open: open.filter((item) => item.id !== id) },
                   `Release ${id}`, inflight.sha);
}

/**
 * Free admission slots whose submissions have finished.
 *
 * Slots used to be released only when the submitter's page polled, so closing
 * the tab held one forever and enough abandoned submissions would wedge
 * intake. This runs on a schedule instead, so nothing depends on a browser
 * staying open.
 */
async function reconcile(env) {
  const inflight = await readState(env, "index/inflight.json");
  const open = Array.isArray(inflight.value?.open) ? inflight.value.open : [];
  const still = [];
  for (const item of open) {
    const record = await readState(env, statePath(item.id, "state.json"));
    if (!record.value) continue;               // vanished: do not hold its slot
    if (record.value.status !== "verifying") continue;
    const run = await findVerificationRun(env, item.id);
    if (run?.status === "completed") {
      await writeState(env, statePath(item.id, "state.json"), {
        ...record.value,
        run,
        status: run.conclusion === "success" ? "awaiting-review" : "verification-failed",
        events: [...record.value.events,
                 { at: now(), status: "reconciled", note: `Verification ${run.conclusion}` }],
      }, `Reconcile ${item.id}`, record.sha);
      continue;
    }
    still.push(item);
  }
  if (still.length !== open.length) {
    await writeState(env, "index/inflight.json", { open: still },
                     "Reconcile admissions", inflight.sha);
  }
  return { released: open.length - still.length, open: still.length };
}

/**
 * Discard intake records nobody came back for.
 *
 * A pending record is written before the submitter is sent to GitHub. Most are
 * consumed seconds later; the ones from an abandoned sign-in are never
 * consumed at all, and without this they accumulate for the life of the
 * registry. They hold what somebody typed, so they are not kept indefinitely
 * for no reason.
 */
export async function sweepPending(env, now = Date.now()) {
  let removed = 0;
  for (const item of await listState(env, "pending")) {
    if (item.type !== "file" || !item.name.endsWith(".json")) continue;
    const record = await readState(env, `pending/${item.name}`);
    const created = Date.parse(record.value?.created_at ?? "");
    // An hour is far longer than a sign-in takes and short enough that an
    // abandoned one does not linger.
    if (Number.isFinite(created) && now - created < 3600_000) continue;
    if (await deleteState(env, `pending/${item.name}`, item.sha, "Discard an abandoned intake")) {
      removed += 1;
    }
  }
  return removed;
}

export default {
  async scheduled(event, env) {
    await reconcile(env);
    await sweepPending(env);
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/") {
        return html(intakeForm(env));
      }
      if (request.method === "POST" && url.pathname === "/submit") {
        return await beginSubmission(request, env);
      }
      if (request.method === "GET" && url.pathname === "/oauth/callback") {
        return await completeSubmission(request, env);
      }
      if (request.method === "GET" && url.pathname === "/s") {
        // The token is in the fragment, which browsers never send. The page
        // posts it once to /session and thereafter holds only a cookie.
        return html(statusPage(env));
      }
      if (request.method === "POST" && url.pathname === "/session") {
        const token = (await request.formData()).get("token");
        const entry = await loadByToken(env, String(token ?? ""));
        if (!entry) return json({ error: "not found" }, 404);
        return json({ ok: true }, 200, sessionCookie(String(token)));
      }
      if (request.method === "POST" && url.pathname === "/withdraw") {
        const entry = await loadByToken(env, sessionToken(request));
        if (!entry) return json({ error: "not found" }, 404);
        if (TERMINAL.has(entry.record.status)) {
          return json({ error: `already ${entry.record.status}` }, 409);
        }
        const next = {
          ...entry.record,
          status: "withdrawn",
          events: [...entry.record.events,
                   { at: now(), status: "withdrawn", note: "Withdrawn by the submitter" }],
        };
        await writeState(env, statePath(next.id, "state.json"), next,
                         `Withdraw ${next.id}`, entry.sha);
        await release(env, next.id);
        return json({ ok: true });
      }
      if (request.method === "GET" && url.pathname === "/api/review") {
        // The review goes to whoever holds the access token, and to nobody
        // else. It is never rendered into a public page or a public repository.
        const entry = await loadByToken(env, sessionToken(request));
        if (!entry) return json({ error: "not found" }, 404);
        const review = await readState(env, statePath(entry.record.id, "review.json"));
        if (!review.value) return json({ error: "no review yet" }, 404);
        return json(review.value);
      }
      if (request.method === "POST" && url.pathname === "/publish") {
        const entry = await loadByToken(env, sessionToken(request));
        if (!entry) return json({ error: "not found" }, 404);
        if (TERMINAL.has(entry.record.status)) {
          return json({ error: `already ${entry.record.status}` }, 409);
        }
        // Consent is only meaningful once the submitter can see what they
        // would be publishing.
        if (entry.record.status !== "review-ready") {
          return json({ error: "there is no review to publish yet" }, 409);
        }
        // Consent is to the review the submitter has in front of them. The
        // reviewer refuses to publish anything whose digest differs, so a
        // revised review requires fresh consent rather than inheriting this.
        const reviewed = entry.record.review_sha256;
        if (!reviewed) return json({ error: "there is no review to publish yet" }, 409);
        if (entry.record.publish_consent === true) return json({ ok: true });
        const next = {
          ...entry.record,
          publish_consent: true,
          publish_consent_review_sha256: reviewed,
          publish_consent_at: now(),
          events: [...entry.record.events,
                   { at: now(), status: entry.record.status,
                     note: "The submitter asked for this result to be published" }],
        };
        await writeState(env, statePath(next.id, "state.json"), next,
                         `Publication consent for ${next.id}`, entry.sha);
        return json({ ok: true });
      }
      if (request.method === "GET" && url.pathname === "/api/submission") {
        const entry = await loadByToken(env, sessionToken(request));
        if (!entry) return json({ error: "not found" }, 404);
        const record = await refresh(env, entry);
        return json({
          id: record.id,
          status: record.status,
          repository: record.repository,
          commit: record.commit,
          created_at: record.created_at,
          run: record.run ?? null,
          publish_consent: record.publish_consent === true,
          published_url: record.published_url ?? null,
          events: record.events,
        });
      }
      if (url.pathname === "/healthz") {
        return json({ ok: true, state_repo: env.STATE_REPO });
      }
      return html(errorPage(env, "No such page", []), 404);
    } catch (error) {
      // Never show a submitter the provider's vocabulary. They cannot act on
      // "GitHub 409", and it reads as their fault when it is ours.
      console.error("unhandled", url.pathname, String(error?.stack ?? error));
      return html(
        errorPage(env, "Palomar could not complete that just now", [
          "Nothing was lost. Try again in a moment.",
        ]),
        500,
      );
    }
  },
};
