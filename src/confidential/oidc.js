/**
 * Validation of GitHub Actions OIDC tokens presented to the confidential broker
 * (contract v2 section 3.2).
 *
 * Every rule in the contract's claim list must hold; the first that does not
 * refuses the token. Refusal is one opaque answer to the caller, and the
 * reason goes only to the Worker log, so a probe learns nothing about which
 * check it failed. A token that fails here never reaches a ticket, so an
 * invalid JWT can never poison one.
 *
 * The workflow identity rows are the operation matrix of section 3.2:
 *
 *   operation   repository             caller workflow                     called (pinned) workflow
 *   snapshot    PalomarConfidentialRuns verify.yml                          PalomarSubmission confidential-snapshot.yml@P
 *   validate    PalomarConfidentialRuns verify.yml                          PalomarSubmission confidential-validate.yml@P
 *   restore     PalomarConfidentialRuns render.yml or verify.yml            PalomarSubmission confidential-restore.yml@P
 *   restore, evidence, publish
 *               PalomarSubmissionState  reviewer.yml                        PalomarReviewer confidential-objects.yml@R
 */

import { digest } from "../submission.js";

export const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const OIDC_AUDIENCE = "https://submit.palomar-registry.org/confidential";
const JWKS_URL = `${OIDC_ISSUER}/.well-known/jwks`;
const JWKS_TTL_MS = 60 * 60_000;
const SKEW_S = 60;
const MAX_LIFETIME_S = 10 * 60;
const MAIN = "refs/heads/main";
const SHA_RE = /^[0-9a-f]{40}$/;

export const OPERATIONS = Object.freeze(["snapshot", "validate", "restore", "evidence", "publish"]);

export class OidcRefusal extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function refuse(reason) {
  throw new OidcRefusal(reason);
}

function base64UrlBytes(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) refuse("malformed");
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - (text.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return refuse("malformed");
  }
}

function base64UrlJson(text) {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(base64UrlBytes(text)));
    if (!value || typeof value !== "object" || Array.isArray(value)) refuse("malformed");
    return value;
  } catch (error) {
    if (error instanceof OidcRefusal) throw error;
    return refuse("malformed");
  }
}

// One cache per isolate: at most an hour old, refetched once on an unknown kid.
let jwksCache = null;

/** For tests: forget the cached key set. */
export function resetJwksCache() {
  jwksCache = null;
}

async function fetchJwks(now) {
  const response = await fetch(JWKS_URL, { headers: { accept: "application/json" } });
  if (!response.ok) refuse("jwks-unavailable");
  const body = await response.json().catch(() => null);
  if (!Array.isArray(body?.keys)) refuse("jwks-unavailable");
  jwksCache = { at: now, keys: body.keys };
  return jwksCache.keys;
}

async function signingKey(kid, now) {
  const cached = jwksCache && now - jwksCache.at < JWKS_TTL_MS;
  let keys = cached ? jwksCache.keys : await fetchJwks(now);
  let jwk = keys.find((key) => key?.kid === kid);
  // An unknown kid may be a key GitHub rotated in since the cache was filled,
  // so a cached set is refetched once; a set fetched for this call is not.
  if (!jwk && cached) {
    keys = await fetchJwks(now);
    jwk = keys.find((key) => key?.kid === kid);
  }
  if (!jwk || jwk.kty !== "RSA" || (jwk.alg !== undefined && jwk.alg !== "RS256") ||
      (jwk.use !== undefined && jwk.use !== "sig")) {
    refuse("unknown-kid");
  }
  try {
    return await crypto.subtle.importKey(
      "jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
    );
  } catch {
    return refuse("unknown-kid");
  }
}

/** Verify the signature and the time and issuer claims; return the claims. */
export async function verifyJwt(token, { now = Date.now() } = {}) {
  if (typeof token !== "string" || token.length > 16_384) refuse("malformed");
  const parts = token.split(".");
  if (parts.length !== 3) refuse("malformed");
  const header = base64UrlJson(parts[0]);
  // RS256 only. `none`, HMAC and every other algorithm are refused before any
  // key is looked up, so no algorithm confusion can reach verification.
  if (header.alg !== "RS256") refuse("alg");
  if (header.typ !== undefined && header.typ !== "JWT") refuse("typ");
  if (typeof header.kid !== "string" || !header.kid) refuse("kid");
  if (header.crit !== undefined) refuse("crit");
  const key = await signingKey(header.kid, now);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, base64UrlBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) refuse("signature");
  const claims = base64UrlJson(parts[1]);
  const seconds = Math.floor(now / 1000);
  if (claims.iss !== OIDC_ISSUER) refuse("iss");
  if (claims.aud !== OIDC_AUDIENCE) refuse("aud");
  for (const name of ["exp", "iat", "nbf"]) {
    if (!Number.isSafeInteger(claims[name])) refuse(name);
  }
  if (claims.exp <= seconds) refuse("exp");
  if (claims.iat > seconds + SKEW_S) refuse("iat");
  if (claims.nbf > seconds + SKEW_S) refuse("nbf");
  if (claims.exp - claims.iat > MAX_LIFETIME_S) refuse("lifetime");
  return claims;
}

