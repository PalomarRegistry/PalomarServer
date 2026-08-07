/**
 * Progressive enhancement for the submission form.
 *
 * Everything here is convenience. The form works with this script blocked, and
 * nothing it says is trusted: the server checks the repository, the commit, the
 * submitter's push access, and the Palomar ID again, and its answers are the
 * ones that count. A check that fails here never prevents submission, because a
 * rate limit or an outage on someone else's API is not a reason to refuse
 * somebody's work.
 *
 * The lookups go straight from the browser to GitHub and to the registry data.
 * That keeps the server out of it, and it tells GitHub the repository name a
 * moment before the submission would have anyway.
 */

import {
  locateProject,
  normalizeCommit,
  normalizePalomarId,
  normalizeRepository,
} from "./normalize.js";

const REGISTRY_INDEX =
  "https://data.palomar-registry.org/index.json";

const live = document.getElementById("live-status");

/** Announce once, and only when it changes: a status region that repeats itself is noise. */
let announced = "";
function announce(message) {
  if (!live || message === announced) return;
  announced = message;
  live.textContent = message;
}

function field(name) {
  return {
    input: document.getElementById(name),
    status: document.getElementById(`${name}-status`),
    message: document.getElementById(`${name}-message`),
  };
}

function show(parts, state, message, href) {
  if (parts.status) parts.status.dataset.state = state ?? "";
  if (parts.message && message) {
    parts.message.replaceChildren();
    if (href) {
      // So the submitter can check what was found. In a new tab, because
      // leaving this page would discard everything they have typed.
      const link = document.createElement("a");
      link.href = href;
      link.textContent = message;
      link.target = "_blank";
      link.rel = "noreferrer noopener";
      parts.message.append(link);
    } else {
      parts.message.textContent = message;
    }
  }
  if (state === "found" || state === "missing") announce(message);
}

/**
 * Put the value the server will read back into the field.
 *
 * Otherwise the browser validates the `pattern` attribute against what was
 * typed while everything else validates what it means, and a commit pasted
 * with a stray space is reported as found and then refused as malformed.
 */
function settle(parts, normalize) {
  if (!parts.input) return;
  const normalized = normalize(parts.input.value);
  if (normalized !== null && normalized !== parts.input.value) {
    parts.input.value = normalized;
  }
}

/** Run the newest request only: an earlier answer must not overwrite a later one. */
function latest(run) {
  let token = 0;
  return async (...args) => {
    const mine = ++token;
    const settle = (state, message, href) => {
      if (mine === token) show(args[0], state, message, href);
    };
    await run(settle, ...args);
  };
}

function debounce(run, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => run(...args), ms);
  };
}

async function githubJson(path) {
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (response.status === 403 || response.status === 429) return "rate-limited";
  return response.ok ? response.json() : null;
}

const repository = field("repository");
const commit = field("commit");
const existingId = field("existing_id");
const DEFAULT = {
  repository: repository.message?.textContent,
  commit: commit.message?.textContent,
  existing_id: existingId.message?.textContent,
};

const checkRepository = latest(async (settle, parts) => {
  const name = normalizeRepository(parts.input.value);
  if (!name) return settle("", DEFAULT.repository);
  settle("checking", `Looking for ${name}…`);
  const data = await githubJson(`repos/${name}`);
  if (data === "rate-limited") return settle("", DEFAULT.repository);
  if (!data) return settle("missing", `No public repository called ${name}.`);
  if (data.private) return settle("missing", `${name} is private; Palomar indexes public repositories.`);
  settle("found", `Found ${data.full_name}`, `https://github.com/${data.full_name}`);
  checkCommit(commit);
});

const checkCommit = latest(async (settle, parts) => {
  const sha = normalizeCommit(parts.input.value);
  const name = normalizeRepository(repository.input.value);
  if (!sha) {
    const typed = parts.input.value.trim();
    describeLayout();
    return settle(typed ? "missing" : "", typed ? "A commit is 40 hexadecimal characters." : DEFAULT.commit);
  }
  if (!name) {
    describeLayout();
    return settle("", DEFAULT.commit);
  }
  settle("checking", "Looking for that commit…");
  const data = await githubJson(`repos/${name}/commits/${sha}`);
  if (data === "rate-limited") return settle("", DEFAULT.commit);
  if (!data?.sha) {
    describeLayout();
    return settle("missing", `That commit is not in ${name}.`);
  }
  const when = String(data.commit?.committer?.date ?? "").slice(0, 10);
  settle(
    "found",
    when ? `Found that commit, from ${when}` : "Found that commit",
    `https://github.com/${name}/commit/${sha}`,
  );
  describeLayout(name, sha);
});

