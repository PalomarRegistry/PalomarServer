import {
  digest,
  newAccessToken,
  newSubmissionId,
  newRecord,
  pepper,
  recordedAt,
  STATUSES,
  statePath,
  tokenDigest,
} from "./submission.js";
import {
  GitHubError,
  StateUpdateOutcomeError,
  findVerificationRun,
  CHALLENGE_TAG_PREFIX,
  challengeGist,
  challengeTag,
  deleteState,
  dispatchRepairer,
  dispatchReviewer,
  listState,
  readState,
  repository as fetchRepository,
  resolveCommit,
  writeState,
  transactState,
} from "./github.js";
import { intakeForm, statusPage, errorPage, submissionsPage } from "./html.js";
import {
  admissionDecision,
  nextRateRecord,
  RateContractError,
  rateDecision,
  rateRecord,
  resetRateRecord,
} from "./admission-contract.js";
import { validateIntake } from "./intake-contract.js";
import {
  bearerToken,
  githubIdentityCookie,
  githubIdentityPrincipal,
  intakeCookie,
  intakeCredential,
  madeByThisSite,
  sessionCookie,
  sessionToken,
} from "./request-credentials.js";
import {
  INFLIGHT_INDEX_PATH,
  OPEN_INDEX_PATH,
  REPAIR_INDEX_PATH,
  inflightOpen,
  isCurrentReview,
  principalSubmissions,
  StateContractError,
  submitterReview,
  reviewerOpen,
  repairOpen,
} from "./state-contract.js";
import { normalizedQueuedRepairEdits } from "../public/repair-contract.js";
import arxivCategories from "../public/taxonomies/arxiv-categories.json" with { type: "json" };
import msc2020Codes from "../public/taxonomies/msc2020-codes.json" with { type: "json" };

const REPAIR_TAXONOMIES = Object.freeze({
  "classification.arxiv": new Map(
    arxivCategories.map((code) => [code.toUpperCase(), code]),
  ),
  "classification.msc2020": new Map(
    Object.keys(msc2020Codes).map((code) => [code.toUpperCase(), code]),
  ),
});
import {
  activeSubmissionPhase,
  assertInflightContract,
  dispatchSubmissionVerification,
  openSubmission,
  release,
  scheduledMaintenance,
} from "./submission-lifecycle.js";
import {
  beginDashboardLogin,
  completeDashboardLogin,
  dashboardPrincipal,
  technicalTeamMembership,
} from "./dashboard-auth.js";
import { dashboardHtml, withDashboardActions } from "./dashboard.js";
import { SECURITY_HEADERS } from "./response-security.js";
// One vocabulary for "this submission has stopped moving", shared with the
// status page, which asks a slightly different question of the same words.
import { CLOSED } from "../public/statuses.js";

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

