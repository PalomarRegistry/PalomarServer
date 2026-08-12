import { SETTLED, nextPollDelay, pollFailureAction } from "/polling.js";
import { FORMALIZATION_FIELDS, FORMALIZATION_PROFILE_VERSION } from "/formalization-profile.js";
import {
  actionableVerificationErrors,
  decisionCopy,
  statusPresentation,
  verificationRunLocation,
  waitingMessage as waitingStatusMessage,
} from "/statuses.js";

// The access token lives in the URL fragment, which browsers never send to a
// server. It is posted once in exchange for a short-lived cookie, then removed
// from the address bar, so it never appears in a request path or a log.
const token = location.hash.replace(/^#/, "");
const summary = document.getElementById("summary");
const details = document.getElementById("details");
const events = document.getElementById("events");
const progress = document.getElementById("progress-detail");
const waitingSection = document.getElementById("waiting-section");
const waitingMessage = document.getElementById("waiting-message");
const verificationFailureSection = document.getElementById("verification-failure-section");
const failureHeading = document.getElementById("failure-heading");
const failureIntro = document.getElementById("failure-intro");
const failureDiagnostics = document.getElementById("failure-diagnostics");
const verificationErrors = document.getElementById("verification-errors");
const verificationRunContext = document.getElementById("verification-run-context");
const legacyFailureDetails = document.getElementById("legacy-failure-details");
const repairForm = document.getElementById("repair-form");
const repairFields = document.getElementById("repair-fields");
const repairStatus = document.getElementById("repair-status");
const repairExplanation = document.getElementById("repair-explanation");
const repairSubmit = repairForm?.querySelector("button[type=submit]");
const reviewSection = document.getElementById("review-section");
const reviewPrivacy = document.getElementById("review-privacy");
const reviewSummary = document.getElementById("review-summary");
const reviewBody = document.getElementById("review-body");
const decisionSection = document.getElementById("decision-section");
const decisionHeading = document.getElementById("decision-heading");
const decisionIntro = document.getElementById("decision-intro");
const decisionStatus = document.getElementById("decision-status");
const registerButton = document.getElementById("register");
const withdrawButton = document.getElementById("withdraw");
const registerWarning = document.getElementById("register-warning");
const withdrawWarning = document.getElementById("withdraw-warning");

const LABELS = {
  preflighting: "Checking your submission before full verification.",
  "preflight-reporting": "Preflight finished. Palomar is preparing the details.",
  "changes-required": "Preflight found repository metadata that needs changing.",
  "preflight-failed":
    "Palomar could not complete preflight. This is a fault at our end, not with your submission.",
  verifying: "Mechanically verifying your submission.",
  "verification-reporting": "Verification finished. Palomar is preparing the details.",
  "verification-failed": "Mechanical verification did not pass.",
  "verification-error":
    "Palomar could not complete mechanical verification. This is a fault at our end, not with your submission.",
  "awaiting-review": "Verification passed. Waiting for the automated review.",
  reviewing: "Running the automated review.",
  "review-ready": "Your automated review is ready.",
  "review-failed":
    "Palomar could not complete the automated review. This is a fault at our end, " +
    "not with your submission. Keep this link; the operators can see it and will " +
    "look into it.",
  // Deliberately not phrased as a verification result. Palomar lost the run; it
  // did not watch the proof fail, and saying so would be a claim it cannot make.
  "dispatch-lost":
    "Palomar could not find the verification run it started for your submission, " +
    "and has released its place in the queue. This is a fault at our end, not with " +
    "your submission, and nothing about your proof was decided. Submitting the same " +
    "commit again is the fastest way forward; the operators can see this too.",
  registered: "Registered in the registry.",
  withdrawn: "Withdrawn.",
};

// What the automated review is, said once, where someone is waiting for it.
const REVIEW_EXPLANATION =
  "The automated review checks that your formal statements agree with the informal " +
  "account of them, wherever you have written it: module documentation or docstrings " +
  "in the Challenge, the README, or formalization.yaml. It also judges whether the " +
  "result is plausibly interesting to some mathematician.";

function duration(seconds) {
  const inMinutes = seconds >= 90;
  const value = Math.round(inMinutes ? seconds / 60 : seconds);
  return `${value} ${inMinutes ? "minute" : "second"}${value === 1 ? "" : "s"}`;
}

function el(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function row(term, value, target = details) {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  if (value instanceof Node) dd.append(value); else dd.textContent = value;
  target.append(dt, dd);
}

/** Review text is set with textContent throughout: it is never parsed as HTML. */
function paragraphs(heading, items) {
  if (!items?.length) return;
  const h = document.createElement("h3");
  h.textContent = heading;
  reviewBody.append(h);
  const list = document.createElement("ul");
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = String(item);
    list.append(li);
  }
  reviewBody.append(list);
}

let reviewShown = false;
let reviewNeedsRerun = false;
let reviewPassed = false;
let registrationStarted = false;
let decisionInFlight = false;
// The digest of the review on the page, sent back with a registration so that
// consent names the bytes that were read.
let reviewDigest = null;

function resetReview() {
  reviewShown = false;
  reviewNeedsRerun = false;
  reviewPassed = false;
  reviewDigest = null;
  reviewSummary.replaceChildren();
  reviewBody.replaceChildren();
  reviewSection.hidden = true;
  reviewPrivacy.textContent =
    "It is private: nobody but you and the Palomar moderation team can see it, " +
    "and it stays that way unless you register.";
}

async function showReview({ registered = false, expectedDigest = null } = {}) {
  if (reviewShown) {
    if (registered && (!expectedDigest || reviewDigest !== expectedDigest)) {
      reviewSection.hidden = true;
      return false;
    }
    reviewSection.hidden = false;
    return true;
  }
  const response = await fetch("/api/review", { credentials: "same-origin" });
  if (response.status === 409) {
    // A frozen registered result cannot be rerun. Older pre-launch records may
    // no longer satisfy the current private-review contract; leave that panel
    // absent instead of asking the submitter to do an impossible thing.
    if (registered) {
      reviewSection.hidden = true;
      return false;
    }
    reviewNeedsRerun = true;
    reviewSummary.replaceChildren();
    reviewBody.replaceChildren(
      el(
        "p",
        "This review was produced under an earlier review contract and has to be rerun. " +
          "Keep this link; the operators can see the submission.",
      ),
    );
    reviewSection.hidden = false;
    reviewPassed = false;
    return true;
  }
  if (!response.ok) {
    if (registered) reviewSection.hidden = true;
    return false;
  }
  const review = await response.json();
  if (registered && (!expectedDigest || review.review_sha256 !== expectedDigest)) {
    reviewSection.hidden = true;
    return false;
  }
  reviewNeedsRerun = false;
  reviewShown = true;
  reviewPassed = review.passed === true;
  reviewDigest = review.review_sha256 ?? null;
  reviewSummary.replaceChildren();
  reviewBody.replaceChildren();
  row("Decision", review.passed ? "Passed" : "Did not pass", reviewSummary);
  row("Reviewed", review.reviewed_at ?? "", reviewSummary);
  row("Reviewer models", (review.reviewer_models ?? []).join(", "), reviewSummary);
  // No scores. They decide the outcome and are kept with the record, and the
  // outcome is on the line above. Showing them invites a reading they cannot
  // carry: the same repository at the same commit has scored 5 and then 4 on
  // the same axis across two runs.
  const summaryText = document.createElement("p");
  summaryText.textContent = review.summary ?? "";
  reviewBody.append(summaryText);
  paragraphs("Requested changes", review.requested_changes);
  // One heading for everything the review had to say. The review sorts its
  // remarks by severity for its own purposes; that sorting is not a thing a
  // submitter can act on differently, so it is not presented as one.
  paragraphs("AI review comments", review.comments);
  reviewSection.hidden = false;
  return true;
}

async function decide(button, path, confirmation, body = null) {
  if (!window.confirm(confirmation)) return;
  decisionInFlight = true;
  registerButton.disabled = true;
  withdrawButton.disabled = true;
  decisionStatus.textContent = "Working…";
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    ...(body
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  if (!response.ok) {
    decisionInFlight = false;
    const problem = await response.json().catch(() => ({}));
    decisionStatus.textContent = `That did not work: ${problem.error ?? response.status}`;
    registerButton.disabled = false;
    withdrawButton.disabled = false;
    if (path === "/register") {
      // A replacement is one reason registration can fail. Drop the review
      // cache and immediately ask again so "read the new one" is an action the
      // page can actually perform without a reload.
      resetReview();
      await poll();
    }
    return;
  }
  decisionInFlight = false;
  if (path === "/register") registrationStarted = true;
  decisionStatus.textContent = "Recorded.";
  poll();
}

registerButton?.addEventListener("click", () =>
  decide(
    registerButton,
    "/register",
    "Palomar is pre-launch. The record, review, repository, and commit become " +
      "public during testing, and immutable source-preservation tags are " +
      "created. Your GitHub identity is not made public. The database may still " +
      "be reshaped until launch. Register?",
    // Which review this consents to, rather than whichever one is current when
    // the click arrives.
    { review_sha256: reviewDigest },
  ),
);
withdrawButton?.addEventListener("click", () =>
  decide(
    withdrawButton,
    "/withdraw",
    registrationStarted
      ? "Withdrawing asks Palomar to stop registration. The registry record will not be " +
        "merged, but source-preservation or rendering work that already started may remain " +
        "public. Withdraw?"
      : "Withdrawing ends this submission. Nothing about the review or the " +
        "decision becomes public. Withdraw?",
  ),
);

function link(href, text) {
  let target;
  try {
    target = new URL(href);
  } catch {
    return document.createTextNode(text);
  }
  if (target.protocol !== "https:") return document.createTextNode(text);
  const a = document.createElement("a");
  a.href = target.href;
  a.textContent = text;
  a.rel = "noreferrer";
  return a;
}

function hideTransientSections() {
  waitingSection.hidden = true;
  decisionSection.hidden = true;
  verificationFailureSection.hidden = true;
  reviewSection.hidden = true;
  decisionStatus.replaceChildren();
}

let shownFailureRun = null;
let failureDisplayToken = 0;

function diagnosticLocation(location) {
  if (!location?.path) return "";
  return `${location.path}${location.line ? `:${location.line}` : ""}${location.column ? `:${location.column}` : ""}`;
}

function showStructuredFailure(data) {
  const failure = data.failure;
  const diagnostics = Array.isArray(failure?.diagnostics) ? failure.diagnostics : [];
  if (!diagnostics.length) return false;
  verificationFailureSection.hidden = false;
  legacyFailureDetails.hidden = true;
  failureDiagnostics.replaceChildren();
  failureHeading.textContent = failure.mode === "preflight"
    ? "Preflight found these problems"
    : "Verification needs attention";
  failureIntro.textContent = diagnostics.every((item) => item.owner === "submitter")
    ? "Each item below says what needs changing and what to do next. Update the repository and submit the corrected commit."
    : "The owner shown on each item tells you whether to change the repository or wait for Palomar.";

  const repairable = [];
  for (const diagnostic of diagnostics) {
    const article = document.createElement("article");
    article.className = "diagnostic";
    article.append(el("h3", diagnostic.summary ?? "A check did not pass"));
    const location = diagnosticLocation(diagnostic.location);
    if (location) {
      const locationNode = el("p", location);
      locationNode.className = "location";
      article.append(locationNode);
    }
    if (diagnostic.explanation) article.append(el("p", diagnostic.explanation));
    article.append(el("p", `Who can fix this: ${diagnostic.owner === "submitter" ? "you" : "Palomar"}.`));
    if (diagnostic.next_action) article.append(el("p", `Next: ${diagnostic.next_action}`));
    failureDiagnostics.append(article);
    const profile = FORMALIZATION_FIELDS[diagnostic.field];
    if (
      diagnostic.repairable === true && profile &&
      failure.profile_version === FORMALIZATION_PROFILE_VERSION
    ) repairable.push({ diagnostic, profile });
  }

  repairFields.replaceChildren();
  const canRequestRepair = data.status === "changes-required" && !data.repair && repairable.length;
  repairForm.hidden = !canRequestRepair;
  repairExplanation.hidden = !canRequestRepair;
  repairSubmit.hidden = !canRequestRepair;
  if (canRequestRepair) {
    for (const { diagnostic, profile } of repairable) {
      const wrapper = document.createElement("div");
      wrapper.className = "repair-field";
      const id = `repair-${diagnostic.field.replaceAll(".", "-")}`;
      const label = el("label", profile.label);
      label.htmlFor = id;
      const input = profile.input === "text-list"
        ? document.createElement("textarea")
        : document.createElement("input");
      input.id = id;
      input.name = diagnostic.field;
      input.dataset.inputType = profile.input;
      input.required = true;
      input.maxLength = 4000;
      if (input instanceof HTMLTextAreaElement) input.rows = 3;
      const hint = el("p", profile.description);
      if (profile.input === "text-list") {
        hint.append(" Enter the complete replacement list, one value per line.");
      }
      hint.className = "hint";
      wrapper.append(label, input, hint);
      repairFields.append(wrapper);
    }
  }
  if (data.repair) {
    repairForm.hidden = false;
    repairExplanation.hidden = true;
    repairSubmit.hidden = true;
    repairFields.replaceChildren();
    const messages = {
      queued: "The repair request is queued.",
      preparing: "Palomar is validating the proposed metadata changes.",
      "pr-open": "Palomar opened a pull request. Review and merge it, then make a new submission.",
      merged: "The repair pull request was merged. Make a new submission using the merged commit.",
      "needs-input": "Palomar could not safely prepare this change. Use the explanation below to update the file manually.",
      failed: "Palomar could not create the repair pull request. This is a fault at our end; you can still make the changes manually.",
      closed: "The repair pull request was closed without merging. Update the file manually or make a new submission after changing it.",
    };
    repairStatus.textContent = messages[data.repair.status] ?? `Repair status: ${data.repair.status}`;
    if (data.repair.explanation) repairStatus.append(` ${data.repair.explanation}`);
    if (data.repair.pr_url) repairStatus.append(" ", link(data.repair.pr_url, "Open the pull request."));
    if (data.repair.patch) {
      const pre = document.createElement("pre");
      pre.textContent = data.repair.patch;
      repairFields.append(el("p", "You can apply this patch manually:"), pre);
    }
  } else {
    repairStatus.textContent = "";
  }
  return true;
}

repairForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const edits = [...repairFields.querySelectorAll("[name]")].map((input) => ({
    field: input.name,
    value: input.dataset.inputType === "text-list"
      ? input.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
      : input.value.trim(),
  }));
  repairStatus.textContent = "Submitting the repair request…";
  const response = await fetch("/api/repair", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ failure_digest: lastFailureDigest, edits }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    repairStatus.textContent = `That did not work: ${body.error ?? response.status}`;
    return;
  }
  repairStatus.textContent = "The repair request is queued.";
  repairSubmit.disabled = true;
  pollDelay = 0;
  poll();
});