const layout = document.getElementById("layout");
const layoutMessage = document.getElementById("layout-message");
const projectPath = document.getElementById("project_path");
const configPath = document.getElementById("comparator_config_path");
const metadataPath = document.getElementById("formalization_metadata_path");

function say(text, found) {
  if (!layoutMessage) return;
  layoutMessage.textContent = text;
  layoutMessage.classList.toggle("layout-found", Boolean(found));
}

/**
 * Withdraw a suggestion that no longer describes the submission.
 *
 * A path filled in for one commit is wrong for the next, and wrong in the
 * worst way: it names a directory that may well exist there too, so the
 * submission verifies against a project nobody chose. Only values this script
 * put there are cleared, and only while they are untouched, so anything typed
 * by hand survives a change of commit.
 */
function autofill(input, value) {
  if (!input) return;
  const mine = input.dataset.suggested !== undefined && input.value === input.dataset.suggested;
  if (input.value !== "" && !mine) return;
  input.value = value;
  if (value) input.dataset.suggested = value;
  else delete input.dataset.suggested;
}

const DEFAULT_LAYOUT = layoutMessage?.textContent;

/**
 * Say, on the closed disclosure, whether there is anything in here to do.
 *
 * Almost always there is not, and a heading that has to be opened to find that
 * out is a heading everybody opens. So the settled case recedes, and the case
 * worth reading keeps its weight. `unchecked` is not a claim either way: it is
 * what stands before a commit has been looked at, and after a rate limit or a
 * repository too large to list.
 */
const layoutSummary = document.getElementById("layout-summary");
const SUMMARIES = {
  unchecked: "File layout",
  ok: "File layout looks okay",
  custom: "It looks like you have a non-standard file layout",
};

function summarize(state) {
  if (!layout) return;
  layout.dataset.layout = state;
  if (layoutSummary) layoutSummary.textContent = SUMMARIES[state];
}

function clearSuggestions() {
  for (const input of [projectPath, configPath, metadataPath]) autofill(input, "");
  say(DEFAULT_LAYOUT);
  // Something typed by hand is a non-standard layout whatever the tree says,
  // and clearing the suggestions does not clear that.
  summarize([projectPath, configPath, metadataPath].some((input) => input?.value)
    ? "custom"
    : "unchecked");
}

/**
 * Work out where the project is, from the repository tree at that commit.
 *
 * A submission whose project is not at the root is acceptable and always has
 * been, but nothing said so and nothing asked. Finding it here means a
 * submitter does not discover the requirement by having their work refused.
 * Everything filled in is a suggestion they can change, and the server checks
 * the paths again regardless.
 */
let layoutToken = 0;

async function describeLayout(name, sha) {
  if (!layout) return;
  // Every exit below is a change of subject: whatever is filled in describes
  // the previous commit, and must go before anything is said about this one.
  const mine = ++layoutToken;
  const current = () => mine === layoutToken;
  clearSuggestions();
  if (!name || !sha) return;

  let tree;
  try {
    const response = await fetch(
      `https://api.github.com/repos/${name}/git/trees/${sha}?recursive=1`,
      { headers: { accept: "application/vnd.github+json" } },
    );
    if (!current()) return;
    if (response.status === 403 || response.status === 429) {
      return say("GitHub is rate-limiting this browser, so the layout was not checked. Fill these in if the project is not at the root.");
    }
    if (!response.ok) return;
    tree = await response.json();
  } catch {
    return;
  }
  if (!current() || !Array.isArray(tree.tree)) return;
  if (tree.truncated) {
    layout.open = true;
    return say("This repository is too large for GitHub to list in one request, so the layout was not checked. Fill these in if the project is not at the root.");
  }
  const where = locateProject(tree.tree);

  if (where.found && !where.project && !where.metadata) {
    summarize("ok");
    return say("The project is at the repository root, which is what Palomar expects.", true);
  }
  if (where.found && !where.project) {
    autofill(metadataPath, where.metadata);
    summarize("custom");
    return say(`The project is at the repository root, but its formalization.yaml is in ${where.metadata}, so that has been filled in.`, true);
  }
  if (where.found) {
    autofill(projectPath, where.project);
    if (where.metadata) autofill(metadataPath, where.metadata);
    layout.open = true;
    summarize("custom");
    return say(`The project looks like it is in ${where.project}, so that has been filled in. Change it if that is wrong.`, true);
  }
  layout.open = true;
  summarize("custom");
  if (where.ambiguous) {
    return say(`This repository has more than one project: ${where.candidates.join(", ")}. Say which one is being submitted.`);
  }
  say("No comparator.json was found beside a Lakefile at that commit. If the project's configuration is named something else, say where it is.");
}

