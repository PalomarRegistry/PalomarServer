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
  defaultCommitSuggestion,
  exactRegistration,
  locateProject,
  normalizeCommit,
  normalizePalomarId,
  normalizeRepository,
  registrationIdentity,
  registrationIdentityDigest,
  repositoryRegistrations,
  selectedRegistrationId,
} from "./normalize.js";

const promptButton = document.getElementById("copy-formalization-prompt");
const promptText = document.getElementById("formalization-prompt");
const promptStatus = document.getElementById("formalization-prompt-status");
promptButton?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(promptText?.textContent ?? "");
    promptStatus.textContent = "Prompt copied.";
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(promptText);
    selection.removeAllRanges();
    selection.addRange(range);
    promptStatus.textContent = "The prompt is selected; copy it with your browser's copy command.";
  }
});

// The versions of one result, at a key named after it. The registry index
// names every record ever accepted, so asking it which versions one identifier
// has meant fetching all of them, and paying more for it every time anybody
// else registered anything. This form is the answer and nothing else.
const REGISTRY_VERSIONS = "https://data.palomar-registry.org/versions/";
const REGISTRY_DATA = "https://data.palomar-registry.org";

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

let checkedRepository = null;
let checkedDefaultHead = null;

function offerDefaultCommit(parts, name) {
  const known = checkedDefaultHead?.name === name ? checkedDefaultHead : null;
  if (!known) return false;
  const sha = defaultCommitSuggestion({
    checkedRepository: name,
    currentRepository: parts.input.value,
    currentCommit: commit.input?.value,
    headSha: known.data?.sha,
    commitFocused: document.activeElement === commit.input,
    suggestionDeclined: commit.input?.dataset.defaultDeclined === "true",
  });
  if (!sha) return false;
  autofill(commit.input, sha);
  checkCommit(commit, known);
  return true;
}

const checkRepository = latest(async (settle, parts) => {
  const name = normalizeRepository(parts.input.value);
  if (!name) return settle("", DEFAULT.repository);
  settle("checking", `Looking for ${name}…`);
  const data = checkedRepository?.name === name
    ? checkedRepository.data
    : await githubJson(`repos/${name}`);
  if (data === "rate-limited") return settle("", DEFAULT.repository);
  if (!data) return settle("missing", `No public repository called ${name}.`);
  if (data.private) return settle("missing", `${name} is private; Palomar indexes public repositories.`);
  if (normalizeRepository(parts.input.value) !== name) return;
  checkedRepository = { name, data };
  settle("found", `Found ${data.full_name}`, `https://github.com/${data.full_name}`);

  // A commit hash is important but tedious to find. Once GitHub has told us
  // the repository exists, use the current tip of its default branch if the
  // submitter has not chosen a commit. It remains an ordinary editable field,
  // and the server still resolves the exact hash independently.
  const defaultBranch = typeof data.default_branch === "string" ? data.default_branch : "";
  if (!commit.input?.value.trim() &&
      commit.input?.dataset.defaultDeclined !== "true" && defaultBranch) {
    const head = await githubJson(
      `repos/${name}/commits/${encodeURIComponent(defaultBranch)}`,
    ).catch(() => null);
    // A response for an earlier repository must not do any further work for
    // the current form, and a commit typed or focused in flight always wins.
    if (normalizeRepository(parts.input.value) !== name) return;
    const sha = normalizeCommit(head?.sha);
    if (sha) {
      checkedDefaultHead = { name, sha, data: head, defaultBranch };
      if (offerDefaultCommit(parts, name)) return;
    }
  }
  checkCommit(commit);
});

