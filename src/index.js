import {
  digest,
  newAccessToken,
  newSubmissionId,
  newRecord,
  normalizeCommit,
  normalizePalomarId,
  normalizeRepository,
  statePath,
  tokenDigest,
} from "./submission.js";
import {
  dispatchVerification,
  findVerificationRun,
  challengeGist,
  challengeTag,
  deleteState,
  dispatchReviewer,
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
    "connect-src 'self' https://api.github.com https://data.palomar-registry.org; " +
    // form-action governs the whole redirect chain, not just the first hop.
    // Submitting posts to this origin and is answered with a redirect to
    // GitHub for sign-in, so leaving GitHub out blocks every submission that
    // gets far enough to be redirected, and blames the original URL for it.
    "base-uri 'none'; form-action 'self' https://github.com; frame-ancestors 'none'",
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

function json(value, status = 200, extra = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...SECURITY_HEADERS,
      ...extra,
    },
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
const MAX_INFLIGHT_PER_SUBMITTER = 2;
const MAX_VERIFY_ATTEMPTS = 10;
const CURRENT_REVIEW_SCHEMA_VERSION = 2;
const REVIEW_DECISIONS = new Set(["accept", "revise", "reject"]);

const TERMINAL = new Set(["registered", "withdrawn", "verification-failed"]);

function isCurrentReview(review, submissionId) {
  return review !== null && typeof review === "object" && !Array.isArray(review) &&
    review.schema_version === CURRENT_REVIEW_SCHEMA_VERSION &&
    review.submission_id === submissionId && REVIEW_DECISIONS.has(review.decision);
}

function submitterReview(review) {
  return {
    passed: review.decision === "accept",
    summary: review.summary,
    comments: review.warnings ?? [],
    requested_changes: review.requested_changes ?? [],
    reviewed_at: review.reviewed_at,
    reviewer_models: review.reviewer_models ?? [],
  };
}

function obsoleteReview() {
  return json({ error: "the review uses an obsolete or invalid contract and must be rerun" }, 409);
}

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
async function beginSubmission(request, env, { machine = false } = {}) {
  // A browser sends a form; an agent sends JSON. Both are read through one
  // `get`, so every check below sees the same values whichever arrived.
  const form = machine
    ? new Map(Object.entries(await request.json().catch(() => ({}))))
    : await request.formData();
  const repositoryName = normalizeRepository(form.get("repository"));
  const commit = normalizeCommit(form.get("commit"));
  const rawExistingId = String(form.get("existing_id") ?? "").trim();
  const existingId = normalizePalomarId(rawExistingId);
  const context = String(form.get("context") ?? "").trim().slice(0, 4000);
  const relationship = String(form.get("authorization_relationship") ?? "").trim();
  const evidence = String(form.get("authorization_evidence") ?? "").trim().slice(0, 4000);

  // A repository-relative path, as `{path}` or `{invalid: true}`.
  //
  // The rules are the verifier's, character for character. Anywhere the two
  // disagree the submitter loses: a path this accepts and the verifier refuses
  // costs a dispatched run that was always going to fail, and one this refuses
  // and the verifier would have accepted is a submission turned away for no
  // reason. A tagged result rather than a sentinel string, so a directory
  // genuinely called `invalid` is a path and not an error.
  const path = (name) => {
    const raw = String(form.get(name) ?? "").trim();
    if (!raw) return { path: null };
    // Nothing here is rewritten. A trailing slash and a leading slash are both
    // refused rather than trimmed: quietly turning what somebody typed into a
    // different path is worse than telling them.
    const segments = raw.split("/");
    const bad =
      raw.startsWith("/") ||
      raw.length > 400 ||
      segments.some((part) => !part || part === "." || part === "..") ||
      /[\\?#]/.test(raw) ||
      segments[0].includes(":") ||
      // eslint-disable-next-line no-control-regex
      /[\x00-\x1f\x7f]/.test(raw);
    return bad ? { invalid: true } : { path: raw };
  };
  const projectPath = path("project_path");
  const configPath = path("comparator_config_path");
  const metadataPath = path("formalization_metadata_path");

  const values = {
    repository: String(form.get("repository") ?? ""),
    commit: String(form.get("commit") ?? ""),
    existing_id: rawExistingId,
    context,
    authorization_relationship: relationship,
    authorization_evidence: evidence,
    project_path: String(form.get("project_path") ?? ""),
    comparator_config_path: String(form.get("comparator_config_path") ?? ""),
    formalization_metadata_path: String(form.get("formalization_metadata_path") ?? ""),
  };
  // A browser gets its form back with everything still in it; an agent gets
  // the same problems as a list it can act on.
  const rejected = (...problems) =>
    machine
      ? json({ error: "that submission was refused", problems }, 400)
      : html(intakeForm(env, values, problems), 400);

  const problems = [];
  if (!repositoryName) problems.push("Repository must be a GitHub owner/name or URL.");
  if (!commit) {
    problems.push("Commit must be a full 40-character SHA. Branches and tags move.");
  }
  if (rawExistingId && !existingId) {
    problems.push("Existing Palomar ID is malformed.");
  }
  if (!RELATIONSHIPS.has(relationship)) {
    problems.push("Say whether you maintain this formalization or have approval to submit it.");
  }
  if (!configPath.path) {
    problems.push(
      "Comparator configuration is required. Give the repository-relative path to the one configuration this entry records.",
    );
  }
  for (const [name, value] of [
    ["Project directory", projectPath],
    ["Comparator configuration", configPath],
    ["Formalization metadata", metadataPath],
  ]) {
    if (value.invalid) {
      problems.push(`${name} must be a path inside the repository, written with forward slashes.`);
    }
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
  // Two independent secrets, and they must stay independent. `nonce` locates
  // the pending record and never leaves Palomar; `challenge` is written into a
  // tag name and a gist by the agent path, so it is public by construction.
  // Deriving one from the other would mean anyone who read the public tag
  // could compute the private lookup key and take the access token with it —
  // which reads the review, consents to registration, and withdraws.
  const nonce = newAccessToken();
  const challenge = newAccessToken();
  const pending = {
    schema_version: 2,
    method: machine ? "tag-and-gist" : "oauth",
    challenge,
    repository_id: repo.id ?? null,
    attempts: 0,
    repository: repositoryName,
    commit,
    existing_id: existingId || null,
    context: context || null,
    requested_paths: {
      project_path: projectPath.path,
      comparator_config_path: configPath.path,
      formalization_metadata_path: metadataPath.path,
    },
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

  if (machine) {
    return json({
      pending_secret: nonce,
      challenge,
      repository: repositoryName,
      commit,
      instructions: [
        `Create a tag at the commit you are submitting. Creating a ref needs the`,
        `same write access the browser sign-in checks for, which is why it is here:`,
        `  gh api -X POST repos/${repositoryName}/git/refs \\`,
        `    -f ref=refs/tags/${challenge} -f sha=${commit}`,
        `Then a secret gist carrying the same challenge, which is what tells`,
        `Palomar who you are, since a ref records no author:`,
        `  echo '{"public":false,"files":{"palomar.txt":{"content":"${challenge}"}}}' \\`,
        `    | gh api -X POST gists --input -`,
        `Then POST /api/verify with {"pending_secret": "...", "gist_id": "..."},`,
        `and delete both once it answers.`,
      ].join("\n"),
    });
  }

  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", env.OAUTH_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", `${new URL(request.url).origin}/oauth/callback`);
  authorize.searchParams.set("scope", "read:user");
  authorize.searchParams.set("state", nonce);
  return Response.redirect(authorize.toString(), 303);
}

/**
 * How long this submitter must wait before starting another submission.
 *
 * Starting is the expensive act: it dispatches a verification run that takes
 * a quarter of an hour of somebody's runners, whether or not anything comes of
 * it. So the interval doubles every time one is started, and only a completed
 * registration puts it back to a minute. A submission that fails verification,
 * or is withdrawn, leaves it where it is: those are exactly the loops worth
 * slowing down.
 *
 * There is no ceiling, which is deliberate and worth understanding before
 * changing it. Twenty starts with nothing registered is already years. Nobody
 * submitting in good faith reaches that, and an operator can clear one file to
 * release someone who does. The failure mode is a person locked out with no way
 * back on their own, so the file says who and when.
 *
 * Filed under a peppered digest rather than a login, so reading the state
 * repository does not enumerate everyone who has ever submitted — the same
 * reason `index/tokens/` is shaped that way.
 */
const RATE_FLOOR_SECONDS = 60;

async function ratePath(env, principalId) {
  return `index/rate/${await digest(`${env.TOKEN_PEPPER ?? ""}:${principalId}`)}.json`;
}

async function rateLimit(env, principal) {
  if (!principal?.id) return { refused: false, record: null, path: null };
  const path = await ratePath(env, principal.id);
  const current = await readState(env, path);
  const interval = Number(current.value?.interval_seconds ?? RATE_FLOOR_SECONDS);
  const nextAllowed = Date.parse(current.value?.next_allowed_at ?? 0) || 0;
  const wait = Math.ceil((nextAllowed - Date.now()) / 1000);
  if (wait > 0) {
    return {
      refused: true, status: 429, wait,
      title: "You have started a submission too recently",
      detail: [
        `Palomar asks for ${describeInterval(interval)} between submissions from one`,
        `person, and doubles it each time one is started without a registration.`,
        `Try again in ${describeInterval(wait)}.`,
      ],
    };
  }
  return { refused: false, path, sha: current.sha, interval, starts: Number(current.value?.starts ?? 0) };
}

function describeInterval(seconds) {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
}

/**
 * Decide whether one more submission may be admitted, reading the list fresh.
 *
 * The caps exist because verification is expensive and long-running, and
 * anyone who can prove push access to any public repository reaches this
 * point — including on a repository they made a minute ago.
 *
 * The two caps count different things and both are wanted. The repository cap
 * stops one project's repositories monopolising the runners; the submitter cap
 * stops one person doing it across many repositories, which the repository cap
 * alone never noticed, because a fresh organisation buys fresh slots.
 */
async function admit(env, { owner, submitter }) {
  const inflight = await readState(env, "index/inflight.json");
  const open = Array.isArray(inflight.value?.open) ? inflight.value.open : [];
  if (open.length >= MAX_INFLIGHT_TOTAL) {
    return {
      refused: true, status: 503, title: "Palomar is at capacity",
      detail: ["Too many submissions are being verified right now. Please try again later."],
    };
  }
  if (owner && open.filter((item) => item.owner === owner).length >= MAX_INFLIGHT_PER_OWNER) {
    return {
      refused: true, status: 429, title: "That repository already has submissions in flight",
      detail: [
        `Palomar verifies at most ${MAX_INFLIGHT_PER_OWNER} submissions at a time from one owner.`,
        "Wait for those to finish before submitting another.",
      ],
    };
  }
  // `item.submitter ?? item.owner` so entries written before this shipped are
  // still counted as something rather than silently as nobody.
  const mine = open.filter((item) => (item.submitter ?? item.owner) === submitter).length;
  if (mine >= MAX_INFLIGHT_PER_SUBMITTER) {
    return {
      refused: true, status: 429, title: "You already have submissions in flight",
      detail: [
        `Palomar verifies at most ${MAX_INFLIGHT_PER_SUBMITTER} submissions at a time from one submitter.`,
        "Wait for those to finish before submitting another.",
      ],
    };
  }
  return { refused: false, inflight, open };
}

/**
 * Everything after the proof, shared so the two intakes cannot drift apart.
 *
 * A browser sign-in and an agent's tag prove the same thing by different
 * means. What follows must not depend on which: the same admission, the same
 * record, the same indexes, the same dispatch. Two copies of this would be two
 * definitions of what a submission is.
 */
async function admitSubmission(env, { pending, owner, submitter, proof }) {
  const limit = await rateLimit(env, proof?.principal);
  if (limit.refused) return limit;
  const admission = await admit(env, { owner, submitter });
  if (admission.refused) return admission;
  const { inflight, open } = admission;

  const id = newSubmissionId();
  const token = newAccessToken();
  const record = {
    ...newRecord({
      id,
      repositoryName: pending.repository,
      commit: pending.commit,
      owner,
      submitter,
      existingId: pending.existing_id,
      context: pending.context,
      requestedPaths: pending.requested_paths ?? {},
      authorization: {
        relationship: pending.authorization_relationship,
        ...(pending.authorization_evidence
          ? { evidence: pending.authorization_evidence }
          : {}),
      },
    }),
    push_proof: proof,
    created_at: now(),
    token_sha256: await tokenDigest(env, token),
    events: [{ at: now(), status: "verifying", note: "Mechanical verification dispatched" }],
  };
  await writeState(env, statePath(id, "state.json"), record, `Open submission ${id}`);
  await writeState(
    env,
    "index/inflight.json",
    { open: [...open, { id, owner, submitter, at: record.created_at }] },
    `Admit ${id}`,
    inflight.sha,
  );
  await writeState(
    env,
    `index/tokens/${record.token_sha256}.json`,
    { id },
    `Index submission ${id}`,
  );
  if (limit.path) {
    const interval = limit.starts === 0 ? RATE_FLOOR_SECONDS : limit.interval * 2;
    await writeState(env, limit.path, {
      schema_version: 1,
      login: proof.principal.login,
      starts: limit.starts + 1,
      interval_seconds: interval,
      last_start_at: record.created_at,
      next_allowed_at: new Date(Date.now() + interval * 1000).toISOString()
        .replace(/\.\d+Z$/, "Z"),
    }, `Record a submission start`, limit.sha).catch(() => {});
  }
  await dispatchVerification(env, {
    repositoryName: record.repository,
    commit: record.commit,
    requestId: id,
    options: {
      authorization_relationship: RELATIONSHIP_LABELS[record.authorization.relationship],
      ...Object.fromEntries(
        Object.entries(record.requested_paths ?? {}).filter(([, value]) => value),
      ),
      ...(record.authorization.evidence
        ? { authorization_evidence: record.authorization.evidence }
        : {}),
      ...(record.existing_id ? { existing_id: record.existing_id } : {}),
      ...(record.context ? { context: record.context } : {}),
    },
  });
  return { refused: false, id, token };
}

/**
 * The agent path's proof: a tag that needed write access, and a gist that says
 * who wrote it.
 *
 * Neither half is sufficient. A ref proves `contents: write` — the capability
 * the browser path reads as `permissions.push` — but records no author. A gist
 * names a verified account but says nothing about the repository. Together they
 * establish that someone who can write to this repository submitted it, and
 * that an account claimed it; not, as OAuth does, that those are one account.
 * The record says which of the two it is, and the reviewer refuses a record
 * that claims otherwise.
 */
async function verifySubmission(request, env) {
  const body = await request.json().catch(() => ({}));
  const secret = String(body.pending_secret ?? "");
  if (!/^[0-9a-f]{64}$/.test(secret)) return json({ error: "no pending_secret" }, 400);

  const pendingPath = `pending/${await digest(secret)}.json`;
  const pending = await readState(env, pendingPath);
  if (!pending.value) return json({ error: "that submission has already been verified" }, 404);
  if (pending.value.method !== "tag-and-gist") {
    return json({ error: "that intake is a browser sign-in, not an agent submission" }, 409);
  }

  // Bounded, so /api/verify cannot be used to make Palomar's token hammer a
  // repository the caller names.
  const attempts = Number(pending.value.attempts ?? 0) + 1;
  if (attempts > MAX_VERIFY_ATTEMPTS) {
    await deleteState(env, pendingPath, pending.sha, "Discard an intake that could not be proved");
    return json({ error: "too many attempts; start again" }, 429);
  }

  const { repository, commit, challenge } = pending.value;
  const tag = await challengeTag(env.SUBMISSION_TOKEN, repository, challenge, commit);
  const gist = tag.ok
    ? await challengeGist(env.SUBMISSION_TOKEN, body.gist_id, challenge)
    : { ok: false };
  if (!tag.ok || !gist.ok) {
    await writeState(
      env, pendingPath, { ...pending.value, attempts }, "Record a failed proof", pending.sha,
    ).catch(() => {});
    return json({
      error: "that proof was refused",
      tag: tag.ok ? "accepted" : tag.reason,
      gist: gist.ok ? "accepted" : (gist.reason ?? "not checked: the tag was refused"),
      attempts_remaining: MAX_VERIFY_ATTEMPTS - attempts,
    }, 403);
  }

  // The repository must be the one the challenge was issued for. GitHub follows
  // renames and transfers silently, so the name alone would not notice.
  const repo = await fetchRepository(env.GITHUB_TOKEN, repository);
  if (pending.value.repository_id && repo?.id !== pending.value.repository_id) {
    return json({ error: "that repository is not the one this submission began for" }, 409);
  }

  // Consumed only once the proof holds, and its failure is fatal: this is the
  // only thing between one challenge and two submissions.
  if (!(await deleteState(env, pendingPath, pending.sha, "Consume pending intake"))) {
    return json({ error: "that submission could not be claimed; try again" }, 409);
  }

  const admitted = await admitSubmission(env, {
    pending: pending.value,
    owner: repo?.owner?.login ?? null,
    submitter: gist.principal.login,
    proof: {
      schema_version: 1,
      method: "tag-and-gist",
      binding: "separately-attested",
      verified_at: now(),
      repository_id: pending.value.repository_id,
      commit,
      challenge_sha256: await digest(challenge),
      principal: gist.principal,
    },
  });
  if (admitted.refused) {
    return json({ error: admitted.title, detail: admitted.detail }, admitted.status);
  }
  return json({
    submission_id: admitted.id,
    access_token: admitted.token,
    status_url: `${new URL(request.url).origin}/s#${admitted.token}`,
    next: [
      `Delete both artifacts now:`,
      `  gh api -X DELETE repos/${repository}/git/refs/tags/${challenge}`,
      `  gh api -X DELETE gists/${body.gist_id}`,
      `Then POST /session with token=<access_token> and follow the status.`,
    ].join("\n"),
  });
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
    // Deliberately before the pending record is consumed. Consuming first
    // meant a refused submitter lost everything they had typed, undoing the
    // care `beginSubmission` takes to hand it back to them.
    return html(errorPage(env, "You cannot push to that repository", [
      `Palomar asks submitters to prove write access to ${pending.value.repository}.`,
      "If you are submitting someone else's formalization, ask a maintainer to submit it.",
    ]), 403);
  }

  // Consume the nonce once the proof has passed, and only then. A replayed
  // callback must not produce a second submission, and the delete is the only
  // thing standing between one nonce and two records, so its failure is fatal
  // rather than advisory. It used to be issued and ignored; that was survivable
  // only because an OAuth code is itself single-use, which is not a property
  // any other intake path has.
  if (!(await deleteState(env, pendingPath, pending.sha, "Consume pending intake"))) {
    return html(errorPage(env, "That sign-in could not be completed", [
      "Palomar could not record that this sign-in was used, and will not risk",
      "admitting it twice. Start again from the submission form.",
    ]), 409);
  }

  const submitter = user?.login;
  if (!submitter) {
    // Every quota keys on this. Without it the old code bucketed submissions
    // under the empty string, where they throttled each other.
    return html(errorPage(env, "GitHub did not say who you are", [
      "Palomar could not read your GitHub login, and admits nothing it cannot",
      "attribute. Please try again.",
    ]), 502);
  }

  // Anyone who can prove push access to any public repository can reach this
  // point, including on a repository they created a minute ago. Verification
  // is expensive and long-running, so admission is capped until real quotas
  // exist. This is deliberately blunt: refusing a genuine submitter with a
  // clear message is recoverable, exhausting the runners is not.
  const owner = viewer.owner?.login ?? null;
  const admitted = await admitSubmission(env, {
    pending: pending.value,
    owner,
    submitter,
    proof: {
      schema_version: 1,
      method: "oauth",
      binding: "same-account",
      verified_at: now(),
      repository_id: viewer.id ?? null,
      commit: pending.value.commit,
      principal: { login: submitter, id: user?.id ?? null },
    },
  });
  if (admitted.refused) {
    return html(errorPage(env, admitted.title, admitted.detail), admitted.status);
  }
  const { token } = admitted;
  return Response.redirect(`${new URL(request.url).origin}/s#${token}`, 303);
}

async function loadByToken(env, token) {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const pointer = await readState(env, `index/tokens/${await tokenDigest(env, token)}.json`);
  if (!pointer.value?.id) return null;
  const record = await readState(env, statePath(pointer.value.id, "state.json"));
  return record.value ? { record: record.value, sha: record.sha } : null;
}

/**
 * How long an automated review has been taking lately, in seconds.
 *
 * Recorded by the reviewer as each review finishes. Absent until one has, so
 * the page says nothing about duration rather than inventing a figure.
 */
async function typicalReviewSeconds(env) {
  const timing = await readState(env, "index/review-timing.json");
  const seconds = timing.value?.seconds;
  if (!Array.isArray(seconds) || !seconds.length) return null;
  const sorted = [...seconds].filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return Math.round(sorted[Math.floor(sorted.length / 2)]);
}

/** Refresh a verifying submission from the run it dispatched. */
async function refresh(env, entry) {
  const record = entry.record;
  // A completed registration is the one thing that puts a submitter's interval
  // back to a minute, and the reviewer performs registration, not this server.
  // This is where the server sees it: the status page and an agent both poll
  // until the status settles, and `registered` is settled, so the good news and
  // the reset arrive on the same request. Somebody who closes the tab between
  // consenting and that poll waits longer once; opening the link again fixes it.
  // The alternative, letting the reviewer reset it, would need TOKEN_PEPPER in
  // reviewer CI, and that pepper exists so a leaked state repository yields no
  // live links.
  if (record.status === "registered" && !record.rate_reset_at && record.push_proof?.principal?.id) {
    const path = await ratePath(env, record.push_proof.principal.id);
    const current = await readState(env, path);
    await writeState(env, path, {
      ...(current.value ?? { schema_version: 1 }),
      interval_seconds: RATE_FLOOR_SECONDS,
      next_allowed_at: now(),
    }, "Reset after a registration", current.sha).catch(() => {});
    const reset = { ...record, rate_reset_at: now() };
    await writeState(env, statePath(record.id, "state.json"), reset,
                     `Reset the interval for ${record.id}`, entry.sha).catch(() => {});
    return reset;
  }
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
  if (next.status === "awaiting-review") {
    // Failing to ask only costs the schedule's latency, so it is not fatal.
    await dispatchReviewer(env).catch(() => false);
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
      const settled =
        run.conclusion === "success" ? "awaiting-review" : "verification-failed";
      await writeState(env, statePath(item.id, "state.json"), {
        ...record.value,
        run,
        status: settled,
        events: [...record.value.events,
                 { at: now(), status: settled, note: `Verification ${run.conclusion}` }],
      }, `Reconcile ${item.id}`, record.sha);
      if (settled === "awaiting-review") await dispatchReviewer(env).catch(() => false);
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
      if (request.method === "POST" && url.pathname === "/api/submit") {
        return await beginSubmission(request, env, { machine: true });
      }
      if (request.method === "POST" && url.pathname === "/api/verify") {
        return await verifySubmission(request, env);
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
        // The submitter sees the outcome and useful prose, but not the internal
        // three-way decision, scores, pass records, or finding severities.
        const entry = await loadByToken(env, sessionToken(request));
        if (!entry) return json({ error: "not found" }, 404);
        const review = await readState(env, statePath(entry.record.id, "review.json"));
        if (!review.value) return json({ error: "no review yet" }, 404);
        if (!isCurrentReview(review.value, entry.record.id)) return obsoleteReview();
        return json(submitterReview(review.value));
      }
      if (request.method === "POST" && url.pathname === "/register") {
        const entry = await loadByToken(env, sessionToken(request));
        if (!entry) return json({ error: "not found" }, 404);
        if (TERMINAL.has(entry.record.status)) {
          return json({ error: `already ${entry.record.status}` }, 409);
        }
        // Consent is only meaningful once the submitter can see what they
        // would be registering.
        if (entry.record.status !== "review-ready") {
          return json({ error: "there is no review to register yet" }, 409);
        }
        const review = await readState(env, statePath(entry.record.id, "review.json"));
        if (!isCurrentReview(review.value, entry.record.id)) return obsoleteReview();
        if (review.value.decision !== "accept") {
          return json({ error: "only an accepted review can be registered" }, 409);
        }
        // Consent is to the review the submitter has in front of them. The
        // reviewer refuses to register anything whose digest differs, so a
        // revised review requires fresh consent rather than inheriting this.
        const reviewed = entry.record.review_sha256;
        if (!reviewed) return json({ error: "there is no review to register yet" }, 409);
        if (entry.record.registration_consent === true) return json({ ok: true });
        const next = {
          ...entry.record,
          registration_consent: true,
          registration_consent_review_sha256: reviewed,
          registration_consent_at: now(),
          events: [...entry.record.events,
                   { at: now(), status: entry.record.status,
                     note: "The submitter asked for this result to be registered" }],
        };
        await writeState(env, statePath(next.id, "state.json"), next,
                         `Registration consent for ${next.id}`, entry.sha);
        // The submitter has just decided; do not make them wait on a cron.
        await dispatchReviewer(env).catch(() => false);
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
          // Shown so a submitter can see what was actually asked for. The
          // layout fields are partly filled in by a script reading the
          // repository, and something filled in for you is worth confirming.
          requested_paths: Object.fromEntries(
            Object.entries(record.requested_paths ?? {}).filter(([, value]) => value),
          ),
          created_at: record.created_at,
          run: record.run ?? null,
          review_started_at: record.review_started_at ?? null,
          typical_review_seconds: await typicalReviewSeconds(env),
          registration_consent: record.registration_consent === true,
          registered_url: record.registered_url ?? null,
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
