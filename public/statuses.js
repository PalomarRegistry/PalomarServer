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
 * They differ by `review-failed`, and the difference is load-bearing both ways.
 * A review that could not be completed is a fault at this end, so the page has
 * nothing to poll for until an operator moves it; but the submission is still
 * the submitter's, and they must be able to withdraw it. Putting `review-failed`
 * into `CLOSED` would take that away from exactly the people whose submission
 * has already gone wrong, and it would do it silently, since the endpoint would
 * answer "already review-failed" as though that were their own doing. Taking it
 * out of `SETTLED` would leave a page asking every minute, for as long as the
 * tab is open, about something no amount of asking can change.
 *
 * Both live here, one derived from the other, because they were two sets with
 * confusable names in two files, and two such sets invite the reasonable-looking
 * edit that makes them equal. Whoever makes that edit should have to read this.
 *
 * Loaded by the browser as well as the server: the status page imports it
 * through `/polling.js`, so this file is served from the assets directory and
 * the specifiers that reach it stay relative.
 */

export const CLOSED = new Set(["registered", "withdrawn", "verification-failed"]);

export const SETTLED = new Set([...CLOSED, "review-failed"]);
