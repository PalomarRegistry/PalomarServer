/**
 * Pure admission and per-principal backoff policy.
 *
 * State reads, proof handling, optimistic writes, and dispatch stay in the
 * Worker composition root. This module decides what current admission inputs
 * mean and projects the next rate record after an admission.
 */

const MAX_INFLIGHT_TOTAL = 12;
const MAX_INFLIGHT_PER_OWNER = 2;
const MAX_INFLIGHT_PER_SUBMITTER = 2;

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
 * back on their own, so the file says who and when.
 */
const RATE_FLOOR_SECONDS = 60;

function describeInterval(seconds) {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
}

/** Interpret the current rate record at one explicit instant. */
export function rateDecision(value, at = Date.now()) {
  const interval = Number(value?.interval_seconds ?? RATE_FLOOR_SECONDS);
  const nextAllowed = Date.parse(value?.next_allowed_at ?? 0) || 0;
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
    starts: Number(value?.starts ?? 0),
  };
}

/** Project the rate record written after one accepted admission. */
export function nextRateRecord({ login, starts, interval, startedAt, at = Date.now() }) {
  const nextInterval = starts === 0 ? RATE_FLOOR_SECONDS : interval * 2;
  return {
    schema_version: 1,
    login,
    starts: starts + 1,
    interval_seconds: nextInterval,
    last_start_at: startedAt,
    next_allowed_at: new Date(at + nextInterval * 1000).toISOString()
      .replace(/\.\d+Z$/, "Z"),
  };
}

/** Project the existing rate record after a completed registration. */
export function resetRateRecord(value, resetAt) {
  return {
    ...(value ?? { schema_version: 1 }),
    interval_seconds: RATE_FLOOR_SECONDS,
    next_allowed_at: resetAt,
  };
}

/**
 * Decide whether one more proved submission fits the current admission caps.
 *
 * Verification is expensive and long-running, and anyone who can prove push
 * access to any public repository reaches this point — including on a
 * repository they made a minute ago. The owner cap stops one project's
 * repositories monopolising the runners; the submitter cap stops one person
 * doing it across many repositories, which the owner cap alone never noticed,
 * because a fresh organisation buys fresh slots.
 */
export function admissionDecision(open, { owner, submitter }) {
  if (open.length >= MAX_INFLIGHT_TOTAL) {
    return {
      refused: true,
      status: 503,
      title: "Palomar is at capacity",
      detail: ["Too many submissions are being verified right now. Please try again later."],
    };
  }
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
        `Palomar verifies at most ${MAX_INFLIGHT_PER_SUBMITTER} submissions at a time from one submitter.`,
        "Wait for those to finish before submitting another.",
      ],
    };
  }
  return { refused: false };
}
