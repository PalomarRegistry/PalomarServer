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

/** Tokens are peppered so a leaked state repository does not yield live links. */
export async function tokenDigest(env, token) {
  return digest(`${env.TOKEN_PEPPER ?? ""}:${token}`);
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
  verifying: "Mechanically verifying the submission",
  "verification-failed": "Mechanical verification did not pass",
  "awaiting-review": "Waiting for the automated review",
  reviewing: "The automated review is running",
  "review-ready": "The automated review is ready for you",
  "review-failed": "The automated review could not be completed",
  registered: "Registered in the registry",
  withdrawn: "Withdrawn",
};

export function newRecord({
  id, repositoryName, commit, owner, submitter, existingId, context, authorization,
}) {
  return {
    schema_version: 1,
    id,
    status: "verifying",
    repository: repositoryName,
    commit,
    owner,
    submitter,
    push_verified: true,
    existing_id: existingId || null,
    context: context || null,
    authorization,
    created_at: null,
    events: [],
  };
}