/** Append another Set-Cookie field without collapsing an existing one. */
function withCookie(response, cookie) {
  const headers = new Headers(response.headers);
  headers.append("set-cookie", cookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function operationalDashboard(env) {
  try {
    const stored = await readState(env, "reports/dashboard.json");
    if (stored.value === null) return { kind: "missing" };
    return { kind: "ready", value: withDashboardActions(stored.value) };
  } catch (error) {
    if (error instanceof GitHubError) {
      console.error("dashboard-provider", error.message);
      return { kind: "unavailable" };
    }
    console.error("dashboard-contract", error instanceof Error ? error.message : String(error));
    return { kind: "invalid" };
  }
}

const MAX_VERIFY_ATTEMPTS = 10;

function formalizationPath(record) {
  const explicit = record.requested_paths?.formalization_metadata_path;
  if (explicit) return explicit;
  const project = record.requested_paths?.project_path;
  return project ? `${project}/formalization.yaml` : "formalization.yaml";
}

/** A redundant marker set: losing any one field must not make a test registrable. */
function isTechnicalTest(record) {
  return record?.test_submission === true ||
    record?.authorization?.relationship === "technical-test" ||
    record?.push_proof?.method === "technical-team-test";
}

function submitterRepair(repair) {
  if (!repair || typeof repair !== "object" || typeof repair.status !== "string") return null;
  return Object.fromEntries(Object.entries({
    revision: repair.revision,
    status: repair.status,
    requested_at: repair.requested_at,
    updated_at: repair.updated_at,
    pr_url: repair.pr_url,
    patch: repair.patch,
    explanation: repair.explanation,
  }).filter(([, value]) => value !== undefined));
}

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

function obsoleteReview() {
  return json({ error: "the review uses an obsolete or invalid contract and must be rerun" }, 409);
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

function isDurableContractError(error) {
  return error instanceof StateContractError || error instanceof RateContractError ||
    (error instanceof GitHubError && [409, 503].includes(error.status));
}

function reportDurableContract(error) {
  console.error(error instanceof RateContractError ? "rate-contract" : "state-contract", error.message);
}

async function readRateState(env, path) {
  try {
    return await readState(env, path);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new RateContractError(`${path} must contain valid JSON`);
  }
}

function atRatePath(path, operation) {
  try {
    return operation();
  } catch (error) {
    if (!(error instanceof RateContractError)) throw error;
    throw new RateContractError(`${path}: ${error.message}`);
  }
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
  const automaticRecovery = !machine && Boolean(await githubIdentityPrincipal(request, env));
  // A browser gets its form back with everything still in it; an agent gets
  // the same problems as a list it can act on.
  const rejected = (...problems) =>
    machine
      ? json({ error: "that submission was refused", problems }, 400)
      : html(intakeForm(env, values, problems, { automaticRecovery }), 400);

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
  const technicalTest = relationship === "technical-test";

  if (machine && technicalTest) {
    return rejected(
      "That authorization relationship is available only through browser sign-in.",
    );
  }

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
    created_at: recordedAt(),
  };
  try {
    await writeState(
      env,
      `pending/${await digest(nonce)}.json`,
      pending,
      `Begin submission for ${repositoryName}`,
    );
  } catch {
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
        `same write access an ordinary browser submission checks for, which is why it is here:`,
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
  // Every browser submission needs enough visibility to distinguish an active
  // Technical Maintainer from an ordinary submitter. The exemption belongs to
  // the authenticated account, not to the authorization relationship selected
  // on the form.
  authorize.searchParams.set("scope", "read:user read:org");
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

/** Begin a GitHub sign-in that recovers current submissions without starting one. */
async function beginRecovery(request, env) {
  let pendingCount;
  try {
    pendingCount = (await listState(env, "pending")).length;
  } catch (error) {
    console.error("pending", String(error?.stack ?? error));
    return intakeUnavailable(env, false);
  }
  if (pendingCount >= MAX_PENDING) {
    return html(errorPage(env, "Submission recovery is temporarily busy", [
      "Please try again shortly.",
    ]), 429);
  }

  const nonce = newAccessToken();
  const binding = newAccessToken();
  const pending = {
    schema_version: 2,
    binding_sha256: await digest(binding),
    method: "oauth-recovery",
    created_at: recordedAt(),
  };
  try {
    await writeState(
      env,
      `pending/${await digest(nonce)}.json`,
      pending,
      "Begin submission recovery",
    );
  } catch {
    return html(errorPage(env, "Submission recovery could not begin", [
      "Nothing was changed. Please try again.",
    ]), 503);
  }

  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", env.OAUTH_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", `${new URL(request.url).origin}/oauth/callback`);
  authorize.searchParams.set("scope", "read:user");
  authorize.searchParams.set("state", nonce);
  return new Response(null, {
    status: 303,
    headers: {
      location: authorize.toString(),
      "set-cookie": await intakeCookie(nonce, binding),
      ...SECURITY_HEADERS,
    },
  });
}

// Filed under a peppered digest rather than a login, so reading the state
// repository does not enumerate everyone who has ever submitted — the same
// reason `index/tokens/` is shaped that way.
async function ratePath(env, principalId) {
  return `index/rate/${await digest(`${pepper(env)}:${principalId}`)}.json`;
}

async function principalPath(env, principalId) {
  return `index/principals/${await digest(`${pepper(env)}:${principalId}`)}.json`;
}

function principalOwns(record, principal) {
  return Number.isSafeInteger(principal?.id) &&
    record?.push_proof?.principal?.id === principal.id;
}

async function openSubmissionsForPrincipal(env, principal) {
  try {
    const principalIndexPath = await principalPath(env, principal.id);
    const principalIndex = await readState(env, principalIndexPath);
    if (principalIndex.sha === null) {
      return { principalIndexPath, principalIndex, queue: null, entries: [] };
    }
    const indexed = principalSubmissions(principalIndex.value, principalIndexPath);
    const queue = await readState(env, OPEN_INDEX_PATH);
    const ids = reviewerOpen(queue.value);
    const current = ids.filter((id) => indexed.includes(id));
    const entries = await Promise.all(current.map(async (id) => ({
      id,
      path: statePath(id, "state.json"),
      entry: await readState(env, statePath(id, "state.json")),
    })));
    for (const item of entries) {
      if (!item.entry.value) {
        throw new StateContractError(`${OPEN_INDEX_PATH} names missing submission ${item.id}`);
      }
    }
    for (const item of entries) {
      if (!principalOwns(item.entry.value, principal)) {
        throw new StateContractError(
          `${principalIndexPath} names a submission owned by another GitHub principal`,
        );
      }
    }
    // The reviewer queue is repaired asynchronously, so a terminal submission
    // can briefly remain indexed. The record itself is authoritative about
    // whether there is still anything for the submitter to recover.
    return {
      principalIndexPath,
      principalIndex,
      queue,
      entries: entries.filter((item) => !CLOSED.has(item.entry.value.status)),
    };
  } catch (error) {
    if (error instanceof StateContractError) throw error;
    if (error instanceof SyntaxError) {
      throw new StateContractError(`${OPEN_INDEX_PATH} or one of its submissions is not valid JSON`);
    }
    throw error;
  }
}

/**
 * Rotate the authenticated recovery capability for each current submission.
 *
 * The original link remains valid. Exactly one additional recovery link is
 * retained per record, so repeatedly signing in neither invalidates a bookmark
 * nor grows the token index without bound.
 */
async function issueRecoveryLinks(
  env,
  {
    pendingPath,
    pendingSha,
    principal,
    verification = null,
    consumePending = false,
    onlyIfAny = false,
  },
) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const discovered = await openSubmissionsForPrincipal(env, principal);
    if (onlyIfAny && discovered.entries.length === 0) {
      return { submissions: [] };
    }
    const issued = await Promise.all(discovered.entries.map(async (item) => {
      const token = newAccessToken();
      const tokenSha256 = await tokenDigest(env, token);
      const original = item.entry.value.token_sha256;
      const oldRecovery = item.entry.value.recovery_token_sha256 ?? null;
      if (!/^[0-9a-f]{64}$/.test(original)) {
        throw new StateContractError(`${item.path}.token_sha256 must be a SHA-256 digest`);
      }
      if (oldRecovery !== null && !/^[0-9a-f]{64}$/.test(oldRecovery)) {
        throw new StateContractError(
          `${item.path}.recovery_token_sha256 must be a SHA-256 digest`,
        );
      }
      if (oldRecovery === original) {
        throw new StateContractError(
          `${item.path}.recovery_token_sha256 must differ from token_sha256`,
        );
      }
      return {
        ...item,
        token,
        tokenSha256,
        tokenPath: `index/tokens/${tokenSha256}.json`,
        originalTokenPath: `index/tokens/${original}.json`,
        oldRecovery,
        oldTokenPath: oldRecovery ? `index/tokens/${oldRecovery}.json` : null,
      };
    }));
    const paths = [...new Set([
      pendingPath,
      ...(discovered.queue ? [OPEN_INDEX_PATH, discovered.principalIndexPath] : []),
      ...issued.flatMap((item) => [
        item.path,
        item.tokenPath,
        item.originalTokenPath,
        ...(item.oldTokenPath ? [item.oldTokenPath] : []),
      ]),
    ])];
    const result = await transactState(env, paths, (files) => {
      if (
        files[pendingPath]?.sha !== pendingSha ||
        (discovered.queue && (
          files[OPEN_INDEX_PATH]?.sha !== discovered.queue.sha ||
          files[discovered.principalIndexPath]?.sha !== discovered.principalIndex.sha
        ))
      ) {
        return { changes: [], message: "", result: { retry: true } };
      }
      const currentIds = discovered.queue
        ? reviewerOpen(files[OPEN_INDEX_PATH]?.value)
        : [];
      for (const item of issued) {
        const current = files[item.path];
        if (current?.sha !== item.entry.sha || !currentIds.includes(item.id)) {
          return { changes: [], message: "", result: { retry: true } };
        }
        if (!principalOwns(current.value, principal)) {
          throw new StateContractError(
            `${item.path} no longer belongs to the authenticated GitHub principal`,
          );
        }
        if (files[item.tokenPath]?.sha !== null) {
          throw new StateContractError("a generated recovery token already exists");
        }
        if (files[item.originalTokenPath]?.value?.id !== item.id) {
          throw new StateContractError(`${item.path} has no matching original token pointer`);
        }
        if (item.oldTokenPath && files[item.oldTokenPath]?.value?.id !== item.id) {
          throw new StateContractError(`${item.path} has no matching recovery token pointer`);
        }
      }

      const held = files[pendingPath].value;
      const pendingChange = consumePending
        ? { path: pendingPath, delete: true }
        : {
            path: pendingPath,
            value: {
              ...held,
              oauth_verification: verification,
              created_at: recordedAt(),
            },
          };
      const changes = [pendingChange];
      for (const item of issued) {
        changes.push({
          path: item.path,
          value: {
            ...files[item.path].value,
            recovery_token_sha256: item.tokenSha256,
            recovery_token_bound_at: recordedAt(),
          },
        });
        if (item.oldTokenPath) changes.push({ path: item.oldTokenPath, delete: true });
        changes.push({ path: item.tokenPath, value: { id: item.id } });
      }
      return {
        changes,
        message: consumePending
          ? `Recover ${issued.length} submission link(s)`
          : `Prepare submission choice with ${issued.length} current link(s)`,
        result: {
          retry: false,
          submissions: issued.map((item) => ({
            id: item.id,
            repository: item.entry.value.repository,
            commit: item.entry.value.commit,
            status: item.entry.value.status,
            statusLabel: STATUSES[item.entry.value.status] ?? item.entry.value.status,
            replaceable: !CLOSED.has(item.entry.value.status),
            token: item.token,
          })),
        },
      };
    });
    if (!result.retry) return result;
  }
  throw new StateContractError("the open-submission list kept changing during recovery");
}

function submissionSummary(item) {
  const record = item.entry.value;
  return {
    id: item.id,
    repository: record.repository,
    commit: record.commit,
    status: record.status,
    status_label: STATUSES[record.status] ?? record.status,
  };
}

/** List current work without minting or rotating any submission capability. */
async function automaticSubmissions(request, env) {
  if (!madeByThisSite(request)) {
    return json({ error: "that request did not come from this site" }, 403);
  }
  const principal = await githubIdentityPrincipal(request, env);
  if (!principal) return json({ error: "authentication required" }, 401);
  try {
    const discovered = await openSubmissionsForPrincipal(env, principal);
    return json({ submissions: discovered.entries.map(submissionSummary) });
  } catch (error) {
    if (isDurableContractError(error)) reportDurableContract(error);
    else console.error("automatic-recovery", error?.stack ?? String(error));
    return json({ error: "submissions are temporarily unavailable" }, 503);
  }
}

/**
 * Mint a recovery capability for one explicitly opened automatic result.
 *
 * Merely viewing the form remains read-only. This rotates the one recovery
 * capability only after the authenticated browser chooses a submission, while
 * preserving the original capability exactly as the full OAuth recovery does.
 */
async function issueRecoveryLink(env, principal, id) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const discovered = await openSubmissionsForPrincipal(env, principal);
    const item = discovered.entries.find((entry) => entry.id === id);
    if (!item) return null;

    const token = newAccessToken();
    const tokenSha256 = await tokenDigest(env, token);
    const original = item.entry.value.token_sha256;
    const oldRecovery = item.entry.value.recovery_token_sha256 ?? null;
    if (!/^[0-9a-f]{64}$/.test(original)) {
      throw new StateContractError(`${item.path}.token_sha256 must be a SHA-256 digest`);
    }
    if (oldRecovery !== null && !/^[0-9a-f]{64}$/.test(oldRecovery)) {
      throw new StateContractError(
        `${item.path}.recovery_token_sha256 must be a SHA-256 digest`,
      );
    }
    if (oldRecovery === original) {
      throw new StateContractError(
        `${item.path}.recovery_token_sha256 must differ from token_sha256`,
      );
    }
    const tokenPath = `index/tokens/${tokenSha256}.json`;
    const originalTokenPath = `index/tokens/${original}.json`;
    const oldTokenPath = oldRecovery ? `index/tokens/${oldRecovery}.json` : null;
    const paths = [
      OPEN_INDEX_PATH,
      discovered.principalIndexPath,
      item.path,
      tokenPath,
      originalTokenPath,
      ...(oldTokenPath ? [oldTokenPath] : []),
    ];
    const result = await transactState(env, paths, (files) => {
      if (
        files[OPEN_INDEX_PATH]?.sha !== discovered.queue?.sha ||
        files[discovered.principalIndexPath]?.sha !== discovered.principalIndex.sha ||
        files[item.path]?.sha !== item.entry.sha
      ) {
        return { changes: [], message: "", result: { retry: true } };
      }
      const currentIds = reviewerOpen(files[OPEN_INDEX_PATH]?.value);
      const principalIds = principalSubmissions(
        files[discovered.principalIndexPath]?.value,
        discovered.principalIndexPath,
      );
      const current = files[item.path]?.value;
      if (!currentIds.includes(id) || !principalIds.includes(id) ||
          !principalOwns(current, principal)) {
        return { changes: [], message: "", result: { retry: true } };
      }
      if (files[tokenPath]?.sha !== null) {
        throw new StateContractError("a generated recovery token already exists");
      }
      if (files[originalTokenPath]?.value?.id !== id) {
        throw new StateContractError(`${item.path} has no matching original token pointer`);
      }
      if (oldTokenPath && files[oldTokenPath]?.value?.id !== id) {
        throw new StateContractError(`${item.path} has no matching recovery token pointer`);
      }
      return {
        changes: [
          {
            path: item.path,
            value: {
              ...current,
              recovery_token_sha256: tokenSha256,
              recovery_token_bound_at: recordedAt(),
            },
          },
          ...(oldTokenPath ? [{ path: oldTokenPath, delete: true }] : []),
          { path: tokenPath, value: { id } },
        ],
        message: `Recover submission link for ${id}`,
        result: { retry: false, token },
      };
    });
    if (!result.retry) return result.token;
  }
  throw new StateContractError("the selected submission kept changing during recovery");
}

