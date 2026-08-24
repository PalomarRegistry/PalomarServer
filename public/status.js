import { SETTLED, nextPollDelay, pollFailureAction } from "/polling.js";
import {
  AUTOMATION_METHOD_SUGGESTIONS,
  canAddClassification,
  classificationMaximum,
  FORMALIZATION_FIELDS,
  FORMALIZATION_PROFILE_VERSION,
  LEGACY_REPAIR_FIELDS,
  lines,
  safeDraft,
  sourceContributorLines,
  sourceContributorText,
  SOURCE_ENDORSEMENT_SUGGESTIONS,
  SOURCE_RELATIONSHIP_SUGGESTIONS,
} from "/formalization-profile.js";
import { normalizedRepairEdits } from "/repair-contract.js";
import {
  canonicalClassification,
  classificationProblem,
  shouldShowDiagnostic,
  taxonomyIndex,
} from "/repair-form-contract.js";
import {
  actionableVerificationErrors,
  decisionCopy,
  statusPresentation,
  verificationRunLocation,
  waitingMessage as waitingStatusMessage,
} from "/statuses.js";
import { submissionRequest, validSubmissionToken } from "/submission-request.js";

// The access token lives in the URL fragment, which browsers never send to a
// server automatically. Every private call presents this tab's token in a
// header and omits cookies, so two open submissions cannot replace one
// another's browser credential.
const token = location.hash.replace(/^#/, "");
const validToken = validSubmissionToken(token);
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
const defaultRegisterWarning = registerWarning.textContent.trim().replace(/\s+/g, " ");
const missingMathlibCacheWarning =
  "This project depends on Mathlib, but we couldn't find a usable cache for the " +
  "Mathlib commit you depend on. This will make your repository much harder for " +
  "users to compile, because they will have to rebuild Mathlib themselves. Consider " +
  "updating your Mathlib dependency to a version with a cache, and resubmitting.";

const LABELS = {
  preflighting: "Checking your submission before full verification.",
  "preflight-reporting": "Preflight finished. Palomar is preparing the details.",
  "changes-required": "Palomar found repository metadata that needs changing.",
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
  "registration-paused":
    "Registration is paused while Palomar's operators address a problem.",
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

function setRepairStatus(text = "", { busy = false } = {}) {
  repairStatus.replaceChildren();
  if (!text) return;
  repairStatus.append(document.createTextNode(text));
  if (busy) {
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");
    repairStatus.append(" ", spinner);
  }
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
let reviewAllowsRegistration = false;
let registrationStarted = false;
let decisionInFlight = false;
// The digest of the review on the page, sent back with a registration so that
// consent names the bytes that were read.
let reviewDigest = null;

function resetReview() {
  reviewShown = false;
  reviewNeedsRerun = false;
  reviewAllowsRegistration = false;
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
  const response = await submissionRequest(token, "/api/review");
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
    reviewAllowsRegistration = false;
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
  reviewAllowsRegistration = review.blocking_problems_identified === false;
  reviewDigest = review.review_sha256 ?? null;
  reviewSummary.replaceChildren();
  reviewBody.replaceChildren();
  const reviewStatus = review.blocking_problems_identified
    ? "Problems were identified."
    : review.has_nonblocking_warnings
      ? "No blocking problems were identified."
      : "No problems were identified.";
  row("Automated review", reviewStatus, reviewSummary);
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
  const response = await submissionRequest(token, path, {
    method: "POST",
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
        "findings become public. Withdraw?",
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

function showReviewCreditOutage() {
  const zulip = link(
    "https://leanprover.zulipchat.com/#narrow/channel/621638-Palomar",
    "Palomar channel on Zulip",
  );
  const leanFro = link("https://lean-lang.org/fro/", "Lean FRO");
  const icarm = link("https://icarm.io/donate/", "ICARM");
  summary.replaceChildren(
    "It looks like Palomar is temporarily out of API credits! Please let us know in the ",
    zulip,
    ". Please also consider donating to the ",
    leanFro,
    " and ",
    icarm,
    ", which are currently carrying Palomar's bills.",
  );
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

function formalizationDiagnosticText(text, field) {
  if (typeof text !== "string") return "";
  const prefix = `formalization.yaml field ${field}`;
  if (text.startsWith(prefix)) return text.slice(prefix.length).trimStart();
  if (text.startsWith(field)) return text.slice(field.length).trimStart();
  return text;
}

function diagnosticHeading(diagnostic) {
  const heading = document.createElement("h3");
  const summary = diagnostic.summary ?? "A check did not pass";
  if (diagnostic.stage !== "formalization" || !diagnostic.field) {
    heading.textContent = summary;
    return heading;
  }
  const field = el("code", diagnostic.field);
  field.className = "diagnostic-field";
  heading.append(field);
  const detail = formalizationDiagnosticText(summary, diagnostic.field);
  if (detail) heading.append(` ${detail}`);
  return heading;
}

function textControl(name, value = "", { required = false, placeholder = "" } = {}) {
  const input = document.createElement("input");
  input.dataset.part = name;
  input.value = value;
  input.required = required;
  input.maxLength = 2048;
  input.placeholder = placeholder;
  return input;
}

function sourceTypeControl(value = "") {
  const input = textControl("type", value, {
    placeholder: "article, paper, book, formalization, …",
  });
  input.maxLength = 200;
  return input;
}

const taxonomies = new Map();

function taxonomy(field) {
  const name = field === "classification.arxiv" ? "arxiv-categories" : "msc2020-codes";
  if (taxonomies.has(name)) return taxonomies.get(name);
  const list = document.createElement("datalist");
  list.id = `repair-${name}`;
  document.body.append(list);
  const result = { list, index: null, ready: false };
  taxonomies.set(name, result);
  result.loaded = fetch(`/taxonomies/${name}.json`, { credentials: "same-origin" })
    .then((response) => {
      if (!response.ok) throw new Error("taxonomy unavailable");
      return response.json();
    })
    .then((data) => {
      result.index = taxonomyIndex(data);
      const fragment = document.createDocumentFragment();
      for (const [code, summary] of result.index?.entries ?? []) {
        const item = document.createElement("option");
        item.value = code;
        // Browsers match datalist labels as well as values, so an MSC code can
        // be found by typing words from its standard summary.
        if (summary) {
          item.label = summary;
          item.textContent = summary;
        }
        fragment.append(item);
      }
      list.replaceChildren(fragment);
      result.ready = true;
      validateRepairForm();
    })
    .catch(() => {
      // A taxonomy fetch failure must not falsely reject a code. The repair
      // workflow validates the completed metadata before opening its PR.
      result.ready = true;
      validateRepairForm();
    });
  return result;
}

function removeRepeatableRow(row, replacement) {
  const rows = row.parentElement;
  row.remove();
  if (rows && rows.children.length === 0) rows.append(replacement());
  validateRepairForm();
}

let classificationRowSequence = 0;

function classificationRow(field, value = "", onRowsChanged = () => {}, prefilled = false) {
  const row = document.createElement("div");
  row.className = "repair-classification";
  const input = textControl("code", value, { required: true });
  if (prefilled) input.dataset.originallyInvalid = "true";
  const source = taxonomy(field);
  input.setAttribute("list", source.list.id);
  input.setAttribute(
    "aria-label",
    field === "classification.msc2020"
      ? "MSC 2020 classification code"
      : "arXiv classification code",
  );
  const summary = el("p", "");
  summary.className = "hint classification-summary";
  summary.id = `repair-classification-summary-${++classificationRowSequence}`;
  summary.hidden = true;
  input.setAttribute("aria-describedby", summary.id);
  const showSummary = () => {
    const canonical = canonicalClassification(input.value, source.index);
    const description = field === "classification.msc2020" && canonical
      ? source.index.summaries.get(canonical) ?? ""
      : "";
    summary.textContent = description;
    summary.hidden = !description;
  };
  input.addEventListener("input", showSummary);
  input.addEventListener("change", () => {
    const canonical = canonicalClassification(input.value, source.index);
    if (canonical) input.value = canonical;
    showSummary();
    validateRepairForm();
  });
  void source.loaded.then(() => {
    showSummary();
    validateRepairForm();
  });
  const remove = el("button", "Remove");
  remove.type = "button";
  remove.className = "secondary compact";
  remove.addEventListener("click", () => {
    removeRepeatableRow(row, () => classificationRow(field, "", onRowsChanged));
    onRowsChanged();
  });
  row.append(input, remove, summary);
  return row;
}

function sourceRow(value = {}, prefilled = false) {
  const row = document.createElement("fieldset");
  row.className = "repair-repeatable";
  row.dataset.kind = "source";
  row.append(el("legend", "Source"));
  const guidance = el(
    "p",
    "Relationship describes what this formalization does with the source: " +
      "formalizes follows it, adapts changes it, independently-proves reaches the same result, " +
      "background supplies context, and other covers an original proof or another relationship. " +
      "Source-author response records whether an author was contacted or involved; leave it " +
      "unspecified when it does not apply. Use Source note to explain an other category.",
  );
  guidance.className = "hint";
  row.append(guidance);
  const relationship = textControl("relationship", value.relationship, {
    required: true,
    placeholder: SOURCE_RELATIONSHIP_SUGGESTIONS.join(", "),
  });
  relationship.maxLength = 500;
  relationship.required = true;
  if (prefilled && !relationship.value.trim()) {
    relationship.dataset.originallyInvalid = "true";
  }
  const title = textControl("title", value.title, { required: true });
  if (prefilled && !title.value.trim()) title.dataset.originallyInvalid = "true";
  for (const [labelText, control] of [
    ["Title", title],
    ["Authors", (() => {
      const input = document.createElement("textarea");
      input.dataset.part = "authors";
      input.rows = 2;
      input.value = (value.authors ?? []).join("\n");
      return input;
    })()],
    ["Other source credits", (() => {
      const input = document.createElement("textarea");
      input.dataset.part = "contributors";
      input.rows = 2;
      input.placeholder = "Name | role (one credit per line)";
      input.value = sourceContributorText(value.contributors);
      return input;
    })()],
    ["Type", sourceTypeControl(value.type)],
    ["Relationship", relationship],
    ["Source note", (() => {
      const input = document.createElement("textarea");
      input.dataset.part = "note";
      input.rows = 3;
      input.maxLength = 10_000;
      input.placeholder = "Explain relationship or source-author response: other";
      input.value = value.note ?? "";
      return input;
    })()],
    ["Identifier", textControl("id", value.id, { placeholder: "DOI, arXiv id, URL, or citation" })],
    ["Location", textControl("location", value.location)],
    ["License", textControl("license", value.license)],
    ["Source-author response", (() => {
      const input = textControl("author_endorsement", value.author_endorsement, {
        placeholder: SOURCE_ENDORSEMENT_SUGGESTIONS.join(", "),
      });
      input.maxLength = 100;
      return input;
    })()],
  ]) {
    const label = el("label", labelText);
    label.append(control);
    row.append(label);
  }
  const remove = el("button", "Remove source");
  remove.type = "button";
  remove.className = "secondary compact";
  remove.addEventListener("click", () => removeRepeatableRow(row, () => sourceRow()));
  row.append(remove);
  return row;
}

function methodRow(value = {}) {
  const row = document.createElement("fieldset");
  row.className = "repair-repeatable";
  row.dataset.kind = "method";
  row.append(el("legend", "Method"));
  const guidance = el(
    "p",
    "Choose the closest production category: manual for work written without generative assistance, copilot for interactive " +
      "suggestions, agent for a directed coding agent, autonomous for an independently run " +
      "system, or other. Framework and model names carry the exact provenance detail.",
  );
  guidance.className = "hint";
  row.append(guidance);
  const method = textControl("method", value.method, {
    required: true,
    placeholder: AUTOMATION_METHOD_SUGGESTIONS.join(", "),
  });
  method.maxLength = 500;
  method.required = true;
  const framework = textControl("framework", value.framework, { placeholder: "Optional framework or tool" });
  const models = document.createElement("textarea");
  models.dataset.part = "models";
  models.rows = 2;
  models.placeholder = "Optional model names, one per line";
  models.value = (value.models ?? []).join("\n");
  for (const [labelText, control] of [["Method", method], ["Framework", framework], ["Models", models]]) {
    const label = el("label", labelText);
    label.append(control);
    row.append(label);
  }
  const remove = el("button", "Remove method");
  remove.type = "button";
  remove.className = "secondary compact";
  remove.addEventListener("click", () => removeRepeatableRow(row, () => methodRow()));
  row.append(remove);
  return row;
}

function appendRepairControl(wrapper, diagnostic, profile, failure) {
  const field = diagnostic.field;
  const draft = safeDraft(failure, field);
  wrapper.dataset.field = field;
  if (["text", "people"].includes(profile.input)) {
    const input = profile.input === "text" ? document.createElement("input") : document.createElement("textarea");
    input.name = field;
    input.dataset.inputType = profile.input;
    input.required = true;
    input.maxLength = profile.input === "text" ? 500 : 4000;
    if (input instanceof HTMLTextAreaElement) input.rows = profile.input === "people" ? 3 : 2;
    input.value = Array.isArray(draft) ? draft.join("\n") : draft ?? "";
    if (!input.value.trim()) input.dataset.originallyInvalid = "true";
    wrapper.append(input);
    return;
  }
  if (profile.input === "text-list") {
    const rows = document.createElement("div");
    rows.dataset.rows = "classifications";
    const maximum = classificationMaximum(field);
    let updateAdd = () => {};
    const values = (Array.isArray(draft) && draft.length ? draft : [""]).slice(0, maximum);
    for (const value of values) {
      rows.append(classificationRow(field, value, () => updateAdd(), true));
    }
    const add = el("button", "Add another classification");
    add.type = "button";
    add.className = "secondary compact";
    updateAdd = () => {
      add.hidden = !canAddClassification(field, rows.children.length);
    };
    add.addEventListener("click", () => {
      if (canAddClassification(field, rows.children.length)) {
        rows.append(classificationRow(field, "", () => updateAdd()));
        validateRepairForm();
      }
      updateAdd();
    });
    wrapper.append(rows, add);
    updateAdd();
    return;
  }
  if (profile.input === "sources") {
    const rows = document.createElement("div");
    rows.dataset.rows = "sources";
    for (const value of Array.isArray(draft) && draft.length ? draft : [{}]) {
      rows.append(sourceRow(value, true));
    }
    const add = el("button", "Add another source");
    add.type = "button";
    add.className = "secondary compact";
    add.addEventListener("click", () => {
      rows.append(sourceRow());
      validateRepairForm();
    });
    wrapper.append(rows, add);
    return;
  }
  if (profile.input === "methods") {
    const rows = document.createElement("div");
    rows.dataset.rows = "methods";
    for (const value of Array.isArray(draft) && draft.length ? draft : [{ method: "manual" }]) {
      rows.append(methodRow(value));
    }
    const add = el("button", "Add another method");
    add.type = "button";
    add.className = "secondary compact";
    add.addEventListener("click", () => {
      rows.append(methodRow());
      validateRepairForm();
    });
    wrapper.append(rows, add);
    return;
  }
  const repository = textControl("id", draft?.id, { required: true, placeholder: "owner/repository" });
  const revision = textControl("revision", draft?.revision, { required: true, placeholder: "40-character commit" });
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.value.trim())) {
    repository.dataset.originallyInvalid = "true";
  }
  if (!/^[0-9a-f]{40}$/i.test(revision.value.trim())) {
    revision.dataset.originallyInvalid = "true";
  }
  repository.name = `${field}.id`;
  revision.name = `${field}.revision`;
  for (const [labelText, control] of [["Repository", repository], ["Commit", revision]]) {
    const label = el("label", labelText);
    label.append(control);
    wrapper.append(label);
  }
}

function rowValue(row) {
  const value = {};
  for (const control of row.querySelectorAll("[data-part]")) {
    const item = control.dataset.part === "contributors"
      ? sourceContributorLines(control.value)
      : control.dataset.part === "authors" || control.dataset.part === "models"
        ? lines(control.value) : control.value.trim();
    if (Array.isArray(item) ? item.length : item) value[control.dataset.part] = item;
  }
  return value;
}

function repairEdit(wrapper) {
  const field = wrapper.dataset.field;
  const profile = FORMALIZATION_FIELDS[field];
    if (profile.input === "people") {
      return { field, value: lines(wrapper.querySelector("[name]").value) };
    }
    if (profile.input === "text-list") {
      return {
        field,
        value: [...wrapper.querySelectorAll('[data-rows="classifications"] [data-part="code"]')]
          .map((input) => input.value.trim()).filter(Boolean),
      };
    }
    if (profile.input === "text") {
      return { field, value: wrapper.querySelector("[name]").value.trim() };
    }
    if (profile.input === "sources" || profile.input === "methods") {
      return {
        field,
        value: [...wrapper.querySelectorAll(`[data-kind="${profile.input === "sources" ? "source" : "method"}"]`)].map(rowValue),
      };
    }
    return { field, value: {
      id: wrapper.querySelector('[data-part="id"]').value.trim(),
      revision: wrapper.querySelector('[data-part="revision"]').value.trim().toLowerCase(),
    } };
}

function repairEdits() {
  return [...repairFields.querySelectorAll(".repair-field")].map(repairEdit);
}

let validationMessageSequence = 0;
let repairValidationAttempted = false;

function controlValidationMessage(control) {
  const classification = control.closest(".repair-classification")
    ?.querySelector(".classification-summary");
  if (classification) return classification;
  if (control.dataset.validationMessage) {
    return document.getElementById(control.dataset.validationMessage);
  }
  const message = el("p", "");
  message.id = `repair-validation-${++validationMessageSequence}`;
  message.className = "hint warning repair-validation";
  message.hidden = true;
  control.dataset.validationMessage = message.id;
  control.setAttribute(
    "aria-describedby",
    [control.getAttribute("aria-describedby"), message.id].filter(Boolean).join(" "),
  );
  control.insertAdjacentElement("afterend", message);
  return message;
}

function setControlValidity(control, message = "") {
  control.setCustomValidity(message);
  const show = Boolean(message) &&
    (repairValidationAttempted || control.dataset.touched === "true" ||
      control.dataset.originallyInvalid === "true");
  control.setAttribute("aria-invalid", String(show));
  const visibleMessage = controlValidationMessage(control);
  visibleMessage.textContent = show ? message : "";
  visibleMessage.hidden = !show;
  return !message;
}

function setGroupProblem(wrapper, message = "") {
  let node = wrapper.querySelector(":scope > .repair-group-validation");
  if (!node) {
    node = el("p", "");
    node.className = "hint warning repair-group-validation";
    node.setAttribute("role", "status");
    wrapper.append(node);
  }
  const show = Boolean(message);
  node.textContent = show ? message : "";
  node.hidden = !show;
}

function validateClassification(wrapper, field) {
  const inputs = [...wrapper.querySelectorAll('[data-part="code"]')];
  const maximum = field === "classification.arxiv" ? 2 : 8;
  const source = taxonomy(field);
  const values = inputs.map((input) => input.value.trim());
  let complete = inputs.length >= 1 && inputs.length <= maximum;
  for (const [position, input] of inputs.entries()) {
    const value = input.value.trim();
    const message = classificationProblem(
      value,
      source.index,
      source.ready,
      values.filter((_, index) => index !== position),
    );
    complete = setControlValidity(input, message) && complete;
    const summary = input.closest(".repair-classification")
      ?.querySelector(".classification-summary");
    if (summary) {
      const canonical = canonicalClassification(value, source.index);
      const description = field === "classification.msc2020" && canonical
        ? source.index.summaries.get(canonical) ?? ""
        : "";
      const showMessage = Boolean(message) &&
        (repairValidationAttempted || input.dataset.touched === "true");
      summary.textContent = showMessage ? message : description;
      summary.classList.toggle("warning", showMessage);
      summary.hidden = !(showMessage || description);
    }
  }
  return complete;
}

function validateRepairField(wrapper) {
  const field = wrapper.dataset.field;
  const profile = FORMALIZATION_FIELDS[field];
  let complete = true;
  if (profile.input === "text" || profile.input === "people") {
    const input = wrapper.querySelector("[name]");
    complete = setControlValidity(input, input.value.trim() ? "" : "Complete this field.");
  } else if (profile.input === "text-list") {
    complete = validateClassification(wrapper, field);
  } else if (profile.input === "sources") {
    const rows = [...wrapper.querySelectorAll('[data-kind="source"]')];
    complete = rows.length > 0;
    for (const row of rows) {
      for (const control of row.querySelectorAll("[data-part]")) {
        let message = "";
        if (control.dataset.part === "title" && !control.value.trim()) {
          message = "Enter a source title.";
        } else if (control.dataset.part === "relationship" && !control.value.trim()) {
          message = "Describe the source relationship.";
        }
        complete = setControlValidity(control, message) && complete;
      }
    }
    let groupProblem = "";
    if (complete) {
      try {
        normalizedRepairEdits([{ field, value: rows.map(rowValue) }], 2);
      } catch (error) {
        groupProblem = error instanceof Error ? error.message : "Check these sources.";
        complete = false;
      }
    }
    setGroupProblem(wrapper, groupProblem);
  } else if (profile.input === "methods") {
    const rows = [...wrapper.querySelectorAll('[data-kind="method"]')];
    complete = rows.length > 0;
    for (const control of wrapper.querySelectorAll('[data-part="method"]')) {
      const message = control.value.trim() ? "" : "Describe the automation method.";
      complete = setControlValidity(control, message) && complete;
    }
  } else {
    const repository = wrapper.querySelector('[data-part="id"]');
    const revision = wrapper.querySelector('[data-part="revision"]');
    const repositoryValid = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.value.trim());
    const revisionValid = /^[0-9a-f]{40}$/i.test(revision.value.trim());
    complete = setControlValidity(
      repository,
      repositoryValid ? "" : "Enter the repository as owner/name.",
    ) && complete;
    complete = setControlValidity(
      revision,
      revisionValid ? "" : "Enter a full 40-character commit.",
    ) && complete;
  }
  let contractProblem = "";
  if (complete) {
    try {
      normalizedRepairEdits([repairEdit(wrapper)], 2);
    } catch (error) {
      contractProblem = error instanceof Error ? error.message : "Check this field.";
      complete = false;
    }
  }
  if (contractProblem && ["text", "people"].includes(profile.input)) {
    setControlValidity(wrapper.querySelector("[name]"), contractProblem);
  } else if (profile.input !== "sources") {
    setGroupProblem(wrapper, contractProblem);
  }
  wrapper.dataset.needsAction = String(!complete);
  return complete;
}

function validateRepairForm() {
  if (!repairForm || repairForm.hidden) return false;
  const fields = [...repairFields.querySelectorAll(".repair-field")];
  let complete = fields.length > 0;
  for (const field of fields) complete = validateRepairField(field) && complete;
  return complete;
}

repairFields?.addEventListener("input", validateRepairForm);
repairFields?.addEventListener("change", validateRepairForm);
repairFields?.addEventListener("focusout", (event) => {
  if (event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLSelectElement) {
    event.target.dataset.touched = "true";
    validateRepairForm();
  }
});

function showStructuredFailure(data) {
  const failure = data.failure;
  const diagnostics = Array.isArray(failure?.diagnostics) ? failure.diagnostics : [];
  if (!diagnostics.length) return false;
  verificationFailureSection.hidden = false;
  legacyFailureDetails.hidden = true;
  failureDiagnostics.replaceChildren();
  failureHeading.textContent = failure.phase === "preparation" || failure.mode === "preflight"
    ? "Preparation found these problems"
    : "Verification needs attention";
  const repairable = new Map();
  for (const diagnostic of diagnostics) {
    const profile = FORMALIZATION_FIELDS[diagnostic.field];
    if (
      diagnostic.repairable === true && profile &&
      (failure.profile_version === FORMALIZATION_PROFILE_VERSION ||
        (failure.profile_version === 1 && LEGACY_REPAIR_FIELDS.has(diagnostic.field)))
    ) repairable.set(diagnostic.field, { diagnostic, profile });
  }
  const canRequestRepair = data.status === "changes-required" && !data.repair &&
    [1, FORMALIZATION_PROFILE_VERSION].includes(failure.profile_version) && repairable.size > 0 &&
    diagnostics.every((item) =>
      item.owner === "submitter" && item.repairable === true && FORMALIZATION_FIELDS[item.field]);
  const repairedFields = new Set(repairable.keys());
  const repairInFlight = Boolean(data.repair) &&
    ["queued", "preparing", "pr-open", "merged"].includes(data.repair.status);
  const shown = diagnostics.filter((diagnostic) =>
    shouldShowDiagnostic(diagnostic, canRequestRepair || repairInFlight, repairedFields));
  for (const diagnostic of shown) {
    const article = document.createElement("article");
    article.className = "diagnostic";
    article.append(diagnosticHeading(diagnostic));
    const location = diagnostic.stage === "formalization" && diagnostic.location?.path === "formalization.yaml"
      ? ""
      : diagnosticLocation(diagnostic.location);
    if (location) {
      const locationNode = el("p", location);
      locationNode.className = "location";
      article.append(locationNode);
    }
    const explanation = diagnostic.stage === "formalization" && diagnostic.field
      ? formalizationDiagnosticText(diagnostic.explanation, diagnostic.field)
      : diagnostic.explanation;
    const summary = diagnostic.stage === "formalization" && diagnostic.field
      ? formalizationDiagnosticText(diagnostic.summary, diagnostic.field)
      : diagnostic.summary;
    if (explanation && explanation !== summary) {
      // A quoted tool failure is program output, not prose. Its line breaks are
      // the difference between a readable error and one long run-on sentence,
      // and the summary already stands above it as the heading.
      const body = explanation.startsWith(summary)
        ? explanation.slice(summary.length).trim()
        : explanation;
      if (body.includes("\n")) {
        const output = document.createElement("pre");
        output.className = "tool-output";
        output.textContent = body;
        article.append(output);
      } else if (body) {
        article.append(el("p", body));
      }
    }
    if (diagnostic.owner !== "submitter") {
      article.append(el("p", "Palomar must fix this."));
    }
    if (
      diagnostic.next_action &&
      diagnostic.next_action !==
        "Complete the guided metadata form and let Palomar prepare a pull request."
    ) article.append(el("p", `Next: ${diagnostic.next_action}`));
    failureDiagnostics.append(article);
  }
  if (data.repair && !shown.length) {
    failureIntro.textContent = "Palomar's metadata repair result is shown below.";
  } else if (
    // Only metadata problems are fixed by editing `formalization.yaml`. Saying
    // so about a Lean or Comparator failure sends the submitter to the wrong
    // file, which is what a comparator failure used to do.
    shown.length &&
    diagnostics.every((item) => item.owner === "submitter" && item.stage === "formalization")
  ) {
    failureIntro.replaceChildren(
      "Update the ",
      el("code", "formalization.yaml"),
      " file in the repository, and resubmit using the updated commit.",
    );
  } else if (shown.length) {
    failureIntro.textContent = "Follow the action on each item. If an item says Palomar must fix it, no repository change is needed for that item.";
  } else {
    failureIntro.textContent = "Complete the highlighted metadata fields below.";
  }
  if (data.repair) {
    failureHeading.textContent = shown.length ? "Metadata repair needs attention" : "Metadata repair";
  } else if (!shown.length && (failure.phase === "preparation" || failure.mode === "preflight")) {
    failureHeading.textContent = "Complete the metadata form";
  }

  repairFields.replaceChildren();
  repairForm.hidden = !canRequestRepair;
  repairExplanation.hidden = !canRequestRepair;
  repairSubmit.hidden = !canRequestRepair;
  if (canRequestRepair) {
    for (const { diagnostic, profile } of repairable.values()) {
      const wrapper = document.createElement("div");
      wrapper.className = "repair-field";
      const id = `repair-${diagnostic.field.replaceAll(".", "-")}`;
      const label = el("label", profile.label);
      label.htmlFor = id;
      const hint = el("p", profile.description);
      const origin = failure.repair_draft?.origins?.[diagnostic.field];
      if (origin) hint.append(` Palomar carried this value forward from ${origin}; confirm it before submitting.`);
      hint.className = "hint";
      wrapper.append(label);
      appendRepairControl(wrapper, diagnostic, profile, failure);
      const firstControl = wrapper.querySelector("input, textarea, select");
      if (firstControl) firstControl.id = id;
      wrapper.append(hint);
      repairFields.append(wrapper);
    }
    validateRepairForm();
  }
  if (data.repair) {
    repairForm.hidden = false;
    repairExplanation.hidden = true;
    repairSubmit.hidden = true;
    repairFields.replaceChildren();
    const messages = {
      queued: "Preparing the pull request…",
      preparing: "Preparing the pull request…",
      "pr-open": "Palomar opened a pull request. Review and merge it, then make a new submission.",
      merged: "The repair pull request was merged. Make a new submission using the merged commit.",
      "needs-input": "Palomar could not safely prepare this change. Use the explanation below to update the file manually.",
      failed: "Palomar could not create the repair pull request. This is a fault at our end; you can still make the changes manually.",
      closed: "The repair pull request was closed without merging. Update the file manually or make a new submission after changing it.",
    };
    const preparing = ["queued", "preparing"].includes(data.repair.status);
    const explanationIsStatus = ["queued", "preparing", "pr-open", "merged"].includes(
      data.repair.status,
    );
    const repairMessage = data.repair.explanation && !explanationIsStatus
      ? data.repair.explanation
      : messages[data.repair.status] ?? `Repair status: ${data.repair.status}`;
    setRepairStatus(repairMessage, { busy: preparing });
    if (data.repair.pr_url) repairStatus.append(" ", link(data.repair.pr_url, "View the pull request."));
    if (data.repair.patch && !data.repair.pr_url) {
      const disclosure = document.createElement("details");
      const summary = el("summary", "Apply the proposed patch manually");
      const pre = document.createElement("pre");
      pre.textContent = data.repair.patch;
      disclosure.append(summary, pre);
      repairFields.append(disclosure);
    }
  } else {
    setRepairStatus();
  }
  return true;
}

repairForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  repairValidationAttempted = true;
  if (!validateRepairForm() || !repairForm.checkValidity()) {
    setRepairStatus("Complete the highlighted fields before preparing the pull request.");
    repairForm.reportValidity();
    return;
  }
  const edits = repairEdits();
  setRepairStatus("Submitting the repair request…", { busy: true });
  const response = await submissionRequest(token, "/api/repair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      failure_digest: lastFailureDigest,
      profile_version: lastFailureProfileVersion,
      edits,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    setRepairStatus(`That did not work: ${body.error ?? response.status}`);
    return;
  }
  setRepairStatus("Preparing the pull request…", { busy: true });
  repairSubmit.disabled = true;
  pollDelay = 0;
  poll();
});

let lastFailureDigest = null;
let lastFailureProfileVersion = null;

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
  if (!validToken) return;
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
  if (!validToken) return;
  let data;
  try {
    const response = await submissionRequest(token, "/api/submission");
    if (!response.ok) {
      const failure = pollFailureAction(response.status);
      if (failure === "missing") {
        const recovery = el("a", "sign in with GitHub to recover your submissions");
        recovery.href = "/submissions";
        summary.replaceChildren(
          "This submission link no longer opens the record. If it predates the Cloudflare account migration, ",
          recovery,
          ".",
        );
        hideTransientSections();
        return;
      }
      if (failure === "unauthorized") {
        summary.textContent =
          "This submission link is not authorized. Open the original submission link again.";
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
  lastFailureProfileVersion = data.failure?.profile_version ?? null;
  const structuredFailure = showStructuredFailure(data);
  if (data.review_service_issue === "api-credits-exhausted") {
    showReviewCreditOutage();
  } else {
    summary.textContent = data.status === "verification-failed" && !failedRun && !structuredFailure
      ? "Palomar could not complete or recover the verification run. This is a fault at our end, not with your submission."
      : LABELS[data.status] ?? data.status;
  }
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
    reviewAllowsRegistration,
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
      reviewAllowsRegistration,
      registrationConsent: effectiveConsent,
    });
    if (effectiveConsent) {
      decisionStatus.textContent = data.status === "registration-paused"
        ? "Registration is paused while Palomar's operators address a problem."
        : "Registration is under way. The record appears once the change is merged.";
      withdrawWarning.textContent =
        "Withdrawing asks Palomar to stop registration. The registry record will not be " +
        "merged, but source-preservation or rendering work that already started may remain public.";
    }
  } else {
    reviewSection.hidden = true;
  }
  decisionSection.hidden = !presentation.register && !presentation.withdraw;
  const copy = decisionCopy(data.status, {
    reviewAllowsRegistration,
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
  registerWarning.textContent = data.mathlib_cache_available === false
    ? `${missingMathlibCacheWarning} ${defaultRegisterWarning}`
    : defaultRegisterWarning;
  if (presentation.register && testSubmission) {
    decisionIntro.textContent =
      "This test has reached the point where an ordinary submission with no identified blocking problem could be registered.";
    registerWarning.textContent =
      "Registration would be allowed here if this were not a test submission. " +
      "Tests can exercise review, but they cannot enter the public registry.";
  }
  if (!effectiveConsent) {
    withdrawWarning.textContent =
      "Withdrawing ends this submission. Nothing about the review or its findings becomes public.";
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

if (validToken) {
  poll();
} else {
  summary.textContent = "This submission could not be found.";
}
