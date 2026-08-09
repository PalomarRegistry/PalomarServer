/**
 * The statuses at which a submission has stopped moving, and the two different
 * questions that get asked about them.
 *
 * `CLOSED` is what `POST /withdraw` and `POST /register` refuse to act on: the
 * submission is over, and acting on it again would either contradict a record
 * that is already public or withdraw something twice. `SETTLED` is what the
 * status page stops asking about: nothing further happens on its own, so there
 * is no news to wait for.
 *
 * `dispatch-lost` sits with `review-failed` for the same reason and by the same
 * argument. Palomar could not find the run it started, which is a fault at this
 * end and not a statement about the submitter's proof, so there is nothing to
 * poll for; but the submission is still theirs and they must be able to
 * withdraw it. It is deliberately not `verification-failed`: telling somebody
 * their proof did not verify when the truth is that we lost track of the run
 * would be a false claim, from a registry whose whole product is claims that
 * are true.
 *
 * `CLOSED` and `SETTLED` differ by `review-failed` and `dispatch-lost`, and the
 * difference is load-bearing both ways.
 * A review that could not be completed is a fault at this end, so the page has
 * nothing to poll for until an operator moves it; but the submission is still
 * the submitter's, and they must be able to withdraw it. Putting `review-failed`
 * into `CLOSED` would take that away from exactly the people whose submission
 * has already gone wrong, and it would do it silently, since the endpoint would
 * answer "already review-failed" as though that were their own doing. Taking it
 * out of `SETTLED` would leave a page asking every minute, for as long as the
 * tab is open, about something no amount of asking can change.
 *
 * Both live here because they were sets with confusable names in different
 * files. `WITHDRAWABLE` is deliberately the closed list of known non-closed
 * statuses instead of `!CLOSED`: an unknown future status must fail closed in
 * the browser rather than unexpectedly offering a destructive action. The
 * exhaustive test against the server's status vocabulary keeps that list and
 * `CLOSED` complementary for every status that actually exists.
 *
 * Loaded by the browser as well as the server: the status page imports the
 * presentation policy directly as `/statuses.js`, while `/polling.js` imports
 * the settled set relatively. The file therefore stays environment-neutral.
 */

export const CLOSED = new Set(["registered", "withdrawn", "verification-failed"]);

export const SETTLED = new Set([...CLOSED, "review-failed", "dispatch-lost"]);

const WITHDRAWABLE = new Set([
  "verifying",
  "awaiting-review",
  "reviewing",
  "review-ready",
  "review-failed",
  "dispatch-lost",
]);

/** The review and decision controls that belong to one current status. */
export function statusPresentation(
  status,
  { reviewPassed = false, registrationConsent = false } = {},
) {
  const review = status === "review-ready"
    ? "interactive"
    : status === "registered" ? "read-only" : "hidden";
  return {
    review,
    register: status === "review-ready" && reviewPassed && !registrationConsent,
    withdraw: WITHDRAWABLE.has(status),
  };
}
