// The access token lives in the URL fragment, which browsers never send to a
// server. It is posted once in exchange for a short-lived cookie, then removed
// from the address bar, so it never appears in a request path or a log.
const token = location.hash.replace(/^#/, "");
const summary = document.getElementById("summary");
const details = document.getElementById("details");
const events = document.getElementById("events");
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
  escalate: "Escalated: a specialist review is needed",
};

const SCORE_LABELS = {
  statement_alignment: "Statement alignment",
  definition_fidelity: "Definition fidelity",
  notability: "Notability",
  literature: "Literature",
  clarity: "Clarity",
};

const LABELS = {
  verifying: "Mechanically verifying your submission.",
  "verification-failed": "Mechanical verification did not pass.",
  "awaiting-review": "Verification passed. Waiting for editorial review.",
  "review-ready": "Your editorial review is ready.",
  registered: "Registered in the registry.",
  withdrawn: "Withdrawn.",
};

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

async function showReview() {
  if (reviewShown) return;
  const response = await fetch("/api/review", { credentials: "same-origin" });
  if (!response.ok) return;
  const review = await response.json();
  reviewShown = true;
  reviewSummary.replaceChildren();
  reviewBody.replaceChildren();
  row("Decision", DECISIONS[review.decision] ?? review.decision, reviewSummary);
  row("Reviewed", review.reviewed_at ?? "", reviewSummary);
  row("Reviewer models", (review.reviewer_models ?? []).join(", "), reviewSummary);
  for (const [key, label] of Object.entries(SCORE_LABELS)) {
    if (review.scores?.[key] != null) row(label, `${review.scores[key]} of 5`, reviewSummary);
  }
  const summaryText = document.createElement("p");
  summaryText.textContent = review.summary ?? "";
  reviewBody.append(summaryText);
  paragraphs("Requested changes", review.requested_changes);
  paragraphs("Warnings", review.warnings);
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
    "Registration is permanent. The record, the review, and your repository " +
      "and commit become public, and Palomar records are never removed. Register?",
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
  details.replaceChildren();
  row("Repository", link(`https://github.com/${data.repository}`, data.repository));
  row("Commit", data.commit);
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

  if (data.status === "verifying" || (data.status === "review-ready" && data.registration_consent)) {
    setTimeout(poll, 6000);
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