let lastFailureDigest = null;

/** Show public, bounded check annotations without asking for a GitHub credential. */
async function showVerificationFailure(run) {
  const location = verificationRunLocation(run);
  if (!location) return;
  const mine = ++failureDisplayToken;
  verificationFailureSection.hidden = false;
  verificationErrors.replaceChildren(el("li", "Retrieving the detailed error…"));
  verificationRunContext.replaceChildren();

  let messages = [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const { repositoryPath, runId } = location;
    const options = {
      headers: { accept: "application/vnd.github+json" },
      // Deliberately no credentials. The verification repository and these
      // annotations are public, while the status-page capability is private.
      signal: controller.signal,
    };
    const jobsResponse = await fetch(
      `https://api.github.com/repos/${repositoryPath}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
      options,
    );
    if (!jobsResponse.ok) throw new Error("verification jobs unavailable");
    const jobs = (await jobsResponse.json())?.jobs ?? [];
    // Current verification has one job. The cap keeps a future matrix from
    // spending a browser's unauthenticated GitHub allowance in one page load.
    const failedJobs = jobs.filter((job) => job?.conclusion === "failure").slice(0, 3);
    const annotationGroups = await Promise.all(failedJobs.map(async (job) => {
      const response = await fetch(
        `https://api.github.com/repos/${repositoryPath}/check-runs/${job.id}/annotations?per_page=100`,
        options,
      );
      return response.ok ? response.json() : [];
    }));
    messages = actionableVerificationErrors(annotationGroups.flat(), failedJobs.flatMap(
      (job) => job.steps ?? [],
    ));
  } catch {
    // The run itself remains the complete fallback. GitHub annotations are a
    // convenience and a rate limit or outage must not hide the settled record.
  } finally {
    clearTimeout(timeout);
  }
  if (mine !== failureDisplayToken) return;
  if (!messages.length) {
    messages = ["Palomar could not retrieve the detailed error automatically."];
  }
  verificationErrors.replaceChildren(...messages.map((message) => el("li", message)));
  verificationRunContext.replaceChildren(
    document.createTextNode(
      "You can inspect the error message as part of the failed verification run at ",
    ),
    link(location.runUrl, location.runUrl),
    document.createTextNode("."),
  );
  shownFailureRun = location.runId;
}