async function openAutomaticSubmission(request, env) {
  if (!madeByThisSite(request)) {
    return html(errorPage(env, "That request did not come from this site", [
      "Return to Palomar's submission form before opening the submission.",
    ]), 403);
  }
  const principal = await githubIdentityPrincipal(request, env);
  if (!principal) {
    return new Response(null, {
      status: 303,
      headers: { ...SECURITY_HEADERS, location: "/submissions" },
    });
  }
  let form;
  try {
    form = await request.formData();
  } catch {
    return html(errorPage(env, "That submission could not be opened", []), 400);
  }
  const id = String(form.get("submission_id") ?? "");
  if (!/^[0-9a-z]{12}$/.test(id)) {
    return html(errorPage(env, "That submission could not be opened", []), 400);
  }
  try {
    const token = await issueRecoveryLink(env, principal, id);
    if (!token) {
      return html(errorPage(env, "That submission is no longer in progress", [
        "Return to the submission form to refresh the list.",
      ]), 404);
    }
    return new Response(null, {
      status: 303,
      headers: {
        ...SECURITY_HEADERS,
        location: `${new URL(request.url).origin}/s#${token}`,
      },
    });
  } catch (error) {
    if (error instanceof StateUpdateOutcomeError) {
      console.error("automatic-recovery-open", error.message);
      return html(errorPage(env, "That submission link could not be confirmed", [
        "The original submission link remains valid. Return to the submission form and try opening it again.",
      ]), 503);
    }
    if (!isDurableContractError(error)) throw error;
    reportDurableContract(error);
    return html(errorPage(env, "That submission is temporarily unavailable", [
      "The original submission link remains valid. Please try again in a moment.",
    ]), 503);
  }
}

/**
 * Everything after the proof, shared so the two intakes cannot drift apart.
 *
 * Ordinary browser and agent intakes prove write access by different means; a
 * marked browser test proves technical-team membership instead. What follows
 * records that distinction but otherwise shares the same admission, indexes,
 * and dispatch. Two copies would be two definitions of what a submission is.
 */
