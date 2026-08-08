import {
  digest,
  newAccessToken,
  newSubmissionId,
  newRecord,
  pepper,
  statePath,
  tokenDigest,
} from "./submission.js";
import {
  dispatchVerification,
  findVerificationRun,
  CHALLENGE_TAG_PREFIX,
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
import {
  admissionDecision,
  nextRateRecord,
  RateContractError,
  rateDecision,
  rateRecord,
  resetRateRecord,
} from "./admission-contract.js";
import { authorizationRelationshipLabel, validateIntake } from "./intake-contract.js";
import {
  INFLIGHT_INDEX_PATH,
  inflightOpen,
  isCurrentReview,
  OPEN_INDEX_PATH,
  reviewerOpen,
  StateContractError,
  submitterReview,
} from "./state-contract.js";
// One vocabulary for "this submission has stopped moving", shared with the
// status page, which asks a slightly different question of the same words.
import { CLOSED } from "../public/statuses.js";

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

const MAX_VERIFY_ATTEMPTS = 10;
// How old a `verifying` submission must be before a run nobody can find is
// treated as lost. Generous by three orders of magnitude: a dispatched run is
// listed within seconds, and this only ever applies to one that cannot be found
// at all.
const LOST_RUN_MS = 3600_000;

// Without any one of these the server cannot do the thing it claims to do, and
// two of them fail silently rather than loudly if they are missing: TOKEN_PEPPER
// would have degraded every peppered digest to an unsalted one, and the OAuth
// pair would have sent submitters to GitHub to be refused there instead of here.
const REQUIRED_SECRETS = [
  "TOKEN_PEPPER",
  "GITHUB_TOKEN",
  "SUBMISSION_TOKEN",
  "OAUTH_CLIENT_ID",
  "OAUTH_CLIENT_SECRET",
];

async function readContractIndex(env, path, validate) {
  let index;
  try {
    index = await readState(env, path);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new StateContractError(`${path} must contain valid JSON`);
  }
  return { ...index, open: validate(index.value) };
}

function readInflightIndex(env) {
  return readContractIndex(env, INFLIGHT_INDEX_PATH, inflightOpen);
}

function readReviewerIndex(env) {
  return readContractIndex(env, OPEN_INDEX_PATH, reviewerOpen);
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

/**
 * The same credential, presented rather than carried.
 *
 * A cookie is ambient: the browser attaches it to whatever it is talked into
 * sending, which is what makes cross-site request forgery a thing at all. This
 * is not, because `Authorization` is not a CORS-safelisted header: a page on
 * another origin cannot attach it without a preflight this server never grants,
 * and a form, an image, or a navigation cannot set a header at all. That is a
 * statement about other origins, not a claim that the token is safe from
 * anything already holding it. So an agent presenting the token is exempt from
 * the same-origin requirement below, and a browser carrying the cookie is not.
 */
function bearerToken(request) {
  const match = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get("authorization") ?? "");
  return match ? match[1] : null;
}

/**
 * Whether a request carrying the session cookie was made by this site.
 *
 * `SameSite=Strict` is scoped to the registrable domain, not to the origin, so
 * `data.palomar-registry.org` is same-site with this host and a document
 * executing there has the cookie attached to whatever it sends here. That
 * origin serves render bundles built from submitted Lean source, which is the
 * one place in Palomar that runs something a submitter wrote. The render CSP
 * blocks the outbound request today, which means the render CSP is currently
 * part of this server's defence against forgery. That is not how the layering
 * is meant to read, and the documentation is emphatic that no layer should be
 * removed because another one happens to cover it.
 *
 * `Sec-Fetch-Site` answers the question directly and needs no allowlist to
 * maintain. `Origin` is the fallback for anything that does not send it. A
 * request that sends neither is not a browser, and gets told to present the
 * token as a header instead, where no ambient credential is involved.
 */
function madeByThisSite(request) {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = request.headers.get("origin");
  // `null` is what a sandboxed or redirected context sends, and it is exactly
  // the case that must not be read as "no origin, so no problem".
  if (origin === null) return false;
  return origin === new URL(request.url).origin;
}

function now() {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

/** Ours to fix, not the submitter's, and never phrased as though it were. */
function intakeUnavailable(env, machine) {
  return machine
    ? json({ error: "submission intake is temporarily unavailable" }, 503)
    : html(
        errorPage(env, "Submission intake is temporarily unavailable", [
          "This is ours to fix, not yours. Please try again in a moment.",
        ]),
        503,
      );
}

const CONSUMED_PROOF_RESTART =
  "This proof was consumed. Start a new submission and create a new proof.";

function consumedProofResponse(body, status) {
  return json({
    ...body,
    proof_consumed: true,
    restart: CONSUMED_PROOF_RESTART,
  }, status);
}

function spentSignInProblems(problems = []) {
  return [
    ...problems,
    "That GitHub sign-in was spent. Start a new submission from the submission form.",
  ];
}

function reportStateContract(error) {
  console.error("state-contract", error.message);
}

function isDurableContractError(error) {
  return error instanceof StateContractError || error instanceof RateContractError;
}

function reportDurableContract(error) {
  console.error(error instanceof RateContractError ? "rate-contract" : "state-contract", error.message);
}

// Pending intake that may exist at once, across everybody. This limits ordinary
// growth rather than bounding it: the count is read and the record is written
// separately, so intakes arriving together can overshoot it. What it is really
// for is the cliff behind it. `listState` refuses to enumerate a directory at
// the contents API's thousand-name limit, so a `pending/` allowed to reach that
// takes `sweepPending` down with it, and a flood the sweep cannot clear stops
// being something an hour undoes.
const MAX_PENDING = 200;

/**
 * The cheapest possible refusal, before an intake has cost anything.
 *
 * `rateLimit` runs inside `admitSubmission`, which is after the proof. That is
 * the right place to slow a submitter who keeps starting and never finishing,
 * and the wrong place to stop somebody who never intended to prove anything:
 * by the time an intake reaches the proof it has already spent a read on the
 * repository, a read on the commit, and a commit to the state repository, all
 * on tokens the whole pipeline shares. GitHub's secondary limit is a few
 * hundred content writes an hour, so a short loop against an unauthenticated
 * endpoint could stop Palomar recording anything at all.
 *
 * So this runs first and touches nothing: no state, no network, no token.
 *
 * Keyed on the connecting address, which is free to rotate, and counted per
 * data centre rather than globally. Neither of those makes it an authorisation
 * boundary and nothing here treats it as one, and neither makes exhaustion
 * impossible: enough addresses still get through, each still spending the read
 * that the ceiling above costs. What it does is make the rate from any one
 * address small enough that a flood takes effort rather than a for-loop.
 */
async function intakeThrottle(env, request, { machine = false } = {}) {
  // `wrangler.jsonc` declares this, so its absence is configuration drift and
  // not a dependency having a bad moment. Refusing is the point: the moment the
  // cheapest protection has gone missing is the wrong moment to start doing
  // without it, and a limiter that quietly is not there reads exactly like one
  // that is.
  if (!env.INTAKE_LIMITER) {
    console.error("configuration", "missing: INTAKE_LIMITER");
    return intakeUnavailable(env, machine);
  }
  const key = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await env.INTAKE_LIMITER.limit({ key });
  if (success) return null;
  return machine
    ? json({ error: "too many submissions were started from this address; slow down" }, 429)
    : html(
        errorPage(env, "Too many submissions were started from here", [
          "Please wait a minute and try again.",
        ]),
        429,
      );
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
  //
  // Neither read is allowed to throw. `formData()` throws on a body it cannot
  // parse, and a JSON body posted to /submit did exactly that: the throw
  // reached the handler's catch, and whoever sent it was told on a 500 that
  // Palomar had had a bad moment and to try again shortly. Both halves of that
  // were false. Nothing was wrong at this end, and trying again sends the same
  // body and fails the same way, so the one thing the sender needed to know
  // was the one thing the page did not say. 400 says it, and says it in JSON
  // even though this endpoint's other answers are pages: a browser form post
  // always carries something `formData()` reads, so whoever gets here is a
  // program, and a program can act on `error`.
  let form;
  try {
    form = machine
      ? new Map(Object.entries(await request.json().catch(() => ({}))))
      : await request.formData();
  } catch {
    return json({
      error: machine
        ? "that request body could not be read as a JSON object"
        : "that request body could not be read as a form",
    }, 400);
  }
  const { values, problems, submission } = validateIntake(form);
  // A browser gets its form back with everything still in it; an agent gets
  // the same problems as a list it can act on.
  const rejected = (...problems) =>
    machine
      ? json({ error: "that submission was refused", problems }, 400)
      : html(intakeForm(env, values, problems), 400);

  if (problems.length) return rejected(...problems);

  const {
    repository: repositoryName,
    commit,
    existing_id: existingId,
    context,
    requested_paths: requestedPaths,
    authorization_relationship: relationship,
    authorization_evidence: evidence,
  } = submission;

  // Ahead of the two reads below and ahead of the write, so an intake refused
  // here costs one call rather than three. For one that is allowed it adds a
  // call, which is the price of the cliff `MAX_PENDING` is guarding; the write
  // it goes on to protect is the expensive one, because content writes are what
  // GitHub's secondary limit counts.
  let pendingCount;
  try {
    pendingCount = (await listState(env, "pending")).length;
  } catch (error) {
    // Not the same thing as full, and saying it was would be a refusal the
    // submitter cannot act on: a read that failed says nothing at all about how
    // many submissions are in progress. The real reason goes to the log.
    console.error("pending", String(error?.stack ?? error));
    return intakeUnavailable(env, machine);
  }
  if (pendingCount >= MAX_PENDING) {
    return rejected("Palomar has too many submissions in progress. Please try again shortly.");
  }

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
  // A third secret, and only the browser path needs it. `state` travels in a
  // URL, and a URL can be handed to somebody else: anything the callback can
  // recover from `state` alone, it can recover in a browser that never saw the
  // form. So an attacker who begins an intake and passes on the authorize link
  // gets a submission attributed to whoever follows it, with their slot, their
  // interval, and the attacker's wording in the record. The pending intake is
  // therefore *found* by `state` and *unlocked* by a cookie, and the second
  // half never leaves the browser that started it.
  //
  // The agent path needs none of this: `pending_secret` is returned in a
  // response body and never travels in a URL at all.
  const binding = machine ? null : newAccessToken();
  const pending = {
    schema_version: 2,
    ...(binding ? { binding_sha256: await digest(binding) } : {}),
    method: machine ? "tag-and-gist" : "oauth",
    challenge,
    repository_id: repo.id ?? null,
    attempts: 0,
    repository: repositoryName,
    commit,
    existing_id: existingId || null,
    context,
    requested_paths: requestedPaths,
    authorization_relationship: relationship,
    authorization_evidence: evidence,
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
        `    -f ref=refs/tags/${CHALLENGE_TAG_PREFIX}${challenge} -f sha=${commit}`,
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
  // `Response.redirect` answers with immutable headers, so the redirect is
  // built by hand in order to carry the cookie.
  return new Response(null, {
    status: 303,
    headers: {
      location: authorize.toString(),
      "set-cookie": await intakeCookie(nonce, binding),
      ...SECURITY_HEADERS,
    },
  });
}

/**
 * The cookie that unlocks one pending intake, named after the intake it opens.
 *
 * Named rather than fixed, because a submitter may have two submissions in
 * flight and the form does not stop them starting a second in another tab. One
 * name would mean the second sign-in overwrote the first one's cookie, and then
 * finishing the first would look exactly like the attack this exists to catch:
 * refused, and its pending record deleted, for doing nothing wrong.
 *
 * `Lax`, not `Strict`. The callback is a top-level navigation from github.com,
 * and `Strict` would withhold the cookie on the one request that needs it. Lax
 * is enough here because the cookie confers nothing on its own: it only opens a
 * record whose name the holder must already know.
 */
async function intakeCookie(nonce, binding, { clear = false } = {}) {
  const name = `palomar_intake_${(await digest(nonce)).slice(0, 16)}`;
  const attributes = "Path=/oauth/callback; HttpOnly; Secure; SameSite=Lax";
  return clear
    ? `${name}=; ${attributes}; Max-Age=0`
    : `${name}=${binding}; ${attributes}; Max-Age=900`;
}

function intakeBinding(request, nonceDigest) {
  const name = `palomar_intake_${nonceDigest.slice(0, 16)}`;
  const match = new RegExp(`(?:^|;\\s*)${name}=([0-9a-f]{64})(?:;|$)`)
    .exec(request.headers.get("cookie") ?? "");
  return match ? match[1] : null;
}

// Filed under a peppered digest rather than a login, so reading the state
// repository does not enumerate everyone who has ever submitted — the same
// reason `index/tokens/` is shaped that way.
async function ratePath(env, principalId) {
  return `index/rate/${await digest(`${pepper(env)}:${principalId}`)}.json`;
}

async function rateLimit(env, principal) {
  if (!principal?.id) return { refused: false, record: null, path: null };
  const path = await ratePath(env, principal.id);
  const current = await readState(env, path);
  // A missing file means this principal has not started before. A present JSON
  // null (or any other malformed document) is damaged state, not the same
  // absence and not permission to fall through to the floor.
  const value = current.sha === null ? null : rateRecord(current.value).value;
  const decision = rateDecision(value);
  return decision.refused ? decision : { ...decision, path, sha: current.sha };
}

/** Read both shared indexes fresh, validate them, then apply admission caps. */
async function admit(env, { owner, submitter }) {
  // Validate both shared indexes before creating a record. In particular, a
  // damaged reviewer queue must not be replaced with this submission after
  // the inflight write has already committed.
  const [inflight] = await Promise.all([
    readInflightIndex(env),
    readReviewerIndex(env),
  ]);
  const open = inflight.open;
  const decision = admissionDecision(open, { owner, submitter });
  return decision.refused ? decision : { ...decision, inflight, open };
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
  // Project and validate the complete rate write before the first durable
  // admission write. A corrupt interval must not fail only after the record,
  // capacity slot, queue entry, and access-token index have committed.
  const nextRate = limit.path ? nextRateRecord({
    login: proof.principal.login,
    starts: limit.starts,
    interval: limit.interval,
    startedAt: record.created_at,
  }) : null;
  const nextInflight = [...open, { id, owner, submitter, at: record.created_at }];
  // Validate the bytes we are about to write as well as the bytes we read.
  // Provider logins are untrusted input at this boundary.
  inflightOpen({ open: nextInflight });
  await writeState(env, statePath(id, "state.json"), record, `Open submission ${id}`);
  await writeState(
    env,
    INFLIGHT_INDEX_PATH,
    { open: nextInflight },
    `Admit ${id}`,
    inflight.sha,
  );
  // Re-read after the two preceding commits. The first read above is the
  // fail-closed precondition; this one avoids widening the optimistic-SHA race
  // with the reviewer by carrying an older queue version across those writes.
  await openSubmission(env, id);
  await writeState(
    env,
    `index/tokens/${record.token_sha256}.json`,
    { id },
    `Index submission ${id}`,
  );
  if (limit.path) {
    await writeState(env, limit.path, nextRate, `Record a submission start`, limit.sha)
      .catch(() => {});
  }
  await dispatchVerification(env, {
    repositoryName: record.repository,
    commit: record.commit,
    requestId: id,
    options: {
      authorization_relationship: authorizationRelationshipLabel(record.authorization.relationship),
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

  // The attempt is spent before anything is spent on it, and claimed under the
  // sha it was read at. Counting afterwards bounded nothing: twenty calls
  // arriving together all read `attempts: 0`, all made their GitHub calls, and
  // nineteen then lost the write race, so one attempt was recorded for twenty
  // rounds of Palomar's token being pointed at a repository the caller named.
  //
  // What this buys is accounting that holds under concurrency, not exclusive
  // ownership. Every reservation that succeeds allows exactly one proof check
  // and records exactly one attempt, so ten is the most that can ever be spent.
  // Callers racing on the same sha cannot both have it and the losers are told
  // to try again, but one arriving after a reservation has landed can take the
  // next attempt while the first check is still running. That is fine: the
  // bound is on how many checks happen, not on how many happen at once.
  const attempts = Number(pending.value.attempts ?? 0) + 1;
  if (attempts > MAX_VERIFY_ATTEMPTS) {
    await deleteState(env, pendingPath, pending.sha, "Discard an intake that could not be proved");
    return json({ error: "too many attempts; start again" }, 429);
  }
  const reserved = { ...pending.value, attempts };
  try {
    await writeState(env, pendingPath, reserved, "Take a verification attempt", pending.sha);
  } catch (error) {
    return json({ error: "that submission is being verified; try again" }, 409);
  }
  const remaining = MAX_VERIFY_ATTEMPTS - attempts;

  const { repository, commit, challenge } = pending.value;

  // Before the proof, not after. The repository must be the one the challenge
  // was issued for, and GitHub follows renames and transfers silently, so
  // checking afterwards meant Palomar's token had already made calls against
  // whatever now answers to that name for a submission it was always going to
  // refuse.
  const repo = await fetchRepository(env.GITHUB_TOKEN, repository);
  if (pending.value.repository_id && repo?.id !== pending.value.repository_id) {
    return json({
      error: "that repository is not the one this submission began for",
      attempts_remaining: remaining,
    }, 409);
  }

  const tag = await challengeTag(env.SUBMISSION_TOKEN, repository, challenge, commit);
  const gist = tag.ok
    ? await challengeGist(env.SUBMISSION_TOKEN, body.gist_id, challenge, {
        issuedAt: pending.value.created_at,
      })
    : { ok: false };
  if (!tag.ok || !gist.ok) {
    return json({
      error: "that proof was refused",
      tag: tag.ok ? "accepted" : tag.reason,
      gist: gist.ok ? "accepted" : (gist.reason ?? "not checked: the tag was refused"),
      attempts_remaining: remaining,
    }, 403);
  }

  // Consumed only once the proof holds, and its failure is fatal: this is the
  // only thing between one challenge and two submissions. Re-read because the
  // reservation above replaced the blob, so the sha this started with is no
  // longer the one the delete has to name.
  const held = await readState(env, pendingPath);
  if (!held.value ||
      !(await deleteState(env, pendingPath, held.sha, "Consume pending intake"))) {
    return json({ error: "that submission could not be claimed; try again" }, 409);
  }

  let admitted;
  try {
    admitted = await admitSubmission(env, {
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
  } catch (error) {
    if (isDurableContractError(error)) {
      reportDurableContract(error);
      return consumedProofResponse({
        error: "submission intake is temporarily unavailable",
      }, 503);
    }
    console.error("agent-admission", error?.stack ?? String(error));
    return consumedProofResponse({
      error: "submission intake could not be completed",
    }, 500);
  }
  if (admitted.refused) {
    return consumedProofResponse(
      { error: admitted.title, detail: admitted.detail },
      admitted.status,
    );
  }
  return json({
    submission_id: admitted.id,
    access_token: admitted.token,
    proof_consumed: true,
    status_url: `${new URL(request.url).origin}/s#${admitted.token}`,
    next: [
      `Delete both artifacts now:`,
      `  gh api -X DELETE repos/${repository}/git/refs/tags/${CHALLENGE_TAG_PREFIX}${challenge}`,
      `  gh api -X DELETE gists/${body.gist_id}`,
      `Then send Authorization: Bearer <access_token> on the status and`,
      `decision requests. Do not exchange it for a cookie: that path is`,
      `for the browser, and it refuses a caller that is not one.`,
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

  const nonceDigest = await digest(nonce);
  const pendingPath = `pending/${nonceDigest}.json`;
  const pending = await readState(env, pendingPath);
  if (!pending.value) {
    return html(errorPage(env, "That sign-in has already been used", [
      "Start again from the submission form.",
    ]), 400);
  }

  // The cookie half of the intake, checked before the code is exchanged. It
  // can be absent because the browser finishing this sign-in is not the one
  // that began it, which is the attack, and it can be absent because fifteen
  // minutes went by or the browser was told to keep no cookies, which is not.
  // Both get the same answer: there is no way to tell them apart from here,
  // and guessing at which it was would only make the message worse.
  const presented = intakeBinding(request, nonceDigest);
  const expected = pending.value.binding_sha256;
  if (!expected || !presented || (await digest(presented)) !== expected) {
    // Consuming it stops the same link being offered to the next person, and
    // stops a leaked callback URL being replayed by whoever composed the flow.
    // Not fatal if it fails, unlike the consumption on the success path: this
    // request is refused either way and the sweep collects the record within
    // the hour. Logged rather than ignored, so a delete that keeps failing is
    // visible before it becomes a pile.
    if (!(await deleteState(env, pendingPath, pending.sha,
                            "Discard an intake finished elsewhere"))) {
      console.error("pending", `could not discard ${pendingPath}`);
    }
    return html(
      errorPage(env, "That sign-in did not begin here", [
        "Palomar completes a sign-in only in the browser that started it.",
        "If this was you, start again from the submission form.",
      ]),
      400,
      { "set-cookie": await intakeCookie(nonce, null, { clear: true }) },
    );
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
    return html(
      errorPage(env, "GitHub did not say who you are", spentSignInProblems([
        "Palomar could not read your GitHub login, and admits nothing it cannot attribute.",
      ])),
      502,
      { "set-cookie": await intakeCookie(nonce, null, { clear: true }) },
    );
  }

  // Anyone who can prove push access to any public repository can reach this
  // point, including on a repository they created a minute ago. Verification
  // is expensive and long-running, so admission is capped until real quotas
  // exist. This is deliberately blunt: refusing a genuine submitter with a
  // clear message is recoverable, exhausting the runners is not.
  const owner = viewer.owner?.login ?? null;
  let admitted;
  try {
    admitted = await admitSubmission(env, {
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
  } catch (error) {
    const contractFailure = isDurableContractError(error);
    if (contractFailure) reportDurableContract(error);
    else console.error("browser-admission", error?.stack ?? String(error));
    return html(
      errorPage(
        env,
        contractFailure
          ? "Submission intake is temporarily unavailable"
          : "Submission intake could not be completed",
        spentSignInProblems(["This is ours to fix, not yours."]),
      ),
      contractFailure ? 503 : 500,
      { "set-cookie": await intakeCookie(nonce, null, { clear: true }) },
    );
  }
  if (admitted.refused) {
    return html(
      errorPage(env, admitted.title, spentSignInProblems(admitted.detail)),
      admitted.status,
      { "set-cookie": await intakeCookie(nonce, null, { clear: true }) },
    );
  }
  const { token } = admitted;
  return new Response(null, {
    status: 303,
    headers: {
      location: `${new URL(request.url).origin}/s#${token}`,
      // Spent. Leaving it would put a live secret in the browser for fifteen
      // minutes against a record that no longer exists.
      "set-cookie": await intakeCookie(nonce, null, { clear: true }),
      ...SECURITY_HEADERS,
    },
  });
}

/**
 * Who is asking, and whether they were allowed to ask this way.
 *
 * Returns the submission entry, or a Response to send instead. Mutating
 * endpoints pass `mutating`, because the same-origin requirement is about a
 * credential being spent without its holder meaning to, and reading a review
 * cross-origin is already stopped by the browser refusing to hand over the
 * response.
 */
async function caller(env, request, { mutating = false } = {}) {
  const presented = bearerToken(request);
  if (presented) {
    const entry = await loadByToken(env, presented);
    return entry ?? json({ error: "not found" }, 404);
  }
  if (mutating && !madeByThisSite(request)) {
    return json({
      error: "that request did not come from this site",
      detail:
        "A browser must make this call from Palomar's own pages. A client that " +
        "is not a browser should present the access token as " +
        "`Authorization: Bearer <token>` instead of exchanging it for a cookie.",
    }, 403);
  }
  const entry = await loadByToken(env, sessionToken(request));
  return entry ?? json({ error: "not found" }, 404);
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
    const resetAt = now();
    // Absence already admits the next start at the floor. Do not synthesize a
    // partial document without the historical fields required of every
    // present rate record; a malformed present document fails closed.
    if (current.sha !== null) {
      await writeState(
        env,
        path,
        resetRateRecord(current.value, resetAt),
        "Reset after a registration",
        current.sha,
      ).catch(() => {});
    }
    const reset = { ...record, rate_reset_at: resetAt };
    await writeState(env, statePath(record.id, "state.json"), reset,
                     `Reset the interval for ${record.id}`, entry.sha).catch(() => {});
    return reset;
  }
  if (record.status !== "verifying") return record;
  const { run } = await findVerificationRun(env, record.id, {
    pinnedRunId: record.run?.id ?? null,
    since: record.created_at,
  });
  if (!run) return record;
  // The run is pinned the first time it is seen. A second run carrying the
  // same public submission id must not be able to take its place.
  if (record.run?.id && record.run.id !== run.id) return record;

  // Finding it clears any misses the cron pass recorded. Without this a miss is
  // permanent, and two misses an hour apart with a perfectly healthy run
  // between them would read as a run nobody can find.
  const next = { ...record, run };
  delete next.run_misses;
  if (run.status === "completed") {
    next.status = run.conclusion === "success" ? "awaiting-review" : "verification-failed";
    next.events = [
      ...record.events,
      { at: now(), status: next.status, note: `Verification ${run.conclusion}` },
    ];
  }
  if (next.status !== "verifying" && record.status === "verifying") {
    // Validate the capacity contract before another index can be changed. The
    // release itself deliberately re-reads after queueing, so it does not carry
    // this older optimistic SHA across the intervening work.
    await assertInflightContract(env);
  }
  if (next.status === "awaiting-review") {
    // Before the record says `awaiting-review`, and not caught. A submission
    // that settles without an entry in the reviewer's queue is one nothing
    // looks at until the weekly rebuild, and a failure swallowed here leaves a
    // record that will not be repaired sooner than that, because it no longer
    // looks like it needs anything. Failing leaves it `verifying`, which the
    // next pass retries.
    await openSubmission(env, record.id);
    // `openSubmission` is idempotent, so a failed pass can safely retry it.
    // Dispatch itself may be repeated on a retry, but each reviewer invocation
    // reads the same queue with this id present and converges on the same
    // record; the schedule is also a backstop. Failing to ask only costs that
    // schedule's latency, so it is not fatal. Crucially, the slot remains held
    // until both steps have been attempted, so a malformed queue cannot strand
    // a verifying record outside reconciliation.
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
  if (next.status !== "verifying" && record.status === "verifying") {
    // Commit the terminal state before releasing capacity. If the fresh
    // compare-and-swap release then fails, scheduled reconciliation sees the
    // non-verifying record and drops the stale reservation. Releasing first
    // could instead leave a verifying record outside the only set reconciliation
    // walks.
    await release(env, record.id);
  }
  return next;
}

/**
 * Say that a submission has work outstanding.
 *
 * The reviewer's pass used to find its work by listing `submissions/`, which is
 * an API call per submission per pass however few of them are moving, and which
 * stops working altogether at the thousand names the contents API will list.
 * It reads `index/open.json` instead, so a pass costs the queue rather than the
 * size of the registry.
 *
 * Only the reviewer removes entries, once the record says it is finished with
 * one. Adding has to happen here, because a submission the index never hears
 * about is a submission nothing reviews until the index is next rebuilt from
 * scratch. Written under the sha it was read at, like every other index, so a
 * concurrent change is surfaced instead of overwritten. That compare-and-swap
 * does not make the record, inflight index, and reviewer queue one transaction;
 * a conflict after an earlier write can still leave a partial admission.
 */
async function openSubmission(env, id) {
  const index = await readReviewerIndex(env);
  const open = index.open;
  if (open.includes(id)) return;
  await writeState(
    env,
    OPEN_INDEX_PATH,
    { ...index.value, open: [...open, id] },
    `Open ${id}`,
    index.sha,
  );
}

async function assertInflightContract(env) {
  await readInflightIndex(env);
}

async function release(env, id) {
  const inflight = await readInflightIndex(env);
  const open = inflight.open;
  const changed = open.some((item) => item.id === id);
  if (!changed) return;
  await writeState(env, INFLIGHT_INDEX_PATH,
                   { open: open.filter((item) => item.id !== id) },
                   `Release ${id}`, inflight.sha);
}

/**
 * Free admission slots whose submissions have finished.
 *
 * Slots used to be released only when the submitter's page polled, so closing
 * the tab held one forever and enough abandoned submissions would wedge
 * intake. This runs on a schedule instead, so nothing depends on a browser
 * staying open. It may throw after committing safe partial progress: in
 * particular it releases unrelated terminal reservations, then fails the run
 * if a malformed reviewer queue kept a successful verification from settling.
 */
// Exported for the tests, like `sweepPending`. Nothing else calls it: it is the
// cron path, and driving it directly is the only way to test the case where
// nobody is watching.
export async function reconcile(env) {
  const inflight = await readInflightIndex(env);
  const open = inflight.open;
  const still = [];
  let reviewerQueueUnavailable = false;
  for (const item of open) {
    const record = await readState(env, statePath(item.id, "state.json"));
    if (!record.value) continue;               // vanished: do not hold its slot
    if (record.value.status !== "verifying") continue;
    const pinned = record.value.run?.id ?? null;
    const { run, complete } = await findVerificationRun(env, item.id, {
      pinnedRunId: pinned,
      since: record.value.created_at,
    });

    // The same pinning `refresh` documents, and for the same reason: the
    // submission id is in a public run name, so a second run carrying it must
    // not settle this record. Missing here before, and this is the path that
    // runs with nobody watching.
    if (pinned && run && run.id !== pinned) {
      still.push(item);
      continue;
    }

    // Pin a run that is not finished yet, and forget any miss recorded before it
    // was found. Waiting for a run to complete before writing it down meant
    // every pass searched by name again, and meant a miss recorded an hour ago
    // still counted against a run that has been answering ever since.
    //
    // Only for a run still going: a completed one is written by the settle
    // below, in the same commit as the status it produced, and writing it twice
    // here would leave the second write holding a sha the first one replaced.
    if (run && run.status !== "completed" && (!pinned || record.value.run_misses)) {
      const seen = { ...record.value, run };
      delete seen.run_misses;
      await writeState(env, statePath(item.id, "state.json"), seen,
                       `Pin the run for ${item.id}`, record.sha);
      still.push(item);
      continue;
    }

    if (run?.status === "completed") {
      const settled =
        run.conclusion === "success" ? "awaiting-review" : "verification-failed";
      // Before the record stops saying `verifying`, and not caught. A failure
      // here has to leave something that will be tried again, and the only
      // thing that gets retried is a submission still in flight. The reviewer's
      // weekly sweep would rebuild the whole index eventually, but a week is
      // not a repair for a submitter waiting on a review.
      if (settled === "awaiting-review") {
        if (reviewerQueueUnavailable) {
          still.push(item);
          continue;
        }
        try {
          await openSubmission(env, item.id);
        } catch (error) {
          if (!(error instanceof StateContractError)) throw error;
          reportStateContract(error);
          reviewerQueueUnavailable = true;
          still.push(item);
          continue;
        }
      }
      const done = {
        ...record.value,
        run,
        status: settled,
        events: [...record.value.events,
                 { at: now(), status: settled, note: `Verification ${run.conclusion}` }],
      };
      delete done.run_misses;
      await writeState(env, statePath(item.id, "state.json"), done,
                       `Reconcile ${item.id}`, record.sha);
      if (settled === "awaiting-review") {
        // Idempotent and cheap. A submission that settles without an entry here
        // is one the reviewer's pass never looks at. The reviewer can rebuild
        // the derived queue on its maintenance path, but this server never
        // treats a missing id or malformed queue as an empty one.
        await dispatchReviewer(env).catch(() => false);
      }
      continue;
    }

    // A run nothing can find is not a run this record is waiting for. With the
    // search bounded by time rather than by count this should not happen, which
    // is exactly why it needs a floor: a submission stuck in `verifying` holds
    // three separate quotas and nothing else releases it, so a bug here used to
    // mean a registry that quietly stopped accepting submissions and an
    // operator editing private state by hand.
    //
    // Two misses rather than one, because a single empty answer is as likely to
    // be GitHub having a moment as a genuinely lost run, and this ends a
    // submission somebody is waiting on. Finding the run clears the count, so
    // the two have to be consecutive. A run that is merely queued is found, and
    // is left alone however long it waits.
    //
    // Only when the search actually established that there is no such run. A
    // search that ran out of pages says where it stopped looking and nothing
    // more, and reading that as absence is how a live run loses its slot.
    if (!run && complete) {
      const missed = (record.value.run_misses ?? 0) + 1;
      const age = Date.now() - (Date.parse(record.value.created_at) || Date.now());
      if (missed >= 2 && age > LOST_RUN_MS) {
        await writeState(env, statePath(item.id, "state.json"), {
          ...record.value,
          status: "dispatch-lost",
          run_misses: missed,
          events: [...record.value.events, {
            at: now(), status: "dispatch-lost",
            note: "Palomar could not find the verification run it started, and released the slot",
          }],
        }, `Release ${item.id}: its run was never found`, record.sha);
        continue;                              // dropped from `still`: slot back
      }
      if (missed !== (record.value.run_misses ?? 0)) {
        await writeState(env, statePath(item.id, "state.json"),
                         { ...record.value, run_misses: missed },
                         `Note a missing run for ${item.id}`, record.sha).catch(() => {});
      }
    }
    still.push(item);
  }
  if (still.length !== open.length) {
    await writeState(env, INFLIGHT_INDEX_PATH, { open: still },
                     "Reconcile admissions", inflight.sha);
  }
  if (reviewerQueueUnavailable) {
    throw new StateContractError(
      `${OPEN_INDEX_PATH} is unavailable; successful verification was not queued`,
    );
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
  /**
   * The two things nothing else does, and what happens when one of them throws.
   *
   * A cron handler has no submitter waiting on it and no response anyone reads,
   * so a throw here was an unreported failure: admission slots stopped being
   * freed and abandoned intake stopped being discarded, and the only sign of it
   * was intake wedging some hours later. Both are attempted whatever the other
   * does, and the run is failed at the end so the platform records it.
   */
  async scheduled(event, env) {
    const failures = [];
    for (const [what, task] of [["reconcile", reconcile], ["sweepPending", sweepPending]]) {
      try {
        await task(env);
      } catch (error) {
        console.error("scheduled", what, String(error?.stack ?? error));
        failures.push(`${what}: ${error}`);
      }
    }
    if (failures.length) throw new Error(`the scheduled pass failed: ${failures.join("; ")}`);
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      const missing = REQUIRED_SECRETS.filter((name) => !env[name]);

      // Answered ahead of the refusal below, because a health endpoint that
      // stops answering when the configuration is wrong cannot report the one
      // thing worth reporting. Whether the service is up, and nothing else:
      // naming what is missing here would tell anybody who asked which secrets
      // this deployment has and which it has lost, and the log already says it
      // where an operator can read it and a stranger cannot. GET and HEAD, like
      // every other route here.
      if ((request.method === "GET" || request.method === "HEAD") &&
          url.pathname === "/healthz") {
        // The limiter counts here too. Intake refuses without it, so a
        // deployment that has lost it is not serving its main purpose, and a
        // health endpoint that answered `ok` would be the last place that knew.
        const ok = missing.length === 0 && Boolean(env.INTAKE_LIMITER);
        return json({ ok }, ok ? 200 : 503);
      }

      // A missing secret is not a per-request failure to be reported five ways;
      // it is a deployment that should not be serving. Refusing everything is
      // also what makes the pepper's absence impossible to miss, which is the
      // whole reason it stopped defaulting to the empty string.
      if (missing.length) {
        console.error("configuration", `missing: ${missing.join(", ")}`);
        return html(
          errorPage(env, "Palomar is not configured", [
            "This deployment is missing something it needs and is not accepting",
            "submissions. This is ours to fix, not yours.",
          ]),
          503,
        );
      }

      if (request.method === "GET" && url.pathname === "/") {
        return html(intakeForm(env));
      }
      if (request.method === "POST" && url.pathname === "/api/submit") {
        return (
          (await intakeThrottle(env, request, { machine: true })) ??
          (await beginSubmission(request, env, { machine: true }))
        );
      }
      if (request.method === "POST" && url.pathname === "/api/verify") {
        return (
          (await intakeThrottle(env, request, { machine: true })) ??
          (await verifySubmission(request, env))
        );
      }
      if (request.method === "POST" && url.pathname === "/submit") {
        // Guarded as well as bound. The cookie stops a sign-in being finished
        // elsewhere, but not an intake being *started* in somebody's browser by
        // a page they were visiting: that browser would then hold the right
        // cookie for a submission the attacker composed. Agents use
        // `/api/submit`, and llms.txt tells them not to drive this one.
        if (!madeByThisSite(request)) {
          return html(
            errorPage(env, "That submission did not come from this site", [
              "Start again from Palomar's own submission form.",
            ]),
            403,
          );
        }
        return (
          (await intakeThrottle(env, request)) ?? (await beginSubmission(request, env))
        );
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
        // The same fault as /submit, and the same answer. A JSON body makes
        // `formData()` throw, and the throw used to be answered with the 500
        // page that blames Palomar and invites a retry that cannot work. The
        // status page posts a form here; a body this cannot read came from
        // something that guessed,
        // and 400 with a reason is what stops it guessing again.
        //
        // This is also what hands out the ambient credential, so a cross-site
        // post to it fixes a session in somebody's browser. A client that is
        // not a browser has no reason to be here: it can present the token as
        // a header on each call and never hold a cookie at all.
        if (!madeByThisSite(request)) {
          return json({
            error: "that request did not come from this site",
            detail:
              "Present the access token as `Authorization: Bearer <token>` " +
              "rather than exchanging it for a cookie.",
          }, 403);
        }
        let token;
        try {
          token = (await request.formData()).get("token");
        } catch {
          return json({ error: "post token=<access token> as a form, not as JSON" }, 400);
        }
        const entry = await loadByToken(env, String(token ?? ""));
        if (!entry) return json({ error: "not found" }, 404);
        return json({ ok: true }, 200, sessionCookie(String(token)));
      }
      if (request.method === "POST" && url.pathname === "/withdraw") {
        const entry = await caller(env, request, { mutating: true });
        if (entry instanceof Response) return entry;
        if (CLOSED.has(entry.record.status)) {
          return json({ error: `already ${entry.record.status}` }, 409);
        }
        // Verifying records are the ones expected to hold admission capacity.
        // A later state can temporarily retain a stale slot after a failed
        // release, but scheduled reconciliation owns that repair; withdrawal
        // must remain available despite unrelated capacity-index damage.
        if (entry.record.status === "verifying") {
          try {
            await assertInflightContract(env);
          } catch (error) {
            if (!(error instanceof StateContractError)) throw error;
            reportStateContract(error);
            return json({ error: "submission decisions are temporarily unavailable" }, 503);
          }
        }
        const next = {
          ...entry.record,
          status: "withdrawn",
          events: [...entry.record.events,
                   { at: now(), status: "withdrawn", note: "Withdrawn by the submitter" }],
        };
        await writeState(env, statePath(next.id, "state.json"), next,
                         `Withdraw ${next.id}`, entry.sha);
        if (entry.record.status === "verifying") await release(env, next.id);
        return json({ ok: true });
      }
      if (request.method === "GET" && url.pathname === "/api/review") {
        // The submitter sees the outcome and useful prose, but not the internal
        // three-way decision, scores, pass records, or finding severities.
        const entry = await caller(env, request);
        if (entry instanceof Response) return entry;
        const review = await readState(env, statePath(entry.record.id, "review.json"));
        if (!review.value) return json({ error: "no review yet" }, 404);
        if (!isCurrentReview(review.value, entry.record.id)) return obsoleteReview();
        // The digest goes out with the bytes it names, so consent can be given
        // for a review somebody actually read rather than for whatever was
        // current at the instant they clicked.
        //
        // A review whose digest the record does not carry yet is not ready to
        // be handed over. The reviewer writes the review and the digest in
        // separate steps, so there is a window where one exists without the
        // other, and answering with a null digest would leave the page holding
        // a review it can never register: it stops asking once it has been
        // shown one. Answering `no review yet` keeps it asking, which is what
        // the window needs.
        const reviewed = entry.record.review_sha256;
        if (!reviewed) return json({ error: "no review yet" }, 404);
        return json({ ...submitterReview(review.value), review_sha256: reviewed });
      }
      if (request.method === "POST" && url.pathname === "/register") {
        const entry = await caller(env, request, { mutating: true });
        if (entry instanceof Response) return entry;
        if (CLOSED.has(entry.record.status)) {
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

        // Consent is to bytes, not to a moment. The digest went out with the
        // review the submitter has in front of them and comes back with the
        // click, and if the reviewer replaced the review in between the two do
        // not match. Without this, a redelivery landing between reading and
        // clicking recorded consent for a review nobody had read, and the
        // review's comments go into a registered record: somebody could make
        // criticism of their own work public without ever having seen it.
        //
        // The reviewer already refuses to register anything whose digest
        // differs from the one consented to. That check and this one are the
        // same identity seen from both ends: this one is what makes the digest
        // it compares against mean what it says.
        const asked = String((await request.json().catch(() => ({})))?.review_sha256 ?? "");
        if (!asked) {
          // Says what to do rather than what went wrong. Nothing has been
          // replaced here; the caller simply did not say which review it meant.
          return json({
            error: "say which review this registers: post the review_sha256 " +
              "that GET /api/review returned",
          }, 409);
        }
        if (asked !== reviewed) {
          return json({
            error: "that review has been replaced; read the new one before registering",
          }, 409);
        }
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
        // A GET, but `refresh` writes records, releases capacity, spends the
        // shared GitHub budget and dispatches reviewer work, so it is guarded
        // like the rest. A same-site sibling could cause it with the session
        // cookie attached even though it could never read the answer, and not
        // depending on the render CSP for that is the point of this change.
        const entry = await caller(env, request, { mutating: true });
        if (entry instanceof Response) return entry;
        let record;
        try {
          record = await refresh(env, entry);
        } catch (error) {
          if (!isDurableContractError(error)) throw error;
          reportDurableContract(error);
          return json({ error: "submission status is temporarily unavailable" }, 503);
        }
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
      return html(errorPage(env, "No such page", []), 404);
    } catch (error) {
      // Never show a submitter the provider's vocabulary. They cannot act on
      // "GitHub 409", and it reads as their fault when it is ours.
      console.error("unhandled", url.pathname, String(error?.stack ?? error));
      return html(
        errorPage(env, "Palomar could not complete that just now", [
          "Try again in a moment. If you were making a decision, check its current status first.",
        ]),
        500,
      );
    }
  },
};
