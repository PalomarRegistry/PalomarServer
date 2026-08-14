/**
 * Pure admission and per-principal backoff policy.
 *
 * Durable inputs come from submission-lifecycle.js and the Worker composition
 * root; proof handling, optimistic writes, and dispatch stay in the root. This
 * module decides what current admission inputs mean and projects the next rate
 * record after an admission.
 */

const MAX_INFLIGHT_PER_OWNER = 2;
const MAX_INFLIGHT_PER_SUBMITTER = 1;
const GITHUB_LOGIN = /^[A-Za-z0-9_-]{1,39}$/;
const UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const LAST_UTC_SECONDS_MS = Date.parse("9999-12-31T23:59:59Z");

export class RateContractError extends Error {}

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
 * back on their own, so the file says when.
 *
 * It no longer says who. The file name is a peppered digest of the principal
 * precisely so that listing the directory does not enumerate everyone who has
 * ever submitted, and a cleartext `login` in the body gave that back to anyone
 * who could read the files. An operator holding the pepper reaches the file
 * from the login instead: `tools/rate-path.js` prints the path.
 *
 * Documents written earlier may still carry an identifying field: `login`, or
 * `submission_ids`, which named this principal's submissions until they moved
 * to `index/principals/` and which points at records that do name the
 * submitter. Both are tolerated on read, because refusing them would lock the
 * submitter out of intake entirely, and both are dropped the next time the
 * document is projected. `IDENTIFYING_FIELDS` is that list, shared with the
 * one-time migration in `tools/strip-rate-logins.js`.
 */
const RATE_FLOOR_SECONDS = 60;

/**
 * Fields an older rate document may carry that identify its submitter.
 *
 * Exported so the migration tool retires exactly the set the reset projection
 * sheds, and the two cannot drift apart.
 */
export const IDENTIFYING_FIELDS = ["login", "submission_ids"];