// Filling one of these in by hand makes the layout non-standard whatever the
// tree looked like, and the summary should not go on saying otherwise.
for (const input of [projectPath, configPath, metadataPath]) {
  input?.addEventListener("input", () => {
    if (input.value) summarize("custom");
  });
}

const checkExistingId = latest(async (settle, parts) => {
  const typed = parts.input.value.trim();
  if (!typed) return settle("", DEFAULT.existing_id);
  const value = normalizePalomarId(typed);
  if (!value) {
    return settle("missing", "A Palomar ID looks like PALOMAR-2026-07-29-000123.");
  }
  settle("checking", "Looking for that record…");
  let entries;
  try {
    const response = await fetch(REGISTRY_INDEX, { cache: "no-store" });
    if (!response.ok) return settle("", DEFAULT.existing_id);
    entries = (await response.json())?.entries;
  } catch {
    return settle("", DEFAULT.existing_id);
  }
  if (!Array.isArray(entries)) return settle("", DEFAULT.existing_id);
  const versions = entries.filter((entry) => entry?.id === value);
  if (!versions.length) return settle("missing", `${value} is not in the registry.`);
  const current = Math.max(...versions.map((entry) => Number(entry.version) || 0));
  settle(
    "found",
    `Found ${value}; this would become version ${current + 1}`,
    `https://palomar-registry.org/entry.html?id=${value}&version=${current}`,
  );
});

for (const [parts, check, normalize] of [
  [repository, checkRepository, normalizeRepository],
  [commit, checkCommit, normalizeCommit],
  [existingId, checkExistingId, normalizePalomarId],
]) {
  parts.input?.addEventListener("input", debounce(() => check(parts), 400));
  // Settled when the field is left, not while it is being typed in, which
  // would move the caret out from under whoever is typing.
  parts.input?.addEventListener("blur", () => {
    settle(parts, normalize);
    check(parts);
  });
}

/**
 * The approval note only means anything for one of the two answers, so it is
 * disabled until that answer is given. Disabled rather than hidden: a control
 * that appears from nowhere is harder to follow than one that was always there.
 */
const approval = document.getElementById("approval-evidence");
const evidence = document.getElementById("authorization_evidence");

function syncApproval() {
  const chosen = document.querySelector('input[name="authorization_relationship"]:checked');
  const applies = chosen?.value === "approved";
  approval?.setAttribute("aria-disabled", String(!applies));
  if (evidence) {
    evidence.disabled = !applies;
    if (!applies) evidence.value = "";
  }
}

for (const radio of document.querySelectorAll('input[name="authorization_relationship"]')) {
  radio.addEventListener("change", syncApproval);
}
syncApproval();

// Values restored by the browser, or filled in after a rejected submission,
// deserve the same checks as ones typed now.
if (repository.input?.value) checkRepository(repository);
if (commit.input?.value) checkCommit(commit);
if (existingId.input?.value) checkExistingId(existingId);

/**
 * Say that something is happening.
 *
 * Submitting checks the repository and the commit with GitHub and writes a
 * record before it can redirect, which takes a few seconds. Without this the
 * button looks broken, and the natural response to a button that looks broken
 * is to press it again.
 */
const form = document.querySelector('form[action="/submit"]');
const submit = form?.querySelector('button[type="submit"]');

form?.addEventListener("submit", () => {
  if (!submit) return;
  // Not disabled: a disabled submit button is not sent with the form, and
  // some browsers will not submit at all. Blocked by hand instead.
  submit.dataset.busy = "true";
  submit.textContent = "Authenticating via GitHub…";
  announce("Checking the repository and commit with GitHub.");
});

// Nothing here cancels the submit event. A guard against double submission
// would also be a way to lose a submission, and the server now retries a
// racing write rather than failing it, so a second press is harmless.
