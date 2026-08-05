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
  readState,
  repository as fetchRepository,
  resolveCommit,
  writeState,
} from "./github.js";
import { page, intakeForm, statusPage, errorPage } from "./html.js";

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
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
const MAX_INFLIGHT_TOTAL = 12;
const MAX_INFLIGHT_PER_OWNER = 2;

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

  const problems = [];
  if (!repositoryName) problems.push("Repository must be a GitHub owner/name or URL.");
  if (!COMMIT_RE.test(commit)) {
    problems.push("Commit must be a full 40-character lowercase SHA. Branches and tags move.");
  }
  if (existingId && !PALOMAR_ID_RE.test(existingId)) {
    problems.push("Existing Palomar ID is malformed.");
  }
  if (problems.length) return html(errorPage(env, "That submission is not ready", problems), 400);

  const repo = await fetchRepository(env.GITHUB_TOKEN, repositoryName);
  if (!repo) {
    return html(errorPage(env, "That repository is not visible", [
      `${repositoryName} could not be read. Palomar accepts public repositories only.`,
    ]), 400);
  }
  if (repo.private) {
    return html(errorPage(env, "That repository is private", [
      "Palomar records point at source anyone can inspect, so submissions must be public.",
    ]), 400);
  }
  if (!(await resolveCommit(env.GITHUB_TOKEN, repositoryName, commit))) {
    return html(errorPage(env, "That commit is not in that repository", [
      `${commit} was not found in ${repositoryName}.`,
    ]), 400);
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
    created_at: now(),
  };
  await writeState(
    env,
    `pending/${await digest(nonce)}.json`,
    pending,
    `Begin submission for ${repositoryName}`,
  );

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

  const next = { ...record, run };
  if (run.status === "completed") {
    next.status = run.conclusion === "success" ? "awaiting-review" : "verification-failed";
    next.events = [
      ...record.events,
      { at: now(), status: next.status, note: `Verification ${run.conclusion}` },
    ];
  }
  if (next.status !== "verifying" && record.status === "verifying") {
    const inflight = await readState(env, "index/inflight.json");
    const open = Array.isArray(inflight.value?.open) ? inflight.value.open : [];
    if (open.some((item) => item.id === record.id)) {
      await writeState(
        env,
        "index/inflight.json",
        { open: open.filter((item) => item.id !== record.id) },
        `Release ${record.id}`,
        inflight.sha,
      );
    }
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

export default {
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
        // The token is in the fragment; the page reads it and calls the API.
        return html(statusPage(env));
      }
      if (request.method === "GET" && url.pathname === "/api/submission") {
        const entry = await loadByToken(env, url.searchParams.get("token"));
        if (!entry) return json({ error: "not found" }, 404);
        const record = await refresh(env, entry);
        return json({
          id: record.id,
          status: record.status,
          repository: record.repository,
          commit: record.commit,
          created_at: record.created_at,
          run: record.run ?? null,
          events: record.events,
        });
      }
      if (url.pathname === "/healthz") {
        return json({ ok: true, state_repo: env.STATE_REPO });
      }
      return html(errorPage(env, "No such page", []), 404);
    } catch (error) {
      return html(
        errorPage(env, "Something went wrong", [String(error?.message ?? error).slice(0, 300)]),
        500,
      );
    }
  },
};
