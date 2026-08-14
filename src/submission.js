/**
 * Submission identity, secrets, and the shape of a submission record.
 *
 * Two identifiers, deliberately distinct. The submission id names a directory
 * in the state repository and is not secret. The access token is what lets
 * whoever holds it see a private review and register or withdraw, so it never
 * appears in the state repository, only its digest does, and it never reaches
 * the server in a URL path where it would land in request logs.
 */

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function randomBytes(count) {
  return crypto.getRandomValues(new Uint8Array(count));
}

export function newSubmissionId() {
  return [...randomBytes(12)].map((b) => ID_ALPHABET[b % 36]).join("");
}

export function newAccessToken() {
  return [...randomBytes(32)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function digest(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The pepper, which every peppered digest must go through.
 *
 * `?? ""` meant a deployment that lost this secret kept working, and kept
 * working consistently: tokens still hashed, still matched, still found their
 * records. Nothing downstream could tell, and the property the pepper exists
 * for would have been gone with no symptom at all. Losing a secret is a
 * configuration error and now fails like one.
 */
export function pepper(env) {
  if (!env.TOKEN_PEPPER) throw new Error("TOKEN_PEPPER is unset");
  return env.TOKEN_PEPPER;
}

/** Tokens are peppered so a leaked state repository does not yield live links. */
export async function tokenDigest(env, token) {
  return digest(`${pepper(env)}:${token}`);
}

/** A canonical whole-second timestamp for durable record fields and events. */
export function recordedAt() {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

// Defined in one place and shared with the browser, so the form, its live
// checks and this server cannot disagree about what a submitted value means.
export {
  COMMIT_RE,
  PALOMAR_ID_RE,
  REPOSITORY_RE,
  normalizeCommit,
  normalizePalomarId,
  normalizeRepository,
  normalizeRepositoryPath,
} from "../public/normalize.js";

export function statePath(id, name) {
  return `submissions/${id}/${name}`;
}

export const STATUSES = {
  preflighting: "Checking the repository before full verification",
  "preflight-reporting": "Preparing the preflight results",
  "changes-required": "Repository changes are required",
  "preflight-failed": "Palomar could not complete preflight",
  verifying: "Mechanically verifying the submission",
  "verification-reporting": "Preparing the verification results",
  "verification-failed": "Mechanical verification did not pass",
  "verification-error": "Palomar could not complete mechanical verification",
  "awaiting-review": "Waiting for the automated review",
  reviewing: "The automated review is running",
  "review-ready": "The automated review is ready for you",
  "review-failed": "The automated review could not be completed",
  "registration-paused": "Registration needs operator attention",
  "dispatch-lost": "Palomar lost track of the verification run it started",
  registered: "Registered in the registry",
  withdrawn: "Withdrawn",
};

/**
 * The event a scrubbed withdrawal appends, so the audit trail says it happened.
 *
 * It carries the withdrawn status rather than a status of its own: State
 * validation requires the last event to name the record's current status, and
 * inventing a `scrubbed` status here would put every withdrawn record outside
 * the contract it is validated against.
 */
export const WITHDRAWAL_SCRUB_NOTE = "Identifying details removed on withdrawal";

/**
 * A withdrawn record, with what identified its submitter taken out of it.
 *
 * Withdrawal used to change one word and append an event, so the record went
 * on holding the submitter's login, whatever they typed in the notes field —
 * which is free text and can name people who never submitted anything — and
 * whatever they typed to evidence their authorization, for as long as the
 * registry exists. Nothing reads any of it once the submission is closed, and
 * what the submitter asked for was for the submission to stop.
 *
 * The numeric principal stays, and it is the one field here that has to.
 * Recovery intersects `index/principals/<digest>.json` with the reviewer's
 * queue and then verifies the numeric principal stored in every record it
 * selected, before it filters the closed ones out. A withdrawn record stays in
 * that queue until the reviewer's next pass drops it, so a record with no
 * principal would not read as "closed, ignore it" but as a locator naming
 * somebody else's submission, which fails closed and takes the whole recovery
 * page down with it for as long as the id is queued. Replacement checks the
 * same field before it refuses to replace something already closed. The number
 * on its own names nobody: it is the value the principal and rate paths are
 * peppered digests of precisely so that neither directory enumerates anyone,
 * and everything beside it that made it a person is now gone.
 *
 * Git history keeps what was committed before this. Scrubbing the current tree
 * is what stops every later read, sweep, clone, and index rebuild carrying it
 * forward; the residue in history is disclosed in the retention documentation
 * rather than pretended away.
 */
export function withdrawnRecord(record, { at, note }) {
  const scrubbed = {
    ...record,
    status: "withdrawn",
    // Both are fields every record carries, so they are emptied rather than
    // removed: null is what intake already writes for notes nobody gave.
    submitter: null,
    context: null,
    events: [
      ...record.events,
      { at, status: "withdrawn", note },
      { at, status: "withdrawn", note: WITHDRAWAL_SCRUB_NOTE },
    ],
  };
  // These two are absent rather than null on a record that never had them, so
  // a scrub that wrote null would invent a shape no intake produces. The
  // copies matter: the record passed in is the value a caller still holds.
  if (scrubbed.authorization) {
    scrubbed.authorization = { ...scrubbed.authorization };
    delete scrubbed.authorization.evidence;
  }
  if (scrubbed.push_proof?.principal) {
    scrubbed.push_proof = {
      ...scrubbed.push_proof,
      principal: { ...scrubbed.push_proof.principal },
    };
    delete scrubbed.push_proof.principal.login;
  }
  return scrubbed;
}

export function newRecord({
  id, repositoryName, commit, owner, submitter, existingId, context, authorization,
  requestedPaths = {}, testSubmission = false,
}) {
  return {
    schema_version: 1,
    id,
    status: "verifying",
    repository: repositoryName,
    commit,
    owner,
    submitter,
    push_verified: !testSubmission,
    ...(testSubmission ? { test_submission: true } : {}),
    existing_id: existingId || null,
    context: context || null,
    // What the submitter asked to be verified, which the reviewer binds the
    // mechanical report against.
    requested_paths: {
      project_path: requestedPaths.project_path || "",
      comparator_config_path: requestedPaths.comparator_config_path || "",
      formalization_metadata_path: requestedPaths.formalization_metadata_path || "",
    },
    authorization,
    created_at: null,
    events: [],
  };
}
