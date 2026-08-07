// The access token lives in the URL fragment, which browsers never send to a
// server. It is posted once in exchange for a short-lived cookie, then removed
// from the address bar, so it never appears in a request path or a log.
const token = location.hash.replace(/^#/, "");
const summary = document.getElementById("summary");
const details = document.getElementById("details");
const events = document.getElementById("events");
const progress = document.getElementById("progress-detail");
const reviewSection = document.getElementById("review-section");
const reviewSummary = document.getElementById("review-summary");
const reviewBody = document.getElementById("review-body");
const decisionStatus = document.getElementById("decision-status");
const registerButton = document.getElementById("register");
const withdrawButton = document.getElementById("withdraw");

const DECISIONS = {
  accept: "Accepted",
  revise: "Revision requested",
  reject: "Not accepted",
};

const LABELS = {
  verifying: "Mechanically verifying your submission.",
  "verification-failed": "Mechanical verification did not pass.",
  "awaiting-review": "Verification passed. Waiting for the automated review.",
  reviewing: "Running the automated review.",
  "review-ready": "Your automated review is ready.",
  "review-failed":
    "Palomar could not complete the automated review. This is a fault at our end, " +
    "not with your submission. Keep this link; the operators can see it and will " +
    "look into it.",
  registered: "Registered in the registry.",
  withdrawn: "Withdrawn.",
};

// What the automated review is, said once, where someone is waiting for it.
const REVIEW_EXPLANATION =
  "The automated review checks that your formal statements agree with the informal " +
  "account of them, wherever you have written it: module documentation or docstrings " +
  "in the Challenge, the README, or formalization.yaml. It also judges whether the " +
  "result is plausibly interesting to some mathematician.";

// Nothing is running for a submission in these states, so the page stops
// asking. Everything else is in motion and the page keeps itself current.
const SETTLED = new Set([
  "verification-failed", "registered", "withdrawn",
  // Nothing further happens without an operator, so the page stops asking.
  "review-failed",
]);

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

async function showReview() {
  if (reviewShown) return;
  const response = await fetch("/api/review", { credentials: "same-origin" });
  if (response.status === 409) {
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
    registerButton.hidden = true;
    return;
  }
  if (!response.ok) return;
  const review = await response.json();
  reviewNeedsRerun = false;
  reviewShown = true;
  reviewSummary.replaceChildren();
  reviewBody.replaceChildren();
  row("Decision", DECISIONS[review.decision] ?? "Review unavailable", reviewSummary);
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
  paragraphs("AI review comments", review.warnings);
  reviewSection.hidden = false;
  registerButton.hidden = review.decision !== "accept";
}

async function decide(button, path, confirmation) {
  if (!window.confirm(confirmation)) return;
  registerButton.disabled = true;
  withdrawButton.disabled = true;
  decisionStatus.textContent = "Working…";
  const response = await fetch(path, { method: "POST", credentials: "same-origin" });
  if (!response.ok) {
    const problem = await response.json().catch(() => ({}));
    decisionStatus.textContent = `That did not work: ${problem.error ?? response.status}`;
    registerButton.disabled = false;
    withdrawButton.disabled = false;
    return;
  }
  decisionStatus.textContent = "Recorded.";
  poll();
}

registerButton?.addEventListener("click", () =>
  decide(
    registerButton,
    "/register",
    "Palomar is pre-launch. The record, review, repository, commit, and your " +
      "identity become public during testing, and immutable source-preservation " +
      "tags are created. The database may still be reshaped until launch. Register?",
  ),
);
withdrawButton?.addEventListener("click", () =>
  decide(
    withdrawButton,
    "/withdraw",
    "Withdrawing ends this submission. Nothing about the review or the " +
      "decision becomes public. Withdraw?",
  ),
);

function link(href, text) {
  const a = document.createElement("a");
  a.href = href;
  a.textContent = text;
  a.rel = "noreferrer";
  return a;
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

async function poll() {
  let data;
  try {
    const response = await fetch("/api/submission", { credentials: "same-origin" });
    if (!response.ok) { summary.textContent = "This submission could not be found."; return; }
    data = await response.json();
  } catch { summary.textContent = "Could not reach the server. Retrying."; setTimeout(poll, 8000); return; }

  summary.textContent = LABELS[data.status] ?? data.status;
  progress.replaceChildren();

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
  if (data.run?.url) row("Verification run", link(data.run.url, data.run.url.split("/").pop()));

  events.replaceChildren();
  for (const event of data.events ?? []) {
    const li = document.createElement("li");
    li.textContent = `${event.at} — ${event.note}`;
    events.append(li);
  }

  if (data.status === "review-ready") {
    await showReview();
    if (data.registration_consent) {
      decisionStatus.textContent =
        "Registration is under way. The record appears once the change is merged.";
      registerButton.disabled = true;
      withdrawButton.disabled = true;
    }
  } else {
    reviewSection.hidden = data.status !== "registered";
  }
  if (data.status === "registered" && data.registered_url) {
    row("Registry record", link(data.registered_url, data.registered_url));
  }

  // Anything not settled is still moving, so keep asking. Stopping here is
  // what left a page saying "waiting for review" while the review arrived.
  if (!SETTLED.has(data.status)) {
    const waitingOnAPerson =
      data.status === "review-ready" && !data.registration_consent && !reviewNeedsRerun;
    if (!waitingOnAPerson) setTimeout(poll, 6000);
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
