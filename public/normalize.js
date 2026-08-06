/**
 * How a submitted value is read, defined once.
 *
 * A submission is checked in three places: by the browser's own validation of
 * the `pattern` attribute, by the live checks beside each field, and by the
 * server. If those disagree about what a value means, a submitter is told
 * their commit was found and then that it does not match the requested format,
 * which is what happens when the same string is trimmed by two of the three.
 *
 * This module is imported by the browser and bundled into the Worker, so there
 * is one definition rather than three that have to be kept in step.
 */

export const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const COMMIT_RE = /^[0-9a-f]{40}$/;
export const PALOMAR_ID_RE = /^PALOMAR-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}$/;

/**
 * A repository as `owner/name`, from a bare pair or a GitHub URL, or null.
 *
 * Anything else is refused rather than guessed at.
 */
export function normalizeRepository(raw) {
  const value = String(raw ?? "").trim().replace(/\.git$/, "").replace(/\/+$/, "");
  if (REPOSITORY_RE.test(value)) return value;
  const match = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(value);
  return match ? match[1] : null;
}

/** A full commit, lowercased, or null. Abbreviations are not commits. */
export function normalizeCommit(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  return COMMIT_RE.test(value) ? value : null;
}

/** A Palomar identifier, uppercased, or null. */
export function normalizePalomarId(raw) {
  const value = String(raw ?? "").trim().toUpperCase();
  return PALOMAR_ID_RE.test(value) ? value : null;
}
