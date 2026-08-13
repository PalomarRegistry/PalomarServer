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
 * `CLOSED` and `SETTLED` differ by the Palomar-owned service failures and by
 * `dispatch-lost`; the difference is load-bearing both ways.
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

export const CLOSED = new Set([
  "registered",
  "withdrawn",
  "changes-required",
  "verification-failed",
]);

export const SETTLED = new Set([
  ...CLOSED,
  "preflight-failed",
  "verification-error",
  "review-failed",
  "registration-paused",
  "dispatch-lost",
]);

const WITHDRAWABLE = new Set([
  "preflighting",
  "preflight-reporting",
  "preflight-failed",
  "verifying",
  "verification-reporting",
  "verification-error",
  "awaiting-review",
  "reviewing",
  "review-ready",
  "review-failed",
  "registration-paused",
  "dispatch-lost",
]);

const WAITING_MESSAGES = {
  preflighting:
    "Palomar is checking the repository's metadata and configuration before full verification.",
  "preflight-reporting":
    "Preflight finished and Palomar is preparing a complete, actionable explanation.",
  verifying:
    "Palomar is preparing and mechanically checking the repository. If verification and review pass, " +
    "the option to register will appear on this page.",
  "awaiting-review":
    "Mechanical verification passed and the automated review has been queued. If the " +
    "review passes, the option to register will appear here.",
  reviewing:
    "The automated review is running. If it passes, the option to register will appear here.",
  "verification-reporting":
    "Mechanical verification finished and Palomar is preparing a complete explanation.",
};

/** The primary explanation for a status that needs no submitter action. */
export function waitingMessage(status) {
  return WAITING_MESSAGES[status] ?? null;
}

/** The review and decision controls that belong to one current status. */
export function statusPresentation(
  status,
  { reviewPassed = false, registrationConsent = false } = {},
) {
  const review = status === "review-ready" || status === "registration-paused"
    ? "interactive"
    : status === "registered" ? "read-only" : "hidden";
  return {
    review,
    register: status === "review-ready" && reviewPassed && !registrationConsent,
    withdraw: WITHDRAWABLE.has(status),
  };
}

/** The heading and explanation above whichever decision controls are shown. */
export function decisionCopy(
  status,
  {
    reviewPassed = false,
    registrationConsent = false,
    reviewShown = false,
    reviewNeedsRerun = false,
  } = {},
) {
  const presentation = statusPresentation(status, { reviewPassed, registrationConsent });
  if (presentation.register) {
    return {
      heading: "Your decision",
      intro:
        "Read the automated review above, then choose whether to register or withdraw this submission.",
    };
  }
  if (!presentation.withdraw) return null;
  if (status === "registration-paused") {
    return {
      heading: "Registration needs operator attention",
      intro:
        "Palomar could not complete registration. Its operators can see the problem; " +
        "no repository change is currently requested. Withdraw only if you want to " +
        "cancel this submission.",
    };
  }
  if (registrationConsent) {
    return {
      heading: "Stop this submission",
      intro: "Registration is already under way. Use this only if you want Palomar to stop it.",
    };
  }
  if (reviewNeedsRerun) {
    return {
      heading: "Waiting for another review",
      intro:
        "No action is needed. Palomar's operators can see that the review must be rerun; " +
        "withdraw only if you want to cancel the submission.",
    };
  }
  if (status === "review-ready" && reviewShown && !reviewPassed) {
    return {
      heading: "This review did not pass",
      intro:
        "Registration is not offered. Update the repository and submit the corrected commit, " +
        "or withdraw to close this submission.",
    };
  }
  if (status === "review-ready") {
    return {
      heading: "Waiting for the review",
      intro:
        "No action is needed. This page will keep trying to retrieve the review; withdraw " +
        "only if you want to cancel the submission.",
    };
  }
  if (waitingMessage(status)) {
    return {
      heading: "Stop this submission",
      intro: "This is optional. Palomar is still working; withdraw only if you want to cancel.",
    };
  }
  return {
    heading: "Stop this submission",
    intro: "Withdraw only if you want to close this submission.",
  };
}

const RUNNER_BOILERPLATE = [
  /^Process completed with exit code \d+\.?$/i,
  /^mechanical verification did not pass(?::\s*[a-z_-]+)?\.?$/i,
];

/** The exact public run whose unsuccessful completion is safe to explain. */
export function verificationRunLocation(run) {
  if (run?.status !== "completed" || !run.conclusion || run.conclusion === "success") {
    return null;
  }
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/actions\/runs\/(\d+)$/.exec(
    String(run.url ?? ""),
  );
  if (!match || [match[1], match[2]].some((part) => part === "." || part === "..")) return null;
  const runId = Number(match[3]);
  if (!Number.isSafeInteger(runId) || runId !== Number(run.id)) return null;
  return { repositoryPath: `${match[1]}/${match[2]}`, runId, runUrl: run.url };
}

/**
 * Turn public GitHub check annotations into bounded, actionable diagnostics.
 * Text remains text in the caller; repository-controlled markup is never used.
 */
export function actionableVerificationErrors(annotations, steps = []) {
  const messages = [];
  for (const annotation of Array.isArray(annotations) ? annotations : []) {
    if (annotation?.annotation_level !== "failure") continue;
    const message = String(annotation.message ?? "").trim().slice(0, 2000);
    if (!message || RUNNER_BOILERPLATE.some((pattern) => pattern.test(message))) continue;
    if (!messages.includes(message)) messages.push(message);
    if (messages.length === 8) break;
  }
  if (messages.length) return messages;
  for (const step of Array.isArray(steps) ? steps : []) {
    const name = String(step?.name ?? "").trim();
    if (step?.conclusion !== "failure" || !name ||
        /^Fail the run when verification did not pass$/i.test(name)) continue;
    const message = `The “${name.slice(0, 200)}” step failed.`;
    if (!messages.includes(message)) messages.push(message);
    if (messages.length === 8) break;
  }
  return messages;
}
