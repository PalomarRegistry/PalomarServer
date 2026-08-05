/**
 * Submission identity, secrets, and the shape of a submission record.
 *
 * Two identifiers, deliberately distinct. The submission id names a directory
 * in the state repository and is not secret. The access token is what lets
 * whoever holds it see a private review and publish or withdraw, so it never
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

export const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const COMMIT_RE = /^[0-9a-f]{40}$/;
export const PALOMAR_ID_RE = /^PALOMAR-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}$/;

/**
 * Accept a repository as owner/name from either a bare pair or a GitHub URL.
 * Anything else is refused rather than guessed at.
 */
export function parseRepository(raw) {
  const value = String(raw ?? "").trim().replace(/\.git$/, "").replace(/\/+$/, "");
  if (REPOSITORY_RE.test(value)) return value;
  const match = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(value);
  return match ? match[1] : null;
}

export function statePath(id, name) {
  return `submissions/${id}/${name}`;
}

export const STATUSES = {
  verifying: "Mechanically verifying the submission",
  "verification-failed": "Mechanical verification did not pass",
  "awaiting-review": "Waiting for editorial review",
  "review-ready": "The editorial review is ready for you",
  published: "Published to the registry",
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
