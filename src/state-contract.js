// Pure validation and projection at the boundary with PalomarSubmissionState.
// Durable index reads and optimistic writes stay in submission-lifecycle.js
// and the Worker composition root; route responses stay in the root.

export const INFLIGHT_INDEX_PATH = "index/inflight.json";

// The reviewer's queue: every submission it is not yet finished with. This end
// adds one when it admits a submission; the reviewer drops one when the record
// says there is nothing left to do to it. The reviewer can rebuild the derived
// file from records; this server treats absence or damage as unavailable state.
export const OPEN_INDEX_PATH = "index/open.json";
export const REPAIR_INDEX_PATH = "index/repairs.json";

const SUBMISSION_ID_RE = /^[0-9a-z]{12}$/;
// GitHub.com logins are at most 39 characters. Accept the provider's safe
// alphanumeric/hyphen/underscore envelope rather than reimplementing its
// evolving ordinary and managed-user naming rules after proof has succeeded.
const GITHUB_LOGIN_RE = /^[A-Za-z0-9_-]{1,39}$/;
const UTC_SECONDS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const CURRENT_REVIEW_SCHEMA_VERSION = 3;
const REVIEW_OUTCOMES = new Set(["neutral", "revision_required", "rejected"]);

// Also raised by the lifecycle boundary when an I/O result cannot satisfy this
// contract, so every caller can keep one fail-closed error type.
export class StateContractError extends Error {}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactlyKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalUtcSeconds(value) {
  if (typeof value !== "string" || !UTC_SECONDS_RE.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().replace(/\.\d+Z$/, "Z") === value;
}

/**
 * The one inflight-index shape this pre-launch server writes and reads.
 *
 * Treating an absent or malformed `open` as an empty list silently disables
 * admission limits. Treating an entry without `submitter` as though its owner
 * were the submitter invents an identity the record never established. State
 * that predates this contract must be migrated explicitly instead.
 */
export function inflightOpen(value) {
  if (!plainObject(value) || !hasExactlyKeys(value, ["open"]) || !Array.isArray(value.open)) {
    throw new StateContractError(
      `${INFLIGHT_INDEX_PATH} must contain exactly one top-level open array`,
    );
  }

  const ids = new Set();
  for (const [index, item] of value.open.entries()) {
    const prefix = `${INFLIGHT_INDEX_PATH} open[${index}]`;
    if (!plainObject(item) ||
        !hasExactlyKeys(item, ["id", "owner", "submitter", "at"])) {
      throw new StateContractError(
        `${prefix} must contain exactly id, owner, submitter, and at`,
      );
    }
    if (typeof item.id !== "string" || !SUBMISSION_ID_RE.test(item.id)) {
      throw new StateContractError(`${prefix}.id must be a 12-character submission id`);
    }
    if (ids.has(item.id)) {
      throw new StateContractError(`${prefix}.id duplicates another inflight submission`);
    }
    ids.add(item.id);
    if (item.owner !== null &&
        (typeof item.owner !== "string" || !GITHUB_LOGIN_RE.test(item.owner))) {
      throw new StateContractError(`${prefix}.owner must be a GitHub login or null`);
    }
    if (typeof item.submitter !== "string" || !GITHUB_LOGIN_RE.test(item.submitter)) {
      throw new StateContractError(`${prefix}.submitter must be a GitHub login`);
    }
    if (!canonicalUtcSeconds(item.at)) {
      throw new StateContractError(`${prefix}.at must be a canonical UTC-seconds timestamp`);
    }
  }
  return value.open;
}

/**
 * The reviewer owns the rebuild timestamps beside this queue. The server owns
 * appending ids. Both must refuse a missing or malformed queue instead of
 * replacing it with the one id they happen to know about.
 */
export function reviewerOpen(value) {
  if (!plainObject(value) || value.schema_version !== 1 || !Array.isArray(value.open)) {
    throw new StateContractError(
      `${OPEN_INDEX_PATH} must be a schema-version 1 object with an open array`,
    );
  }
  // The reviewer owns every other top-level field. Preserve those bytes on
  // append, but do not validate data this server neither reads nor writes.
  const ids = new Set();
  for (const [index, id] of value.open.entries()) {
    if (typeof id !== "string" || !SUBMISSION_ID_RE.test(id)) {
      throw new StateContractError(`${OPEN_INDEX_PATH} open[${index}] is not a submission id`);
    }
    if (ids.has(id)) {
      throw new StateContractError(`${OPEN_INDEX_PATH} open[${index}] is duplicated`);
    }
    ids.add(id);
  }
  return value.open;
}

/** The private, pepper-keyed locator used to recover one principal's work. */
export function principalSubmissions(value, path) {
  if (!plainObject(value) || !hasExactlyKeys(value, ["schema_version", "submissions"]) ||
      value.schema_version !== 1 || !Array.isArray(value.submissions)) {
    throw new StateContractError(
      `${path} must contain exactly schema_version 1 and a submissions array`,
    );
  }
  const ids = new Set();
  for (const [index, id] of value.submissions.entries()) {
    if (typeof id !== "string" || !SUBMISSION_ID_RE.test(id)) {
      throw new StateContractError(`${path}.submissions[${index}] is not a submission id`);
    }
    if (ids.has(id)) {
      throw new StateContractError(`${path}.submissions[${index}] is duplicated`);
    }
    ids.add(id);
  }
  return value.submissions;
}

/** The repair worker's durable outbox, with the same fail-closed rules as review. */
export function repairOpen(value) {
  if (!plainObject(value) || value.schema_version !== 1 || !Array.isArray(value.open)) {
    throw new StateContractError(
      `${REPAIR_INDEX_PATH} must be a schema-version 1 object with an open array`,
    );
  }
  const ids = new Set();
  for (const [index, id] of value.open.entries()) {
    if (typeof id !== "string" || !SUBMISSION_ID_RE.test(id)) {
      throw new StateContractError(`${REPAIR_INDEX_PATH} open[${index}] is not a submission id`);
    }
    if (ids.has(id)) throw new StateContractError(`${REPAIR_INDEX_PATH} open[${index}] is duplicated`);
    ids.add(id);
  }
  return value.open;
}

export function isCurrentReview(review, submissionId) {
  return plainObject(review) && review.schema_version === CURRENT_REVIEW_SCHEMA_VERSION &&
    review.submission_id === submissionId && REVIEW_OUTCOMES.has(review.outcome);
}

/** Fields from a private mechanical review that its submitter may see. */
export function submitterReview(review) {
  const comments = review.warnings ?? [];
  return {
    blocking_problems_identified: review.outcome !== "neutral",
    has_nonblocking_warnings: review.outcome === "neutral" && comments.length > 0,
    summary: review.summary,
    comments,
    requested_changes: review.requested_changes ?? [],
    reviewed_at: review.reviewed_at,
    reviewer_models: review.reviewer_models ?? [],
  };
}