const checkCommit = latest(async (settle, parts, known = null) => {
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
  const data = known?.name === name && known.sha === sha
    ? known.data
    : await githubJson(`repos/${name}/commits/${sha}`);
  if (data === "rate-limited") return settle("", DEFAULT.commit);
  if (!data?.sha) {
    describeLayout();
    return settle("missing", `That commit is not in ${name}.`);
  }
  const when = String(data.commit?.committer?.date ?? "").slice(0, 10);
  settle(
    "found",
    known?.defaultBranch
      ? `Filled in the current ${known.defaultBranch} commit${when ? `, from ${when}` : ""}`
      : when ? `Found that commit, from ${when}` : "Found that commit",
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
  // Choosing a previous registration is stronger than a layout suggestion,
  // including when its project is the empty repository root.
  if (input.dataset.registrationSelected !== undefined) return;
  const mine = input.dataset.suggested !== undefined && input.value === input.dataset.suggested;
  if (input.value !== "" && !mine) return;
  input.value = value;
  if (value) input.dataset.suggested = value;
  else delete input.dataset.suggested;
  if (input === projectPath || input === configPath) scheduleRegistrationLookup();
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
  summarize([projectPath, metadataPath].some((input) => input?.value)
    ? "custom"
    : "unchecked");
}

const registrationTarget = document.getElementById("registration-target");
const registrationMessage = document.getElementById("registration-target-message");
const registrationChoices = document.getElementById("registration-target-choices");
const registrationManual = document.getElementById("registration-target-manual");
let registrationToken = 0;
let registrationTimer;
let selectedRegistration = null;
let pathsBeforeRegistration = null;
const repositoryLookupCache = new Map();

function registrationState(state, message) {
  if (registrationTarget) registrationTarget.dataset.state = state;
  if (registrationMessage) registrationMessage.textContent = message;
  if (["exact", "alternatives", "ambiguous", "unavailable"].includes(state)) {
    announce(message);
  }
}

function clearAutomaticExistingId() {
  if (!existingId.input) return;
  const suggested = existingId.input.dataset.registrationSuggested;
  if (suggested !== undefined && existingId.input.value === suggested) {
    existingId.input.value = "";
    checkExistingId(existingId);
  }
  delete existingId.input.dataset.registrationSuggested;
}

function automaticExistingId(identifier) {
  if (!existingId.input) return false;
  const current = normalizePalomarId(existingId.input.value);
  const automatic = existingId.input.dataset.registrationSuggested;
  if (existingId.input.value.trim() && automatic === undefined && current !== identifier) {
    if (registrationManual) registrationManual.open = true;
    return false;
  }
  // A matching value typed by the submitter stays theirs. Provenance is set
  // only when this script writes the field, never merely because values agree.
  if (existingId.input.value.trim() && automatic === undefined) return true;
  existingId.input.value = identifier;
  existingId.input.dataset.registrationSuggested = identifier;
  checkExistingId(existingId);
  return true;
}

function clearSelectedRegistration({ restore = false, clearPaths = false } = {}) {
  if (!selectedRegistration) return;
  for (const input of [projectPath, configPath]) {
    delete input.dataset.registrationSelected;
    delete input.dataset.suggested;
  }
  if (restore && pathsBeforeRegistration) {
    projectPath.value = pathsBeforeRegistration.project;
    configPath.value = pathsBeforeRegistration.config;
  } else if (clearPaths) {
    projectPath.value = "";
    configPath.value = "";
  }
  selectedRegistration = null;
  pathsBeforeRegistration = null;
  clearAutomaticExistingId();
}

function selectRegistration(row) {
  if (!selectedRegistration) {
    pathsBeforeRegistration = { project: projectPath.value, config: configPath.value };
  }
  selectedRegistration = row;
  autofill(metadataPath, "");
  for (const [input, value] of [
    [projectPath, row.project_path ?? ""],
    [configPath, row.comparator_config_path],
  ]) {
    delete input.dataset.suggested;
    input.value = value;
    input.dataset.registrationSelected = value;
  }
  automaticExistingId(row.id);
  if (row.project_path) {
    layout.open = true;
    summarize("custom");
  }
  registrationState(
    "exact",
    `Selected ${row.id}. Its project and Comparator configuration paths have been filled in, so this submission will create a new version for that registration.`,
  );
  scheduleRegistrationLookup();
}

function registrationLabel(row) {
  const project = row.project_path ?? "repository root";
  return `${row.id} — ${project}; ${row.comparator_config_path}`;
}

function showRegistrationChoices(rows, { truncated = false } = {}) {
  if (!registrationChoices) return;
  const focusedValue = document.activeElement?.name === "registration_target_choice"
    ? document.activeElement.value
    : null;
  registrationChoices.replaceChildren();
  const fieldset = document.createElement("fieldset");
  fieldset.className = "registration-options";
  const legend = document.createElement("legend");
  legend.textContent = "Choose the registration target";
  fieldset.append(legend);

  const addChoice = (value, labelText, checked, onChange) => {
    const label = document.createElement("label");
    label.className = "choice";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "registration_target_choice";
    input.value = value;
    input.checked = checked;
    input.addEventListener("change", () => {
      if (input.checked) onChange();
    });
    label.append(input, document.createTextNode(labelText));
    fieldset.append(label);
  };

  addChoice("new", "Make a new submission", !selectedRegistration, () => {
    clearSelectedRegistration({ restore: true });
    scheduleRegistrationLookup();
  });
  for (const row of rows) {
    addChoice(row.id, registrationLabel(row), selectedRegistration?.id === row.id, () => {
      selectRegistration(row);
    });
  }
  registrationChoices.append(fieldset);
  if (focusedValue !== null) {
    [...fieldset.querySelectorAll('input[name="registration_target_choice"]')]
      .find((input) => input.value === focusedValue)?.focus();
  }
  if (truncated && registrationManual) registrationManual.open = true;
}

function clearRegistrationChoices() {
  registrationChoices?.replaceChildren();
}

async function registryJson(path) {
  try {
    const response = await fetch(`${REGISTRY_DATA}${path}`, { cache: "no-store" });
    if (response.status === 404) return { kind: "missing" };
    if (!response.ok) return { kind: "unavailable" };
    return { kind: "found", value: await response.json() };
  } catch {
    return { kind: "unavailable" };
  }
}

async function registryRepository(repositoryName) {
  if (repositoryLookupCache.has(repositoryName)) {
    return repositoryLookupCache.get(repositoryName);
  }
  const [owner, name] = repositoryName.split("/");
  const request = registryJson(
    `/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}.json`,
  );
  repositoryLookupCache.set(repositoryName, request);
  const answer = await request;
  if (answer.kind === "unavailable") repositoryLookupCache.delete(repositoryName);
  return answer;
}

async function inspectRegistrationTarget() {
  const mine = ++registrationToken;
  const current = () => mine === registrationToken;
  const repositoryName = normalizeRepository(repository.input?.value)?.toLowerCase();
  if (!repositoryName) {
    clearRegistrationChoices();
    clearAutomaticExistingId();
    return registrationState(
      "unchecked",
      "Enter the repository and Comparator configuration. Palomar will check whether this should create a new registration or a new version.",
    );
  }

  registrationState("checking", `Checking previous registrations for ${repositoryName}…`);
  const repositoryRequest = registryRepository(repositoryName);
  const identity = registrationIdentity(
    repositoryName,
    projectPath?.value,
    configPath?.value,
  );
  const identityRequest = identity
    ? registrationIdentityDigest(identity).then((digest) =>
        digest
          ? registryJson(`/registration-identities/${digest}.json`)
          : { kind: "unavailable" }).catch(() => ({ kind: "unavailable" }))
    : Promise.resolve({ kind: "missing" });
  const [repositoryAnswer, identityAnswer] = await Promise.all([
    repositoryRequest,
    identityRequest,
  ]);
  if (!current()) return;

  const repositoryDocument = repositoryAnswer.kind === "found"
    ? repositoryRegistrations(repositoryAnswer.value, repositoryName)
    : null;
  const identityDocument = identity && identityAnswer.kind === "found"
    ? exactRegistration(identityAnswer.value, identity)
    : null;
  const invalid =
    (repositoryAnswer.kind === "found" && !repositoryDocument) ||
    (identityAnswer.kind === "found" && !identityDocument);

  // A deliberate choice from the repository document is already a complete,
  // explicit answer. Keep it even if the redundant exact probe is missing,
  // stale, malformed, or temporarily unavailable.
  const selectedId = selectedRegistrationId(selectedRegistration, identity);
  if (selectedId) {
    automaticExistingId(selectedId);
    return registrationState(
      "exact",
      `Selected ${selectedId}, so this submission will create a new version for that registration.`,
    );
  }

  if (identityDocument && !identityDocument.ambiguous) {
    clearRegistrationChoices();
    const identifier = identityDocument.registration_id;
    if (!automaticExistingId(identifier)) {
      return registrationState(
        "unavailable",
        `We found the previous registration ${identifier}, but the manually entered Palomar ID is different. Check the intended registration below.`,
      );
    }
    return registrationState(
      "exact",
      `We found the previous registration ${identifier}, so this submission will create a new version for that registration. If you intend to create a new registration, please specify the path to an alternative Comparator configuration file.`,
    );
  }

  clearAutomaticExistingId();
  if (identityDocument?.ambiguous) {
    const matching = (repositoryDocument?.registrations ?? []).filter((row) =>
      row.project_path === identity.project_path &&
      row.comparator_config_path === identity.comparator_config_path);
    showRegistrationChoices(matching);
    if (registrationManual) registrationManual.open = true;
    return registrationState(
      "ambiguous",
      "We found more than one active registration for these exact paths. Select the intended registration below, or enter its Palomar ID manually.",
    );
  }
  if (invalid || repositoryAnswer.kind === "unavailable" ||
      identityAnswer.kind === "unavailable") {
    clearRegistrationChoices();
    if (registrationManual) registrationManual.open = true;
    return registrationState(
      "unavailable",
      "Palomar could not check previous registrations just now. You can still submit, or enter an existing Palomar ID manually below.",
    );
  }

  const registrations = repositoryDocument?.registrations ?? [];
  if (registrations.length) {
    showRegistrationChoices(registrations, { truncated: repositoryDocument.truncated });
    return registrationState(
      "alternatives",
      (identity
        ? "We found the previous registrations using different Comparator paths. Please select whether you would like to make a new submission, or create a new version of the registration for one of these."
        : "We found previous registrations for this repository. Specify the Comparator configuration for a new submission, or select a registration to create a new version.") +
        (repositoryDocument.truncated
          ? " This repository has additional registrations that are not shown; use the manual Palomar ID field if needed."
          : ""),
    );
  }
  clearRegistrationChoices();
  registrationState(
    "new",
    identity
      ? "Palomar did not find an active registration for this repository and Comparator configuration, so this is currently targeting a new registration. If you expected an existing one, use the manual Palomar ID field."
      : "Palomar did not find active registrations for this repository. Specify the Comparator configuration to finish choosing the registration target, or use the manual Palomar ID field if you expected one.",
  );
}

function scheduleRegistrationLookup() {
  // Invalidate an in-flight answer immediately; the replacement request is
  // debounced, but the old repository/path tuple stopped being current now.
  registrationToken += 1;
  clearTimeout(registrationTimer);
  registrationTimer = setTimeout(inspectRegistrationTarget, 250);
}

// A default-branch commit belongs to the repository for which it was found.
// Changing that repository clears only an untouched suggestion; a commit the
// submitter typed or edited is never discarded.
repository.input?.addEventListener("input", () => {
  checkedRepository = null;
  checkedDefaultHead = null;
  registrationToken += 1;
  clearSelectedRegistration({ restore: true });
  clearAutomaticExistingId();
  scheduleRegistrationLookup();
  if (commit.input) delete commit.input.dataset.defaultDeclined;
  const suggestion = commit.input?.dataset.suggested;
  if (suggestion !== undefined && commit.input.value === suggestion) {
    autofill(commit.input, "");
    checkCommit(commit);
  }
});

// A real input event, unlike assigning `.value`, came from the submitter. Once
// they edit or remove a suggestion, do not silently offer it again for the same
// repository. A changed repository clears this flag above.
commit.input?.addEventListener("input", () => {
  commit.input.dataset.defaultDeclined = "true";
  if (commit.input.dataset.suggested !== commit.input.value) {
    delete commit.input.dataset.suggested;
  }
});

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
  if (where.found) autofill(configPath, where.config);

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
for (const input of [projectPath, metadataPath]) {
  input?.addEventListener("input", () => {
    if (input.value) summarize("custom");
  });
}

for (const input of [projectPath, configPath]) {
  input?.addEventListener("input", () => {
    registrationToken += 1;
    if (input.dataset.registrationSelected !== undefined) {
      clearSelectedRegistration();
    }
    clearAutomaticExistingId();
    scheduleRegistrationLookup();
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
  let document;
  try {
    // `value` has already matched the strict identifier pattern, which is what
    // makes it safe to put in a path.
    const response = await fetch(`${REGISTRY_VERSIONS}${value}.json`, { cache: "no-store" });
    // Nothing there means no active version: an unknown identifier, or one
    // withdrawn entirely. Either way there is nothing to register a version of.
    if (response.status === 404) {
      return settle("missing", `${value} is not in the registry.`);
    }
    if (!response.ok) return settle("", DEFAULT.existing_id);
    document = await response.json();
  } catch {
    return settle("", DEFAULT.existing_id);
  }
  // The document says which result it is about. Without that check a
  // misdirected or stale response would let this field report another
  // record's version history under the identifier that was typed.
  if (document?.id !== value || !Array.isArray(document.entries) || !document.entries.length) {
    return settle("", DEFAULT.existing_id);
  }
  const current = Math.max(...document.entries.map((entry) => Number(entry.version) || 0));
  settle(
    "found",
    `Found ${value}; this would become version ${current + 1}`,
    `https://palomar-registry.org/entry.html?id=${value}&version=${current}`,
  );
});

existingId.input?.addEventListener("input", () => {
  if (existingId.input.dataset.registrationSuggested !== existingId.input.value) {
    delete existingId.input.dataset.registrationSuggested;
  }
  scheduleRegistrationLookup();
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
    if (parts === commit) {
      const name = normalizeRepository(repository.input?.value);
      if (name && offerDefaultCommit(repository, name)) return;
    }
    check(parts);
  });
}

/** The approval note only applies when the submitter has approval. */
const approval = document.getElementById("approval-evidence");
const evidence = document.getElementById("authorization_evidence");

function syncApproval() {
  const chosen = document.querySelector('input[name="authorization_relationship"]:checked');
  const applies = chosen?.value === "approved";
  if (approval) approval.hidden = !applies;
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
scheduleRegistrationLookup();

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
const recoveryForm = document.querySelector('form[action="/submissions"]');
const recoverySubmit = document.getElementById("find-submissions");

function setRecoveryBusy(busy) {
  if (!recoverySubmit) return;
  if (busy) {
    recoverySubmit.dataset.busy = "true";
    recoverySubmit.setAttribute("aria-busy", "true");
    recoverySubmit.textContent = "Finding your submissions…";
    return;
  }
  delete recoverySubmit.dataset.busy;
  recoverySubmit.removeAttribute("aria-busy");
  recoverySubmit.textContent = "Find my submissions";
}

recoveryForm?.addEventListener("submit", () => {
  setRecoveryBusy(true);
  announce("Authenticating with GitHub to find your submissions.");
});

// A return from GitHub may restore this page from the back-forward cache.
// Make sure the action does not still look as though it is in progress.
window.addEventListener("pageshow", () => setRecoveryBusy(false));

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