async function establishSession() {
  if (!token) return false;
  const body = new FormData();
  body.set("token", token);
  const response = await fetch("/session", { method: "POST", body, credentials: "same-origin" });
  // The fragment stays in the address bar. It is the only key to this
  // submission, the cookie it buys lasts half a day, and the page tells the
  // submitter to bookmark this link: removing the key would make that advice
  // false and lose the submission the moment the cookie expired. A fragment is
  // never sent to a server, which is why the key is carried in one.
  return response.ok;
}

let pollTimer = null;
let pollDelay = 0;
let lastStatus = null;
let lastRepairMoving = false;

/**
 * Ask again later, or stop asking.
 *
 * The delay doubles for as long as the answer keeps being the same one, and
 * starts over the moment the status changes: something that has just moved is
 * likely to move again, and something that has said the same thing for ten
 * minutes is not.
 */
function askAgain(status, waitingOnAPerson = false, repairMoving = false) {
  clearTimeout(pollTimer);
  pollTimer = null;
  if (status !== lastStatus) pollDelay = 0;
  lastStatus = status;
  lastRepairMoving = repairMoving;
  const delay = nextPollDelay({
    // `changes-required` is normally settled, but a queued repair or open PR
    // can still move underneath it. Keep the real submission status for UI
    // change detection while asking the polling policy to treat this page as
    // active until the repair reaches a terminal state.
    status: repairMoving ? "repairing" : status,
    previous: pollDelay,
    hidden: document.visibilityState === "hidden",
    waitingOnAPerson,
  });
  if (delay === null) return;
  pollDelay = delay;
  pollTimer = setTimeout(poll, delay);
}