function list(value) {
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function numericId(value, name) {
  const text = String(value ?? "");
  if (!/^[1-9][0-9]{0,15}$/.test(text)) throw new Error(`${name} is not configured`);
  return text;
}

/**
 * The workflow identity rows, built from the Worker's configuration. Numeric
 * repository and owner ids are Worker vars, so a rename or transfer cannot
 * redirect a row.
 */
export function identityRows(env) {
  const org = String(env.PALOMAR_ORG ?? "PalomarRegistry");
  const runs = env.CONFIDENTIAL_RUNS_REPO;
  const submission = env.SUBMISSION_REPO;
  const state = env.STATE_REPO;
  const reviewer = env.CONFIDENTIAL_REVIEWER_REPO ?? `${org}/PalomarReviewer`;
  const runsId = numericId(env.CONFIDENTIAL_RUNS_REPOSITORY_ID, "CONFIDENTIAL_RUNS_REPOSITORY_ID");
  const stateId = numericId(env.STATE_REPOSITORY_ID, "STATE_REPOSITORY_ID");
  const caller = (file) => `${runs}/.github/workflows/${file}@${MAIN}`;
  const called = (file) => `${submission}/.github/workflows/${file}@`;
  const runsRow = (operation, callers, file) => ({
    operation, origin: "runs", repository_id: runsId, repository: runs,
    workflow_refs: callers.map(caller), job_workflow_prefix: called(file),
    events: ["workflow_dispatch"],
  });
  return [
    runsRow("snapshot", ["verify.yml"], "confidential-snapshot.yml"),
    runsRow("validate", ["verify.yml"], "confidential-validate.yml"),
    runsRow("restore", ["render.yml", "verify.yml"], "confidential-restore.yml"),
    ...["restore", "evidence", "publish"].map((operation) => ({
      operation, origin: "state", repository_id: stateId, repository: state,
      workflow_refs: [`${state}/.github/workflows/reviewer.yml@${MAIN}`],
      job_workflow_prefix: `${reviewer}/.github/workflows/confidential-objects.yml@`,
      events: ["workflow_dispatch", "schedule"],
    })),
  ];
}

/**
 * Validate a broker JWT for one operation.
 *
 * `callerMatches({workflowRef, workflowSha, pipelineCommit})` checks, for the
 * runs repository, that the caller file at the token's `workflow_sha` is the
 * canonical template with pin P; it is injected so the dispatch credential
 * stays with the caller of this function.
 *
 * `isRevoked({kind, commit})` answers whether `ConfidentialControl` has
 * revoked a Submission revision P (`kind: "pipeline"`) or a Reviewer
 * revision R (`kind: "reviewer"`). Contract v2.1 makes Control the only
 * revocation source: the Worker vars only say which revisions may ever be
 * used, and a missing check refuses, so no caller can skip it.
 *
 * Answers `{origin, operation, pipeline_commit | reviewer_commit, binding,
 * identity}`; throws `OidcRefusal` otherwise.
 */
export async function validateBrokerToken(env, token, operation,
  { now = Date.now(), callerMatches, isRevoked } = {}) {
  if (!OPERATIONS.includes(operation)) refuse("operation");
  const claims = await verifyJwt(token, { now });
  if (String(claims.repository_owner_id ?? "") !== numericId(env.PALOMAR_ORG_ID, "PALOMAR_ORG_ID")) {
    refuse("owner");
  }
  if (claims.repository_visibility !== "private") refuse("visibility");
  if (claims.ref !== MAIN) refuse("ref");
  if (claims.runner_environment !== "github-hosted") refuse("runner");
  const rows = identityRows(env).filter((row) => row.operation === operation);
  const row = rows.find((candidate) =>
    String(claims.repository_id ?? "") === candidate.repository_id &&
    claims.repository === candidate.repository &&
    candidate.workflow_refs.includes(claims.workflow_ref) &&
    typeof claims.job_workflow_ref === "string" &&
    claims.job_workflow_ref.startsWith(candidate.job_workflow_prefix) &&
    candidate.events.includes(claims.event_name));
  if (!row) refuse("identity");
  const pinned = claims.job_workflow_ref.slice(row.job_workflow_prefix.length);
  if (!SHA_RE.test(pinned) || claims.job_workflow_sha !== pinned) refuse("pin");
  for (const name of ["run_id", "run_attempt"]) {
    if (!/^[1-9][0-9]{0,18}$/.test(String(claims[name] ?? ""))) refuse(name);
  }
  if (!SHA_RE.test(String(claims.workflow_sha ?? ""))) refuse("workflow_sha");
  const binding = {
    run_id: String(claims.run_id),
    run_attempt: String(claims.run_attempt),
    repository_id: row.repository_id,
  };
  const identity = {
    repository_id: row.repository_id,
    workflow: claims.job_workflow_ref.slice(0, -41),
    caller: claims.workflow_ref,
  };
  if (row.origin === "runs") {
    if (!list(env.CONFIDENTIAL_PIPELINE_ALLOWLIST).includes(pinned)) refuse("pipeline-not-allowed");
    if (typeof isRevoked !== "function") refuse("revocation-unchecked");
    if (await isRevoked({ kind: "pipeline", commit: pinned })) refuse("pipeline-revoked");
    if (typeof callerMatches !== "function") refuse("caller");
    const workflowFile = claims.workflow_ref.slice(`${row.repository}/.github/workflows/`.length)
      .replace(`@${MAIN}`, "");
    if (!(await callerMatches({ workflowFile, workflowSha: claims.workflow_sha, pipelineCommit: pinned }))) {
      refuse("caller");
    }
    return { origin: "runs", operation, pipeline_commit: pinned, binding, identity };
  }
  if (!list(env.CONFIDENTIAL_REVIEWER_ALLOWLIST).includes(pinned)) refuse("reviewer-not-allowed");
  if (typeof isRevoked !== "function") refuse("revocation-unchecked");
  if (await isRevoked({ kind: "reviewer", commit: pinned })) refuse("reviewer-revoked");
  return { origin: "state", operation, reviewer_commit: pinned, binding, identity };
}

const PLACEHOLDER = "<pipeline-commit>";
const callerCache = new Map();

/**
 * Does the caller file at one commit equal the canonical template at pin P?
 *
 * The file is read from the runs repository with the dispatch credential at
 * the exact `workflow_sha`, P is substituted back by the placeholder, and the
 * result's SHA-256 must equal the template digest the Worker is configured
 * with (`CONFIDENTIAL_CALLER_TEMPLATE_SHA256`, a JSON object by file name).
 * Results are cached by commit, file and P, which are immutable.
 */
export async function callerTemplateMatches(env, { workflowFile, workflowSha, pipelineCommit }) {
  let expected;
  try {
    expected = JSON.parse(env.CONFIDENTIAL_CALLER_TEMPLATE_SHA256 ?? "null")?.[workflowFile];
  } catch {
    return false;
  }
  if (!/^[0-9a-f]{64}$/.test(String(expected ?? ""))) return false;
  if (!SHA_RE.test(workflowSha) || !SHA_RE.test(pipelineCommit) || !/^[a-z-]+\.yml$/.test(workflowFile)) {
    return false;
  }
  const key = `${workflowSha}:${workflowFile}:${pipelineCommit}:${expected}`;
  if (callerCache.has(key)) return callerCache.get(key);
  const response = await fetch(
    `https://api.github.com/repos/${env.CONFIDENTIAL_RUNS_REPO}/contents/.github/workflows/${workflowFile}?ref=${workflowSha}`,
    {
      headers: {
        authorization: `Bearer ${env.SUBMISSION_TOKEN}`,
        accept: "application/vnd.github.raw+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "palomar-server",
      },
    },
  );
  if (!response.ok) return false;
  const text = await response.text();
  // The pin must appear, and only as the pin: every occurrence becomes the
  // placeholder, so a template that also used P elsewhere would not match.
  if (!text.includes(pipelineCommit) || text.includes(PLACEHOLDER)) {
    callerCache.set(key, false);
    return false;
  }
  const matches = (await digest(text.replaceAll(pipelineCommit, PLACEHOLDER))) === expected;
  callerCache.set(key, matches);
  if (callerCache.size > 64) callerCache.delete(callerCache.keys().next().value);
  return matches;
}