async function admitSubmission(
  env,
  {
    pendingPath,
    pendingSha,
    pending,
    owner,
    submitter,
    proof,
    replaceId = null,
    preserveOnRefusal = false,
  },
) {
  const id = newSubmissionId();
  const token = newAccessToken();
  const createdAtMs = Date.now();
  const createdAt = new Date(createdAtMs).toISOString().replace(/\.\d+Z$/, "Z");
  const tokenSha256 = await tokenDigest(env, token);
  const testSubmission = pending.authorization_relationship === "technical-test";
  // New proofs carry the explicit marker. Accept the existing dedicated proof
  // method too, so a choice page minted by the previous deployment does not
  // suddenly acquire a throttle after this Worker is deployed.
  const technicalMaintainer = proof?.technical_maintainer === true ||
    proof?.method === "technical-team-test";
  // Registration clears an ordinary submitter's exponential backoff. Active
  // Technical Maintainers are operationally exempt regardless of whether this
  // is a marked test or an ordinary submission.
  const rate = proof?.principal?.id && !technicalMaintainer
    ? await ratePath(env, proof.principal.id)
    : null;
  const principalIndexPath = proof?.principal?.id
    ? await principalPath(env, proof.principal.id)
    : null;
  const recordPath = statePath(id, "state.json");
  const tokenPath = `index/tokens/${tokenSha256}.json`;
  const replacedRecordPath = replaceId ? statePath(replaceId, "state.json") : null;
  const paths = [
    pendingPath,
    INFLIGHT_INDEX_PATH,
    OPEN_INDEX_PATH,
    recordPath,
    tokenPath,
    ...(principalIndexPath ? [principalIndexPath] : []),
    ...(replacedRecordPath ? [replacedRecordPath] : []),
    ...(rate ? [rate] : []),
  ];
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
      testSubmission,
      authorization: {
        relationship: pending.authorization_relationship,
        ...(pending.authorization_evidence
          ? { evidence: pending.authorization_evidence }
          : {}),
      },
    }),
    push_proof: proof,
    created_at: createdAt,
    token_sha256: tokenSha256,
    // A durable outbox lease. This request owns the first dispatch; if it dies
    // before or after the ambiguous workflow_dispatch response, reconciliation
    // searches for the run and only claims another attempt after the lease.
    dispatch_lease_at: createdAt,
    dispatch_lease_count: 1,
    events: [{ at: createdAt, status: "verifying",
      note: "Preparation and mechanical verification queued",
    }],
  };
  let result;
  try {
    result = await transactState(env, paths, (files) => {
      const held = files[pendingPath];
      if (held?.sha === null) {
        return {
          changes: [],
          message: "",
          result: {
            refused: true,
            status: 409,
            title: "That submission was already claimed",
            detail: ["Another request consumed this proof. Start a new submission."],
          },
        };
      }
      if (held?.sha !== pendingSha) {
        return {
          changes: [],
          message: "",
          result: {
            refused: true,
            retryable: true,
            status: 409,
            title: "That submission is being verified",
            detail: ["Another request reserved this proof. Try again."],
          },
        };
      }
      const inflight = inflightOpen(files[INFLIGHT_INDEX_PATH]?.value);
      const reviewer = files[OPEN_INDEX_PATH];
      const reviewerIds = reviewerOpen(reviewer?.value);
      let replaced = null;
      let availableInflight = inflight;
      if (replaceId) {
        const old = files[replacedRecordPath]?.value;
        const oldPrincipal = old?.push_proof?.principal;
        if (!reviewerIds.includes(replaceId) || !old) {
          return {
            changes: [],
            message: "",
            result: {
              refused: true,
              retryable: true,
              status: 409,
              title: "That earlier submission is no longer in progress",
              detail: ["Refresh the list before deciding what to replace."],
            },
          };
        }
        if (oldPrincipal?.id !== proof?.principal?.id) {
          throw new StateContractError("a replacement did not belong to its authenticated submitter");
        }
        if (String(old.repository).toLowerCase() !== String(pending.repository).toLowerCase()) {
          return {
            changes: [],
            message: "",
            result: {
              refused: true,
              retryable: true,
              status: 409,
              title: "That is not an earlier submission of this repository",
              detail: ["Choose the matching submission, or continue with the new one separately."],
            },
          };
        }
        if (CLOSED.has(old.status)) {
          return {
            changes: [],
            message: "",
            result: {
              refused: true,
              retryable: true,
              status: 409,
              title: "That earlier submission can no longer be abandoned",
              detail: [`It is already ${old.status}.`],
            },
          };
        }
        availableInflight = inflight.filter((item) => item.id !== replaceId);
        replaced = {
          ...old,
          status: "withdrawn",
          events: [
            ...old.events,
            {
              at: record.created_at,
              status: "withdrawn",
              note: `Replaced by submission ${id}`,
            },
          ],
        };
      }
      let limit = { refused: false, interval: null, starts: null };
      if (rate) {
        const current = files[rate];
        const value = current.sha === null
          ? null
          : atRatePath(rate, () => rateRecord(current.value).value);
        limit = rateDecision(value, createdAtMs);
      }
      // Membership is proved by OAuth before this point. Neither the ordinary
      // submitter backoff above nor its owner/submitter concurrency caps applies
      // to an active Technical Maintainer's account.
      const admission = limit.refused || technicalMaintainer
        ? limit
        : admissionDecision(availableInflight, { owner, submitter });
      if (admission.refused) {
        return {
          changes: preserveOnRefusal ? [] : [{ path: pendingPath, delete: true }],
          message: preserveOnRefusal ? "" : "Consume refused submission proof",
          result: { ...admission, retryable: preserveOnRefusal || admission.retryable },
        };
      }
      if (files[recordPath]?.sha !== null || files[tokenPath]?.sha !== null) {
        throw new StateContractError("a generated submission identity already exists");
      }
      const nextInflight = [
        ...availableInflight,
        { id, owner, submitter, at: record.created_at },
      ];
      inflightOpen({ open: nextInflight });
      const nextReviewer = reviewerIds.includes(id)
        ? reviewer.value
        : { ...reviewer.value, open: [...reviewerIds, id] };
      reviewerOpen(nextReviewer);
      const changes = [
        { path: pendingPath, delete: true },
        ...(replaced ? [{ path: replacedRecordPath, value: replaced }] : []),
        { path: recordPath, value: record },
        { path: INFLIGHT_INDEX_PATH, value: { open: nextInflight } },
        { path: OPEN_INDEX_PATH, value: nextReviewer },
        { path: tokenPath, value: { id } },
      ];
      if (principalIndexPath) {
        const current = files[principalIndexPath];
        const submissionIds = current.sha === null
          ? []
          : principalSubmissions(current.value, principalIndexPath);
        changes.push({
          path: principalIndexPath,
          value: { schema_version: 1, submissions: [...submissionIds, id] },
        });
      }
      if (rate) {
        changes.push({
          path: rate,
          value: nextRateRecord({
            login: proof.principal.login,
            starts: limit.starts,
            interval: limit.interval,
            startedAt: record.created_at,
            at: createdAtMs,
          }),
        });
      }
      return {
        changes,
        message: replaced
          ? `Replace submission ${replaceId} with ${id}`
          : `Admit submission ${id}`,
        result: { refused: false, id, token, record },
      };
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new StateContractError(error.message);
    }
    throw error;
  }
  if (result.refused) return result;
  // `verifying` with no pinned run is the durable dispatch outbox. A failed or
  // ambiguous request does not undo admission: the scheduled lifecycle first
  // searches for a run, then safely retries one that still has none.
  await dispatchSubmissionVerification(env, result.record, "full").catch((error) => {
    console.error("verification-dispatch", error?.stack ?? String(error));
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
  if (pending.value.authorization_relationship === "technical-test") {
    return json({ error: "that authorization requires browser sign-in" }, 409);
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
  } catch {
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

  // The reservation above replaced the blob, so admission binds itself to the
  // exact held version. Its deletion is part of the same commit as every
  // accepted admission write (or the sole change for a policy refusal).
  const held = await readState(env, pendingPath);
  if (!held.value) {
    return json({ error: "that submission could not be claimed; try again" }, 409);
  }

  let admitted;
  try {
    admitted = await admitSubmission(env, {
      pendingPath,
      pendingSha: held.sha,
      pending: pending.value,
      owner: repo?.owner?.login ?? null,
      submitter: gist.principal.login,
      proof: {
        schema_version: 1,
        method: "tag-and-gist",
        binding: "separately-attested",
        verified_at: recordedAt(),
        repository_id: pending.value.repository_id,
        commit,
        challenge_sha256: await digest(challenge),
        principal: gist.principal,
      },
    });
  } catch (error) {
    if (error instanceof StateUpdateOutcomeError) {
      console.error("agent-admission", error.message);
      return json({
        error: "submission intake outcome is unknown",
        proof_consumed: "unknown",
        retry: "Do not retry automatically; ask the registry operator to inspect State.",
        attempts_remaining: remaining,
      }, 503);
    }
    if (isDurableContractError(error)) {
      reportDurableContract(error);
      return json({
        error: "submission intake is temporarily unavailable",
        proof_consumed: false,
        retry: "Keep the proof artifacts and retry this request.",
        attempts_remaining: remaining,
      }, 503);
    }
    console.error("agent-admission", error?.stack ?? String(error));
    return json({
      error: "submission intake could not be completed",
      proof_consumed: false,
      retry: "Keep the proof artifacts and retry this request.",
      attempts_remaining: remaining,
    }, 500);
  }
  if (admitted.refused) {
    if (admitted.retryable) {
      return json({
        error: admitted.title,
        detail: admitted.detail,
        proof_consumed: false,
      }, admitted.status);
    }
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

/** Answer one structurally unusable browser binding without touching State. */
async function refusedIntakeCredential(env, nonce) {
  return html(
    errorPage(env, "That sign-in did not begin here", [
      "Palomar completes a sign-in only in the browser that started it.",
      "If this was you, start again from the submission form.",
    ]),
    400,
    { "set-cookie": await intakeCookie(nonce, null, { clear: true }) },
  );
}

/**
 * Prove ordinary repository write access or an explicit technical-team test.
 *
 * The token is used once, here, and never stored. Ordinary push access is not
 * the same as authorship; the test exception claims neither, and its distinct
 * relationship and proof make it permanently non-registerable.
 */
async function completeSubmission(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const nonce = url.searchParams.get("state");
  if (!code || !nonce) return html(errorPage(env, "That sign-in did not complete", []), 400);

  const nonceDigest = await digest(nonce);
  const credential = intakeCredential(request, nonceDigest);
  // A malformed or ambiguous protected name can only come from a raw client,
  // proxy corruption, or a broken cookie implementation. It has no authority
  // to consume the pending proof, so stop before even reading durable State.
  // The pending record remains available for a legitimate callback or sweep.
  if (credential.kind === "invalid" || credential.kind === "ambiguous") {
    return refusedIntakeCredential(env, nonce);
  }
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
  const presented = credential.kind === "valid" ? credential.value : null;
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
    return refusedIntakeCredential(env, nonce);
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

  const user = await (
    await fetch("https://api.github.com/user", {
      headers: {
        authorization: `Bearer ${granted.access_token}`,
        accept: "application/vnd.github+json",
        "user-agent": "palomar-server",
      },
    })
  ).json();

  const submitter = user?.login;
  const principal = { login: submitter, id: user?.id };
  if (!submitter || !Number.isSafeInteger(user?.id)) {
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
  const identityCookie = await githubIdentityCookie(env, principal);
  const identified = (response) => withCookie(response, identityCookie);

  if (pending.value.method === "oauth-recovery") {
    try {
      const recovered = await issueRecoveryLinks(env, {
        pendingPath,
        pendingSha: pending.sha,
        principal,
        consumePending: true,
      });
      return identified(html(
        submissionsPage(env, { submissions: recovered.submissions }),
        200,
        { "set-cookie": await intakeCookie(nonce, null, { clear: true }) },
      ));
    } catch (error) {
      if (error instanceof StateUpdateOutcomeError) {
        console.error("submission-recovery", error.message);
      } else if (isDurableContractError(error)) {
        reportDurableContract(error);
      } else {
        console.error("submission-recovery", error?.stack ?? String(error));
      }
      return identified(html(
        errorPage(env, "Submission recovery is temporarily unavailable", [
          "No original link was invalidated. Please try recovery again in a moment.",
        ]),
        503,
        { "set-cookie": await intakeCookie(nonce, null, { clear: true }) },
      ));
    }
  }

  if (pending.value.oauth_verification) {
    return identified(html(errorPage(env, "That sign-in is already waiting for your choice", [
      "Return to the choice page, or start again from the submission form.",
    ]), 409));
  }

  const viewer = await fetchRepository(granted.access_token, pending.value.repository);

  const requestedTechnicalTest =
    pending.value.authorization_relationship === "technical-test";
  if (requestedTechnicalTest && (
    !viewer ||
    viewer.private === true ||
    (pending.value.repository_id != null && viewer.id !== pending.value.repository_id)
  )) {
    if (!(await deleteState(env, pendingPath, pending.sha,
                            "Discard a technical test whose repository changed"))) {
      console.error("pending", `could not discard ${pendingPath}`);
    }
    return identified(html(
      errorPage(env, "That repository is not the one this test began for", spentSignInProblems([
        `${pending.value.repository} could not be read as the same public repository.`,
      ])),
      409,
      { "set-cookie": await intakeCookie(nonce, null, { clear: true }) },
    ));
  }
  if (!viewer) {
    return identified(html(errorPage(env, "That repository can no longer be read", [
      `${pending.value.repository} may have been deleted, transferred, or made private.`,
      "Start again after confirming that the public repository is available.",
    ]), 403));
  }
  const membership = await technicalTeamMembership(granted.access_token, submitter);
  if (membership.unavailable) {
    console.error("submission-oauth-membership", membership.status);
    if (requestedTechnicalTest) {
      if (!(await deleteState(env, pendingPath, pending.sha,
                              "Discard a test whose membership could not be verified"))) {
        console.error("pending", `could not discard ${pendingPath}`);
      }
      return identified(html(
        errorPage(env, "Submission authorization is temporarily unavailable", spentSignInProblems([
          "Palomar could not confirm that authorization just now.",
        ])),
        503,
        { "set-cookie": await intakeCookie(nonce, null, { clear: true }) },
      ));
    }
  }
  const technicalMaintainer = !membership.unavailable && membership.active;
  if (requestedTechnicalTest && !technicalMaintainer) {
    if (!(await deleteState(env, pendingPath, pending.sha,
                            "Discard a test requested by a nonmember"))) {
      console.error("pending", `could not discard ${pendingPath}`);
    }
    return identified(html(
      errorPage(env, "This submission is not authorized", spentSignInProblems([
        "Choose one of the authorization relationships offered on the submission form.",
      ])),
      403,
      { "set-cookie": await intakeCookie(nonce, null, { clear: true }) },
    ));
  }

  const technicalTest = requestedTechnicalTest || (
    !viewer?.permissions?.push &&
    technicalMaintainer &&
    viewer.private !== true &&
    (pending.value.repository_id == null || viewer.id === pending.value.repository_id)
  );
  if (!viewer?.permissions?.push && !technicalTest) {
    // Deliberately before the pending record is consumed. Consuming first
    // meant a refused submitter lost everything they had typed, undoing the
    // care `beginSubmission` takes to hand it back to them.
    return identified(html(errorPage(env, "You cannot push to that repository", [
      `Palomar asks submitters to prove write access to ${pending.value.repository}.`,
      "If you are submitting someone else's formalization, ask a maintainer to submit it.",
    ]), 403));
  }

  // Anyone with ordinary push access, and each verified Technical
  // Maintainer test, can reach this point. `admitSubmission` exempts every
  // active Technical Maintainer account from the per-principal backoff and
  // owner/submitter caps. The unauthenticated edge throttle remains in front of
  // this flow because identity is not known until OAuth completes.
  const owner = viewer.owner?.login ?? null;
  const admittedPending = technicalTest && !requestedTechnicalTest
    ? {
        ...pending.value,
        authorization_relationship: "technical-test",
        authorization_evidence: null,
      }
    : pending.value;
  const proof = {
    schema_version: 1,
    method: technicalTest ? "technical-team-test" : "oauth",
    binding: technicalTest ? "active-technical-team-membership" : "same-account",
    verified_at: recordedAt(),
    repository_id: viewer.id ?? null,
    commit: pending.value.commit,
    principal,
    ...(technicalMaintainer ? { technical_maintainer: true } : {}),
  };
  const verification = { owner, submitter, proof };
  let admitted;
  try {
    const current = await issueRecoveryLinks(env, {
      pendingPath,
      pendingSha: pending.sha,
      principal,
      verification,
      onlyIfAny: true,
    });
    if (current.submissions.length) {
      return identified(html(submissionsPage(env, {
        submissions: current.submissions,
        pending: pending.value,
        nonce,
      })));
    }
    admitted = await admitSubmission(env, {
      pendingPath,
      pendingSha: pending.sha,
      pending: admittedPending,
      owner,
      submitter,
      proof,
    });
  } catch (error) {
    if (error instanceof StateUpdateOutcomeError) {
      console.error("browser-admission", error.message);
      return identified(html(
        errorPage(env, "Submission intake outcome is unknown", [
          "Do not start another submission yet; ask the registry operator to inspect State.",
        ]),
        503,
        { "set-cookie": await intakeCookie(nonce, null, { clear: true }) },
      ));
    }
    const contractFailure = isDurableContractError(error);
    if (contractFailure) reportDurableContract(error);
    else console.error("browser-admission", error?.stack ?? String(error));
    return identified(html(
      errorPage(
        env,
        contractFailure
          ? "Submission intake is temporarily unavailable"
          : "Submission intake could not be completed",
        spentSignInProblems(["This is ours to fix, not yours."]),
      ),
      contractFailure ? 503 : 500,
      { "set-cookie": await intakeCookie(nonce, null, { clear: true }) },
    ));
  }
  if (admitted.refused) {
    return identified(html(
      errorPage(env, admitted.title, spentSignInProblems(admitted.detail)),
      admitted.status,
      { "set-cookie": await intakeCookie(nonce, null, { clear: true }) },
    ));
  }
  const { token } = admitted;
  return identified(new Response(null, {
    status: 303,
    headers: {
      location: `${new URL(request.url).origin}/s#${token}`,
      // Spent. Leaving it would put a live secret in the browser for fifteen
      // minutes against a record that no longer exists.
      "set-cookie": await intakeCookie(nonce, null, { clear: true }),
      ...SECURITY_HEADERS,
    },
  }));
}

/** Finish a new intake after the authenticated submitter has seen current work. */
async function completeSubmissionChoice(request, env) {
  if (!madeByThisSite(request)) {
    return html(errorPage(env, "That choice did not come from this site", [
      "Return to Palomar's submission form and authenticate again.",
    ]), 403);
  }
  let form;
  try {
    form = await request.formData();
  } catch {
    return html(errorPage(env, "That submission choice could not be read", []), 400);
  }
  const nonce = String(form.get("state") ?? "");
  const replaceId = String(form.get("replace_id") ?? "") || null;
  if (!/^[0-9a-f]{64}$/.test(nonce) || (replaceId && !/^[0-9a-z]{12}$/.test(replaceId))) {
    return html(errorPage(env, "That submission choice is malformed", []), 400);
  }

  const nonceDigest = await digest(nonce);
  const credential = intakeCredential(request, nonceDigest);
  const pendingPath = `pending/${nonceDigest}.json`;
  const pending = await readState(env, pendingPath);
  const presented = credential.kind === "valid" ? credential.value : null;
  const expected = pending.value?.binding_sha256;
  if (
    !pending.value ||
    pending.value.method !== "oauth" ||
    !expected ||
    !presented ||
    (await digest(presented)) !== expected
  ) {
    return html(errorPage(env, "That submission choice expired or opened elsewhere", [
      "Authenticate again to get fresh links and make the choice in this browser.",
    ]), 400, { "set-cookie": await intakeCookie(nonce, null, { clear: true }) });
  }
  const verification = pending.value.oauth_verification;
  const proof = verification?.proof;
  const principal = proof?.principal;
  if (
    typeof verification?.submitter !== "string" ||
    !Number.isSafeInteger(principal?.id) ||
    principal.login !== verification.submitter
  ) {
    return html(errorPage(env, "That submission choice is no longer usable", [
      "Authenticate again before choosing whether to continue or replace earlier work.",
    ]), 409);
  }

  const admittedPending = proof.method === "technical-team-test"
    ? {
        ...pending.value,
        authorization_relationship: "technical-test",
        authorization_evidence: null,
      }
    : pending.value;
  let admitted;
  try {
    admitted = await admitSubmission(env, {
      pendingPath,
      pendingSha: pending.sha,
      pending: admittedPending,
      owner: verification.owner ?? null,
      submitter: verification.submitter,
      proof,
      replaceId,
      preserveOnRefusal: true,
    });
  } catch (error) {
    if (error instanceof StateUpdateOutcomeError) {
      console.error("submission-choice", error.message);
      return html(errorPage(env, "Submission intake outcome is unknown", [
        "Do not make another choice yet; ask the registry operator to inspect State.",
      ]), 503);
    }
    const contractFailure = isDurableContractError(error);
    if (contractFailure) reportDurableContract(error);
    else console.error("submission-choice", error?.stack ?? String(error));
    return html(errorPage(env, "Submission intake is temporarily unavailable", [
      "The earlier submission was not abandoned. Please try again in a moment.",
    ]), contractFailure ? 503 : 500);
  }

  if (admitted.refused) {
    return html(errorPage(env, admitted.title, [
      ...admitted.detail,
      "The earlier submission and its recovery link were not changed. Go back to review it or try this choice again later.",
    ]), admitted.status);
  }

  return new Response(null, {
    status: 303,
    headers: {
      location: `${new URL(request.url).origin}/s#${admitted.token}`,
      "set-cookie": await intakeCookie(nonce, null, { clear: true }),
      ...SECURITY_HEADERS,
    },
  });
}

/**
 * Who is asking, and whether they were allowed to ask this way.
 *
 * Returns the submission entry, or a Response to send instead. Current status
 * pages and agents present a non-ambient bearer token. Legacy clients may
 * still carry a session cookie; mutating endpoints pass `mutating` so those
 * ambient credentials are accepted only from this origin. Reading a review
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
  // A completed registration puts a submitter's interval back to a minute. A
  // small number of first-pass metadata corrections gets the same concession,
  // but repeated failed preflights retain their accumulated backoff.
  // This is where the server sees it: the status page and an agent both poll
  // until the status settles, and `registered` is settled, so the good news and
  // the reset arrive on the same request. Somebody who closes the tab between
  // consenting and that poll waits longer once; opening the link again fixes it.
  // The alternative, letting the reviewer reset it, would need TOKEN_PEPPER in
  // reviewer CI, and that pepper exists so a leaked state repository yields no
  // live links.
  if (["registered", "changes-required"].includes(record.status)
      && !record.rate_reset_at && record.push_proof?.principal?.id) {
    const path = await ratePath(env, record.push_proof.principal.id);
    const resetAt = recordedAt();
    // Absence already admits the next start at the floor. Do not synthesize a
    // partial document without the historical fields required of every
    // present rate record; a malformed present document fails closed.
    let current;
    let projected = null;
    try {
      current = await readRateState(env, path);
      const correctionConcession = record.status === "changes-required"
        && current.value?.starts <= 2;
      if (current.sha !== null && (record.status === "registered" || correctionConcession)) {
        projected = atRatePath(path, () => resetRateRecord(current.value, resetAt));
      }
    } catch (error) {
      if (!(error instanceof RateContractError)) throw error;
      // Resetting an auxiliary backoff is conservative: leaving it unapplied
      // cannot admit another start early. Keep the registered result visible
      // and leave the marker unset so repairing the file makes a later poll
      // retry the reset.
      reportDurableContract(error);
      return record;
    }
    if (projected !== null) {
      await writeState(
        env,
        path,
        projected,
        `Reset after ${record.status}`,
        current.sha,
      ).catch(() => {});
    }
    const reset = { ...record, rate_reset_at: resetAt };
    await writeState(env, statePath(record.id, "state.json"), reset,
                     `Reset the interval for ${record.id}`, entry.sha).catch(() => {});
    return reset;
  }
  const phase = activeSubmissionPhase(record);
  if (!phase) return record;
  const { run } = await findVerificationRun(env, record.id, {
    pinnedRunId: record[phase.runField]?.id ?? null,
    since: record.created_at,
    mode: phase.mode,
  });
  if (!run) return record;
  // The run is pinned the first time it is seen. A second run carrying the
  // same public submission id must not be able to take its place.
  if (record[phase.runField]?.id && record[phase.runField].id !== run.id) return record;

  // Finding it retires the outbox lease: this run is now the one durable thing
  // every later refresh asks for, so no path may dispatch another by name.
  const next = { ...record, [phase.runField]: run };
  delete next[phase.missesField];
  delete next[phase.leaseAtField];
  delete next[phase.leaseCountField];
  if (run.status === "completed") {
    if (phase.mode === "preflight" && run.conclusion === "success") {
      const queuedAt = recordedAt();
      next.status = "verifying";
      next.dispatch_lease_at = queuedAt;
      next.dispatch_lease_count = 1;
      next.events = [
        ...record.events,
        { at: queuedAt, status: "verifying", note: "Preflight passed; verification queued" },
      ];
      await writeState(
        env,
        statePath(record.id, "state.json"),
        next,
        `Queue full verification for ${record.id}`,
        entry.sha,
      );
      await dispatchSubmissionVerification(env, next, "full").catch((error) => {
        console.error("verification-dispatch", error?.stack ?? String(error));
      });
      return next;
    }
    next.status = phase.mode === "preflight"
      ? "preflight-reporting"
      : run.conclusion === "success" ? "awaiting-review" : "verification-reporting";
    next.events = [
      ...record.events,
      {
        at: recordedAt(),
        status: next.status,
        note: `${phase.mode === "preflight" ? "Preflight" : "Verification"} ${run.conclusion}`,
      },
    ];
  }
  if (!activeSubmissionPhase(next) && activeSubmissionPhase(record)) {
    // Validate the capacity contract before another index can be changed. The
    // release itself deliberately re-reads after queueing, so it does not carry
    // this older optimistic SHA across the intervening work.
    await assertInflightContract(env);
  }
  const handoffToReviewer = [
    "awaiting-review", "preflight-reporting", "verification-reporting",
  ].includes(next.status);
  if (handoffToReviewer) {
    // Before the record says `awaiting-review`, and not caught. A submission
    // that settles without an entry in the reviewer's queue is one nothing
    // looks at until the weekly rebuild, and a failure swallowed here leaves a
    // record that will not be repaired sooner than that, because it no longer
    // looks like it needs anything. Failing leaves it `verifying`, which the
    // next pass retries.
    await openSubmission(env, record.id);
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
  if (handoffToReviewer) {
    // Dispatch only after the reporting/reviewing state is durable. A runner
    // can start immediately; waking it while the record still says
    // `preflighting` or `verifying` makes that successful wake-up a no-op.
    // The schedule remains the backstop for a rejected dispatch.
    await dispatchReviewer(env).catch(() => false);
  }
  if (!activeSubmissionPhase(next) && activeSubmissionPhase(record)) {
    // Commit the terminal state before releasing capacity. If the fresh
    // compare-and-swap release then fails, scheduled reconciliation sees the
    // non-verifying record and drops the stale reservation. Releasing first
    // could instead leave a verifying record outside the only set reconciliation
    // walks.
    await release(env, record.id);
  }
  return next;
}

export default {
  /**
   * A cron handler has no submitter waiting on it and no response anyone reads,
   * so delegate to maintenance that attempts every task and throws after any
   * failure. The platform can then record a failure instead of silently letting
   * admission slots or abandoned intake accumulate.
   */
  async scheduled(event, env) {
    await scheduledMaintenance(env);
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
        const identity = await githubIdentityPrincipal(request, env);
        return html(intakeForm(env, {}, [], { automaticRecovery: Boolean(identity) }));
      }
      if (request.method === "GET" && url.pathname === "/dashboard/login") {
        return (
          (await intakeThrottle(env, request)) ??
          (await beginDashboardLogin(request, env))
        );
      }
      if (request.method === "GET" && url.pathname === "/dashboard") {
        const principal = await dashboardPrincipal(request, env);
        if (!principal) {
          return new Response(null, {
            status: 303,
            headers: { ...SECURITY_HEADERS, location: "/dashboard/login" },
          });
        }
        const report = await operationalDashboard(env);
        if (report.kind === "missing") {
          return html(errorPage(env, "The operational report is not ready", []), 503);
        }
        if (report.kind === "invalid") {
          return html(errorPage(env, "The operational report needs repair", []), 503);
        }
        if (report.kind === "unavailable") {
          return html(errorPage(env, "The operational report is temporarily unavailable", []), 503);
        }
        return html(dashboardHtml(report.value, principal));
      }
      if (request.method === "GET" && url.pathname === "/api/dashboard") {
        if (!madeByThisSite(request)) {
          return json({ error: "that request did not come from this site" }, 403);
        }
        const principal = await dashboardPrincipal(request, env);
        if (!principal) return json({ error: "authentication required" }, 401);
        const report = await operationalDashboard(env);
        if (report.kind === "missing") return json({ error: "operational report is not ready" }, 503);
        if (report.kind === "invalid") return json({ error: "operational report needs repair" }, 503);
        if (report.kind === "unavailable") {
          return json({ error: "operational report is temporarily unavailable" }, 503);
        }
        return json(report.value);
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
      if (request.method === "POST" && url.pathname === "/api/submissions") {
        return automaticSubmissions(request, env);
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
      if (request.method === "GET" && url.pathname === "/submissions") {
        if (!madeByThisSite(request)) {
          return html(errorPage(env, "Submission recovery did not begin here", [
            "Open Palomar directly and choose ‘Find my submissions in progress’.",
          ]), 403);
        }
        return (
          (await intakeThrottle(env, request)) ?? (await beginRecovery(request, env))
        );
      }
      if (request.method === "POST" && url.pathname === "/submissions/open") {
        return (
          (await intakeThrottle(env, request)) ??
          (await openAutomaticSubmission(request, env))
        );
      }
      if (request.method === "POST" && url.pathname === "/submission-choice") {
        return completeSubmissionChoice(request, env);
      }
      if (request.method === "GET" && url.pathname === "/oauth/callback") {
        if ((url.searchParams.get("state") ?? "").startsWith("dashboard_")) {
          return (
            (await intakeThrottle(env, request)) ??
            (await completeDashboardLogin(request, env))
          );
        }
        return (
          (await intakeThrottle(env, request)) ??
          (await completeSubmission(request, env))
        );
      }
      if (request.method === "GET" && url.pathname === "/s") {
        // The token is in the fragment, which browsers never send. The page
        // presents its own token on every private request, so another status
        // tab cannot replace the credential it uses.
        return html(statusPage(env));
      }
      if (request.method === "POST" && url.pathname === "/session") {
        // The same fault as /submit, and the same answer. A JSON body makes
        // `formData()` throw, and the throw used to be answered with the 500
        // page that blames Palomar and invites a retry that cannot work. This
        // legacy endpoint accepts a form; a body it cannot read came from
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
            reportDurableContract(error);
            return json({ error: "submission decisions are temporarily unavailable" }, 503);
          }
        }
        const next = {
          ...entry.record,
          status: "withdrawn",
          events: [...entry.record.events,
                   { at: recordedAt(), status: "withdrawn", note: "Withdrawn by the submitter" }],
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
        if (isTechnicalTest(entry.record)) {
          return json({
            error: "registration would be allowed if this were not a test submission",
          }, 409);
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
          registration_consent_at: recordedAt(),
          events: [...entry.record.events,
                   { at: recordedAt(), status: entry.record.status,
                     note: "The submitter asked for this result to be registered" }],
        };
        await writeState(env, statePath(next.id, "state.json"), next,
                         `Registration consent for ${next.id}`, entry.sha);
        // The submitter has just decided; do not make them wait on a cron.
        await dispatchReviewer(env).catch(() => false);
        return json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/repair") {
        const entry = await caller(env, request, { mutating: true });
        if (entry instanceof Response) return entry;
        if (isTechnicalTest(entry.record)) {
          return json({ error: "a test submission does not open repair pull requests" }, 409);
        }
        const body = await request.json().catch(() => null);
        const profileVersion = body?.profile_version === 2 ? 2 : 1;
        let edits;
        try {
          edits = normalizedQueuedRepairEdits(body?.edits, profileVersion, REPAIR_TAXONOMIES);
        } catch (error) {
          return json({ error: error.message }, 400);
        }
        const failureDigest = typeof body?.failure_digest === "string"
          ? body.failure_digest : "";
        if (!/^[0-9a-f]{64}$/.test(failureDigest)) {
          return json({ error: "failure_digest must identify the current failure report" }, 400);
        }
        if (!entry.record.failure || await digest(JSON.stringify(entry.record.failure)) !== failureDigest) {
          return json({ error: "the failure report changed; reload before requesting a repair" }, 409);
        }
        const id = entry.record.id;
        const recordPath = statePath(id, "state.json");
        const repairPath = statePath(id, "repair.json");
        const requestedAt = recordedAt();
        const revision = (await digest(JSON.stringify({ id, failureDigest, edits }))).slice(0, 16);
        let result;
        try {
          result = await transactState(
            env,
            [recordPath, repairPath, REPAIR_INDEX_PATH],
            (files) => {
            const current = files[recordPath]?.value;
            if (!current || current.status !== "changes-required") {
              return { changes: [], message: "", result: { error: "this submission no longer accepts a repair request", status: 409 } };
            }
            // WebCrypto is asynchronous, so the digest was checked immediately
            // before this transaction and the record's immutable terminal
            // status/failure object is rechecked below by exact serialization.
            if (JSON.stringify(current.failure) !== JSON.stringify(entry.record.failure)) {
              return { changes: [], message: "", result: { error: "the failure report changed; reload before requesting a repair", status: 409 } };
            }
            if (current.failure?.profile_version !== profileVersion) {
              return { changes: [], message: "", result: { error: "this failure uses a metadata profile Palomar cannot repair automatically", status: 409 } };
            }
            const diagnostics = current.failure?.diagnostics ?? [];
            const allowed = new Set(
              diagnostics
                .filter((item) => item?.repairable === true)
                .map((item) => item.field),
            );
            if (edits.some((edit) => !allowed.has(edit.field))) {
              return { changes: [], message: "", result: { error: "one of these fields is not repairable for the current failure", status: 409 } };
            }
            const completeGuidedFailure = diagnostics.length > 0 && diagnostics.every((item) =>
              item?.owner === "submitter" && item?.repairable === true && allowed.has(item.field));
            if (profileVersion === 2 && (
              !completeGuidedFailure || edits.length !== allowed.size
            )) {
              return { changes: [], message: "", result: { error: "complete every field in the guided metadata repair", status: 409 } };
            }
            if (files[repairPath]?.sha !== null || current.repair) {
              return { changes: [], message: "", result: { error: "a repair request already exists for this submission", status: 409 } };
            }
            const queueEntry = files[REPAIR_INDEX_PATH];
            const open = repairOpen(queueEntry?.value);
            const repair = {
              schema_version: profileVersion,
              submission_id: id,
              revision,
              status: "queued",
              requested_at: requestedAt,
              source: {
                repository: current.repository,
                commit: current.commit,
                formalization_path: formalizationPath(current),
              },
              failure_digest: failureDigest,
              edits,
            };
            const next = {
              ...current,
              repair: { revision, status: "queued" },
              events: [...current.events, {
                at: requestedAt,
                status: current.status,
                note: "The submitter asked Palomar to prepare a formalization.yaml pull request",
              }],
            };
            return {
              changes: [
                { path: recordPath, value: next },
                { path: repairPath, value: repair },
                { path: REPAIR_INDEX_PATH, value: { ...queueEntry.value, open: [...open, id] } },
              ],
              message: `Queue metadata repair for ${id}`,
              result: { ok: true, revision },
            };
            },
          );
        } catch (error) {
          if (!isDurableContractError(error)) throw error;
          reportDurableContract(error);
          return json({
            error: "metadata repair is temporarily unavailable; your values were not queued, so keep them and try again",
          }, 503);
        }
        if (result.error) return json({ error: result.error }, result.status);
        await dispatchRepairer(env).catch(() => false);
        return json(result, 202);
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
        const failureDigest = record.failure
          ? await digest(JSON.stringify(record.failure))
          : null;
        const repairEntry = record.repair
          ? await readState(env, statePath(record.id, "repair.json"))
          : null;
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
          preflight_run: record.preflight_run ?? null,
          run: record.run ?? null,
          failure: record.failure ?? null,
          failure_digest: failureDigest,
          repair: record.repair
            ? submitterRepair(repairEntry?.value) ?? {
                revision: record.repair.revision,
                status: "failed",
                explanation: (
                  "Palomar could not retrieve the repair request. Update formalization.yaml " +
                  "manually, or ask an operator to inspect this submission."
                ),
              }
            : null,
          review_started_at: record.review_started_at ?? null,
          typical_review_seconds: await typicalReviewSeconds(env),
          registration_consent: record.registration_consent === true,
          test_submission: isTechnicalTest(record),
          // This lets a page that becomes visible again notice that the review
          // it rendered has been replaced before offering consent for it.
          review_sha256:
            record.status === "review-ready" ? record.review_sha256 ?? null : null,
          // A registered page may label only the exact review whose bytes the
          // submitter consented to as part of the public record. A later State
          // rewrite must fail closed in presentation rather than inheriting
          // that statement.
          registration_consent_review_sha256:
            record.status === "registered"
              ? record.registration_consent_review_sha256 ?? null
              : null,
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