// A tab nobody is looking at asks nothing, and one that comes back gets the
// current answer rather than the one it stopped on. A page left open in a
// background tab for a week is the whole of why this page had a budget problem.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") {
    clearTimeout(pollTimer);
    pollTimer = null;
    return;
  }
  if (SETTLED.has(lastStatus) && !lastRepairMoving) return;
  pollDelay = 0;
  poll();
});

async function poll() {
  let data;
  try {
    const response = await fetch("/api/submission", { credentials: "same-origin" });
    if (!response.ok) {
      const failure = pollFailureAction(response.status);
      if (failure === "missing") {
        summary.textContent = "This submission could not be found.";
        hideTransientSections();
        return;
      }
      if (failure === "unauthorized") {
        summary.textContent =
          "This session has expired or is not authorized. Open the original submission link again.";
        hideTransientSections();
        return;
      }
      summary.textContent = "Could not refresh this submission. Retrying.";
      askAgain(lastStatus);
      return;
    }
    data = await response.json();
  } catch {
    // An unreachable server is a reason to ask less often, not a reason to
    // keep asking at the same rate: it is usually the budget already spent.
    summary.textContent = "Could not reach the server. Retrying.";
    askAgain(lastStatus);
    return;
  }

  const failedRun = verificationRunLocation(data.run ?? data.preflight_run);
  lastFailureDigest = data.failure_digest ?? null;
  const structuredFailure = showStructuredFailure(data);
  summary.textContent = data.status === "verification-failed" && !failedRun && !structuredFailure
    ? "Palomar could not complete or recover the verification run. This is a fault at our end, not with your submission."
    : LABELS[data.status] ?? data.status;
  progress.replaceChildren();
  const waiting = waitingStatusMessage(data.status);
  waitingSection.hidden = !waiting;
  if (waitingMessage.textContent !== (waiting ?? "")) waitingMessage.textContent = waiting ?? "";
  if (!structuredFailure && (data.status !== "verification-failed" || !failedRun)) {
    verificationFailureSection.hidden = true;
    shownFailureRun = null;
    failureDisplayToken += 1;
  }

  if (data.status === "awaiting-review" || data.status === "reviewing") {
    progress.append(el("p", REVIEW_EXPLANATION));
    const notes = [];
    if (data.status === "awaiting-review") {
      notes.push("Palomar has been asked to start it.");
    }
    if (data.status === "reviewing" && data.review_started_at) {
      const elapsed = (Date.now() - Date.parse(data.review_started_at)) / 1000;
      if (Number.isFinite(elapsed) && elapsed > 0) {
        notes.push(`Running for ${duration(elapsed)}.`);
      }
    }
    if (data.typical_review_seconds) {
      notes.push(`Recent reviews have taken about ${duration(data.typical_review_seconds)}.`);
    }
    if (notes.length) progress.append(el("p", notes.join(" ")));
  }

  details.replaceChildren();
  row("Repository", link(`https://github.com/${data.repository}`, data.repository));
  row("Commit", data.commit);
  // The form fills these in for you when it can, so say what was submitted.
  // Nothing else in the pipeline ever shows a submitter the layout it used.
  for (const [key, label] of [
    ["project_path", "Project directory"],
    ["comparator_config_path", "Comparator configuration"],
    ["formalization_metadata_path", "Formalization metadata"],
  ]) {
    const value = data.requested_paths?.[key];
    if (value) row(label, value);
  }
  row("Submitted", data.created_at ?? "");
  if (data.preflight_run?.url) row("Preflight run", link(data.preflight_run.url, data.preflight_run.url.split("/").pop()));
  if (data.run?.url) row("Verification run", link(data.run.url, data.run.url.split("/").pop()));

  events.replaceChildren();
  for (const event of data.events ?? []) {
    const li = document.createElement("li");
    li.textContent = `${event.at} — ${event.note}`;
    events.append(li);
  }

  const statusChanged = data.status !== lastStatus;
  if (statusChanged && data.status !== "registered") resetReview();
  if (
    data.status === "review-ready" && reviewShown &&
    data.review_sha256 !== reviewDigest
  ) {
    resetReview();
  }
  if (statusChanged) decisionStatus.replaceChildren();

  if (data.registration_consent) registrationStarted = true;
  const effectiveConsent = data.registration_consent === true || registrationStarted;
  let presentation = statusPresentation(data.status, {
    reviewPassed,
    registrationConsent: effectiveConsent,
  });

  if (presentation.review === "read-only") {
    reviewPrivacy.textContent = "This review is part of the public registered record.";
    const registeredReviewAvailable = await showReview({
      registered: true,
      expectedDigest: data.registration_consent_review_sha256,
    });
    decisionStatus.textContent = registeredReviewAvailable
      ? "Registered."
      : "Registered. The review recorded with this result is not available on this private page.";
  } else if (presentation.review === "interactive") {
    await showReview();
    presentation = statusPresentation(data.status, {
      reviewPassed,
      registrationConsent: effectiveConsent,
    });
    if (effectiveConsent) {
      decisionStatus.textContent =
        "Registration is under way. The record appears once the change is merged.";
      withdrawWarning.textContent =
        "Withdrawing asks Palomar to stop registration. The registry record will not be " +
        "merged, but source-preservation or rendering work that already started may remain public.";
    }
  } else {
    reviewSection.hidden = true;
  }
  decisionSection.hidden = !presentation.register && !presentation.withdraw;
  const copy = decisionCopy(data.status, {
    reviewPassed,
    registrationConsent: effectiveConsent,
    reviewShown,
    reviewNeedsRerun,
  });
  if (copy) {
    decisionHeading.textContent = copy.heading;
    decisionIntro.textContent = copy.intro;
  }
  registerButton.hidden = !presentation.register;
  withdrawButton.hidden = !presentation.withdraw;
  const testSubmission = data.test_submission === true;
  registerButton.disabled = decisionInFlight || !presentation.register || testSubmission;
  withdrawButton.disabled = decisionInFlight || !presentation.withdraw;
  registerWarning.hidden = !presentation.register;
  withdrawWarning.hidden = !presentation.withdraw;
  if (presentation.register && testSubmission) {
    decisionIntro.textContent =
      "This test has reached the point where an ordinary accepted submission could be registered.";
    registerWarning.textContent =
      "Registration would be allowed here if this were not a technical-team test submission. " +
      "Tests can exercise review, but they cannot enter the public registry.";
  }
  if (!effectiveConsent) {
    withdrawWarning.textContent =
      "Withdrawing ends this submission. Nothing about the review or decision becomes public.";
  }
  if (data.status === "registered" && data.registered_url) {
    row("Registry record", link(data.registered_url, data.registered_url));
  }

  // Anything not settled is still moving, so keep asking. Stopping here is
  // what left a page saying "waiting for review" while the review arrived.
  askAgain(
    data.status,
    data.status === "review-ready" && reviewShown &&
      !effectiveConsent && !reviewNeedsRerun,
    ["queued", "pr-open"].includes(data.repair?.status),
  );
  // Public annotations are an enhancement to an already complete terminal
  // page. Never hold the repository, progress, or run link behind GitHub.
  if (!structuredFailure && data.status === "verification-failed" && failedRun && shownFailureRun !== failedRun.runId) {
    legacyFailureDetails.hidden = false;
    void showVerificationFailure(data.run);
  }
}

const linkField = document.getElementById("submission-link");
const copyButton = document.getElementById("copy-link");
if (linkField) linkField.value = location.href;
copyButton?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(linkField.value);
    copyButton.textContent = "Copied";
  } catch {
    // No clipboard permission: select it so it can be copied by hand.
    linkField.select();
    copyButton.textContent = "Press to copy";
  }
});

(async () => {
  if (token && !(await establishSession())) {
    summary.textContent = "This submission could not be found.";
    return;
  }
  poll();
})();