function describeInterval(seconds) {
  if (seconds < 90) {
    const rounded = Math.max(1, Math.round(seconds));
    return `${rounded} ${rounded === 1 ? "second" : "seconds"}`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
}

function fail(message) {
  throw new RateContractError(`rate record ${message}`);
}

function timestamp(value, field) {
  if (typeof value !== "string" || !UTC_SECONDS.test(value)) {
    fail(`${field} must be a canonical UTC-seconds timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().replace(/\.\d+Z$/, "Z") !== value) {
    fail(`${field} must be a real UTC date and time`);
  }
  return parsed;
}

/** Validate one present Server-owned rate document under its current contract. */
export function rateRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("must be a JSON object");
  }
  if (value.schema_version !== 1) fail("schema_version must be 1");
  // Current documents carry no login at all. Documents written before that are
  // still valid, so absence is accepted; a login that is present but not a
  // login is still a malformed document and still fails closed.
  if (Object.hasOwn(value, "login") &&
      (typeof value.login !== "string" || !GITHUB_LOGIN.test(value.login))) {
    fail("login must be a GitHub login when present");
  }
  if (!Number.isSafeInteger(value.starts) || value.starts < 1) {
    fail("starts must be a positive safe integer");
  }
  if (!Number.isSafeInteger(value.interval_seconds) ||
      value.interval_seconds < RATE_FLOOR_SECONDS) {
    fail(`interval_seconds must be a safe integer of at least ${RATE_FLOOR_SECONDS}`);
  }
  const lastStart = timestamp(value.last_start_at, "last_start_at");
  const nextAllowed = timestamp(value.next_allowed_at, "next_allowed_at");
  if (nextAllowed < lastStart) {
    fail("next_allowed_at must not precede last_start_at");
  }
  return { value, nextAllowed };
}

/** Interpret the current rate record at one explicit instant. */
export function rateDecision(value, at = Date.now()) {
  if (!Number.isFinite(at)) fail("decision time must be finite");
  const current = value === null ? null : rateRecord(value);
  const interval = current?.value.interval_seconds ?? RATE_FLOOR_SECONDS;
  const nextAllowed = current?.nextAllowed ?? 0;
  const wait = Math.ceil((nextAllowed - at) / 1000);
  if (wait > 0) {
    return {
      refused: true,
      status: 429,
      // What a person can act on is the wait. The interval is theirs
      // personally, having doubled with their own starts, so naming it read as
      // a policy Palomar applies to everybody and was wrong in the only way
      // that matters: somebody comparing notes with a colleague would find
      // they had been told different rules. The doubling is in the source for
      // anybody who wants it.
      title: "You have hit a submission rate limit",
      detail: [`Please try again in ${describeInterval(wait)}.`],
    };
  }
  return {
    refused: false,
    interval,
    starts: current?.value.starts ?? 0,
  };
}

/** Project the rate record written after one accepted admission. */
export function nextRateRecord({ starts, interval, startedAt, at = Date.now() }) {
  if (!Number.isSafeInteger(starts) || starts < 0) {
    fail("starts must be a non-negative safe integer before an admission");
  }
  if (!Number.isSafeInteger(interval) || interval < RATE_FLOOR_SECONDS) {
    fail(`interval_seconds must be a safe integer of at least ${RATE_FLOOR_SECONDS}`);
  }
  timestamp(startedAt, "last_start_at");
  if (!Number.isFinite(at)) fail("admission time must be finite");
  const nextInterval = starts === 0 ? RATE_FLOOR_SECONDS : interval * 2;
  if (!Number.isSafeInteger(nextInterval)) {
    fail("next interval_seconds is not a safe integer");
  }
  const nextAllowed = at + nextInterval * 1000;
  if (!Number.isFinite(nextAllowed) || nextAllowed < 0 || nextAllowed > LAST_UTC_SECONDS_MS) {
    fail("next_allowed_at is outside the representable date range");
  }
  // No login. Everything an operator needs beyond the interval is the time,
  // and the file is found from a login through the pepper, not by reading it.
  const result = {
    schema_version: 1,
    starts: starts + 1,
    interval_seconds: nextInterval,
    last_start_at: startedAt,
    next_allowed_at: new Date(nextAllowed).toISOString()
      .replace(/\.\d+Z$/, "Z"),
  };
  rateRecord(result);
  return result;
}

/** Project the existing rate record after a completed registration. */
export function resetRateRecord(value, resetAt) {
  const current = rateRecord(value).value;
  timestamp(resetAt, "next_allowed_at");
  const result = {
    ...current,
    interval_seconds: RATE_FLOOR_SECONDS,
    next_allowed_at: resetAt,
  };
  // A spread preserves whatever the document already held, which for an older
  // document includes fields that identify the submitter. Shed them here, so
  // ordinary traffic retires those bodies without a migration having to reach
  // every file.
  for (const field of IDENTIFYING_FIELDS) delete result[field];
  rateRecord(result);
  return result;
}

/**
 * Decide whether one more proved submission fits the principal admission caps.
 *
 * Verification is expensive and long-running. Ordinary submitters have proved
 * push access by this point. The owner cap stops one project's repositories
 * monopolising the runners; the one-per-submitter cap stops one person doing it
 * across many repositories, which the owner cap alone never noticed, because a
 * fresh organisation buys fresh slots. Verified Technical Maintainer accounts
 * are exempted by the composition root before this ordinary-submission policy
 * is called, regardless of the submission's authorization relationship. There
 * is no global cap: unrelated submitters must not be able to make intake refuse
 * everyone.
 */
export function admissionDecision(open, { owner, submitter }) {
  if (owner && open.filter((item) => item.owner === owner).length >= MAX_INFLIGHT_PER_OWNER) {
    return {
      refused: true,
      status: 429,
      title: "That repository already has submissions in flight",
      detail: [
        `Palomar verifies at most ${MAX_INFLIGHT_PER_OWNER} submissions at a time from one owner.`,
        "Wait for those to finish before submitting another.",
      ],
    };
  }
  if (open.filter((item) => item.submitter === submitter).length >= MAX_INFLIGHT_PER_SUBMITTER) {
    return {
      refused: true,
      status: 429,
      title: "You already have submissions in flight",
      detail: [
        "Palomar verifies at most one submission at a time from one submitter.",
        "Wait for those to finish before submitting another.",
      ],
    };
  }
  return { refused: false };
}
