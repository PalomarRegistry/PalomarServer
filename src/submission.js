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
  "dispatch-lost": "Palomar lost track of the verification run it started",
  registered: "Registered in the registry",
  withdrawn: "Withdrawn",
};

export function newRecord({
  id, repositoryName, commit, owner, submitter, existingId, context, authorization,
  requestedPaths = {},
}) {
  return {
    schema_version: 1,
    id,
    status: "preflighting",
    repository: repositoryName,
    commit,
    owner,
    submitter,
    push_verified: true,
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
