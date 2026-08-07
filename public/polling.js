/**
 * How often the status page asks the server what has happened.
 *
 * It asked every six seconds for as long as the tab was open, and one ask is
 * three or four GitHub calls against the server's single budget of five
 * thousand an hour. Three tabs left open exhausted it, and an exhausted budget
 * is not a slow status page: it is every submission's verification, review and
 * registration failing at once, for everybody.
 *
 * A module rather than a constant in the page, so the schedule the page keeps
 * and the schedule the budget arithmetic is checked against are the same one.
 */

// The first answer arrives as quickly as it always did. Backing off from there
// is what bounds the cost; making somebody wait for the first answer buys
// nothing, and the page is opened at the moment a submission is dispatched.
export const FIRST_POLL_MS = 6_000;

// A minute, for the states a machine is working through: verification and the
// review itself take minutes, so a minute of latency on the news is not a
// minute of somebody waiting for nothing. Six seconds doubling to a minute is
// about sixty asks an hour, so about twenty tabs fit in the budget where three
// used to.
export const POLL_CAP_MS = 60_000;

// Five minutes, for the states whose next move is on a clock nobody here
// controls: `awaiting-review` waits for a reviewer pass, which is scheduled
// every two hours, and a registration under way takes a whole pass of its own.
// Asking a hundred times between two possible answers is a hundred wasted asks.
export const SLOW_POLL_CAP_MS = 300_000;

// Nothing is running for a submission in these states, so the page stops
// asking. Everything else is in motion and the page keeps itself current.
export const SETTLED = new Set([
  "verification-failed", "registered", "withdrawn",
  // Nothing further happens without an operator, so the page stops asking.
  "review-failed",
]);

const SLOW = new Set(["awaiting-review", "review-ready"]);

/**
 * How long to wait before asking again, or null for "do not ask again".
 *
 * A hidden tab asks nothing at all. Nobody is reading it, the answer it would
 * get is one it would only show when the tab comes back, and a page left open
 * in a background tab for a week is the whole of this problem.
 */
export function nextPollDelay({
  status,
  previous = 0,
  hidden = false,
  waitingOnAPerson = false,
} = {}) {
  if (hidden || waitingOnAPerson || SETTLED.has(status)) return null;
  const cap = SLOW.has(status) ? SLOW_POLL_CAP_MS : POLL_CAP_MS;
  return Math.min(previous > 0 ? previous * 2 : FIRST_POLL_MS, cap);
}
