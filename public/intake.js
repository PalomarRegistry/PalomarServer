/**
 * Progressive enhancement for the submission form.
 *
 * Everything here is convenience. The form works with this script blocked, and
 * nothing it says is trusted: the server checks the repository, the commit, the
 * submitter's push access, and the Palomar ID again, and its answers are the
 * ones that count. A check that fails here never prevents submission, because a
 * rate limit or an outage on someone else's API is not a reason to refuse
 * somebody's work. The exception is a validated exact-commit match: it cannot
 * become another registration, so the later controls are disabled until the
 * submitter changes the registration identity or commit.
 *
 * The lookups go straight from the browser to GitHub and to the registry data.
 * That keeps the server out of it, and it tells GitHub the repository name a
 * moment before the submission would have anyway.
 */

import {
  comparatorConfigurationPaths,
  comparatorPathSuggestions,
  defaultCommitSuggestion,
  exactRegistration,
  locateProject,
  normalizeCommit,
  normalizePalomarId,
  normalizeRepository,
  normalizeRepositoryPath,
  publicRepositorySuggestions,
  registrationIdentity,
  registrationIdentityDigest,
  repositoryQuery,
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

const githubJsonCache = new Map();
let githubRetryAt = 0;

function recordGithubRateLimit(response) {
  const retryAfter = Number(response.headers.get("retry-after"));
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  const now = Date.now();
  const retryAt = [
    Number.isFinite(retryAfter) && retryAfter >= 0 ? now + retryAfter * 1000 : 0,
    Number.isFinite(reset) && reset > 0 ? reset * 1000 : 0,
    now + 60_000,
  ];
  githubRetryAt = Math.max(githubRetryAt, ...retryAt);
}

function githubRateLimitMessage(subject) {
  const retry = githubRetryAt > Date.now()
    ? ` Try again after ${new Date(githubRetryAt).toLocaleTimeString([], {
        hour: "numeric", minute: "2-digit",
      })}.`
    : " Try again shortly.";
  return `GitHub is rate-limiting this browser, so ${subject} could not be checked.${retry}`;
}

/**
 * One page-lifetime request per public GitHub resource. In-flight promises are
 * cached too, so concurrent checks share their request. Once GitHub reports a
 * limit, no further request is sent until its Retry-After or reset time.
 */
async function githubJson(path, { signal } = {}) {
  if (githubRetryAt > Date.now()) return "rate-limited";
  if (!signal && githubJsonCache.has(path)) return githubJsonCache.get(path);

  const request = (async () => {
    const response = await fetch(`https://api.github.com/${path}`, {
      headers: { accept: "application/vnd.github+json" },
      signal,
    });
    if (response.status === 403 || response.status === 429) {
      recordGithubRateLimit(response);
      return "rate-limited";
    }
    return response.ok ? response.json() : null;
  })();

  if (!signal) githubJsonCache.set(path, request);
  try {
    const result = await request;
    if (!signal) {
      if (result === "rate-limited") githubJsonCache.delete(path);
      else githubJsonCache.set(path, result);
    }
    return result;
  } catch (error) {
    if (!signal) githubJsonCache.delete(path);
    throw error;
  }
}

const repository = field("repository");
const commit = field("commit");
const comparatorConfig = field("comparator_config_path");
const existingId = field("existing_id");
const DEFAULT = {
  repository: repository.message?.textContent,
  commit: commit.message?.textContent,
  comparator_config_path: comparatorConfig.message?.textContent,
  existing_id: existingId.message?.textContent,
};

let checkedRepository = null;
let checkedDefaultHead = null;
let checkedCommit = null;
const repositorySuggestionList = document.getElementById("repository-suggestions");
const repositorySuggestionCache = new Map();
let repositorySuggestionRequest = null;
let repositorySuggestionTimer;
const REPOSITORY_SUGGESTION_DELAY = 400;

function renderRepositorySuggestions() {
  if (!repositorySuggestionList || !repository.input) return;
  const query = repositoryQuery(repository.input.value);
  const cached = query
    ? repositorySuggestionCache.get(query.owner.toLowerCase())
    : null;
  const rows = Array.isArray(cached) ? cached : [];
  const fragment = document.createDocumentFragment();
  for (const value of publicRepositorySuggestions(rows, repository.input.value)) {
    const option = document.createElement("option");
    option.value = value;
    fragment.append(option);
  }
  repositorySuggestionList.replaceChildren(fragment);
}

/**
 * Fetch once after the owner is complete, then do all further filtering in
 * memory. No repository suffix is ever put into this request.
 */
async function loadRepositorySuggestions(owner) {
  const key = owner.toLowerCase();
  const controller = new AbortController();
  repositorySuggestionRequest = { key, controller };
  try {
    const rows = await githubJson(
      `users/${encodeURIComponent(owner)}/repos?type=owner&sort=full_name&per_page=100`,
      { signal: controller.signal },
    );
    if (repositorySuggestionRequest?.controller !== controller) return;
    repositorySuggestionCache.set(key, Array.isArray(rows) ? rows : rows ?? "unavailable");
    const current = repositoryQuery(repository.input?.value);
    if (current?.owner.toLowerCase() === key) {
      renderRepositorySuggestions();
      checkRepository(repository);
    }
  } catch (error) {
    if (error?.name !== "AbortError" &&
        repositorySuggestionRequest?.controller === controller) {
      repositorySuggestionCache.set(key, "unavailable");
    }
  } finally {
    if (repositorySuggestionRequest?.controller === controller) {
      repositorySuggestionRequest = null;
    }
  }
}

function updateRepositorySuggestions() {
  const query = repositoryQuery(repository.input?.value);
  clearTimeout(repositorySuggestionTimer);
  if (!query) {
    repositorySuggestionRequest?.controller.abort();
    repositorySuggestionRequest = null;
    return renderRepositorySuggestions();
  }
  const key = query.owner.toLowerCase();
  if (repositorySuggestionCache.has(key)) {
    if (repositorySuggestionCache.get(key) === "rate-limited" &&
        githubRetryAt <= Date.now()) {
      repositorySuggestionCache.delete(key);
    } else {
      if (repositorySuggestionRequest?.key !== key) {
        repositorySuggestionRequest?.controller.abort();
        repositorySuggestionRequest = null;
      }
      renderRepositorySuggestions();
      return;
    }
  }
  if (repositorySuggestionRequest?.key === key) return;
  if (repositorySuggestionRequest?.key !== key) {
    repositorySuggestionRequest?.controller.abort();
    repositorySuggestionRequest = null;
  }
  repositorySuggestionList?.replaceChildren();
  // The owner is known at the slash, but wait until typing has been idle. Every
  // suffix keystroke resets this one timer; it never creates a suffix request.
  repositorySuggestionTimer = setTimeout(() => {
    repositorySuggestionTimer = null;
    const current = repositoryQuery(repository.input?.value);
    if (current?.owner.toLowerCase() === key &&
        !repositorySuggestionCache.has(key) &&
        repositorySuggestionRequest?.key !== key) {
      void loadRepositorySuggestions(current.owner);
    }
  }, REPOSITORY_SUGGESTION_DELAY);
}

function cachedSuggestedRepository(name) {
  const [owner] = name.split("/");
  const key = owner.toLowerCase();
  if (!repositorySuggestionCache.has(key)) return undefined;
  const rows = repositorySuggestionCache.get(key);
  if (!Array.isArray(rows)) return rows;
  const found = rows.find((row) => row?.private === false &&
    normalizeRepository(row.full_name)?.toLowerCase() === name.toLowerCase());
  // GitHub caps this response at 100. Absence from a full page is not evidence
  // that the repository does not exist, and must not trigger a suffix lookup.
  return found ?? (rows.length === 100 ? "not-listed" : null);
}

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
  const data = checkedRepository?.name === name
    ? checkedRepository.data
    : cachedSuggestedRepository(name);
  if (data === undefined) return settle("checking", `Loading ${name.split("/")[0]}'s repositories…`);
  if (data === "rate-limited") {
    return settle("", githubRateLimitMessage("its repositories"));
  }
  if (data === "unavailable") {
    return settle("", "GitHub's repository list is unavailable just now. You can still enter the repository and submit it.");
  }
  if (data === "not-listed") {
    return settle("", "That repository is not in GitHub's first 100 results for this owner. You can still enter it and submit it.");
  }
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
    if (head === "rate-limited") {
      show(commit, "", githubRateLimitMessage("the default-branch commit"));
      return;
    }
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
  const prior = checkedCommit?.name === name && checkedCommit.sha === sha
    ? checkedCommit
    : null;
  if (!prior) {
    checkedCommit = null;
    scheduleComparatorPathLookup();
  }
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
    : prior?.data ?? await githubJson(`repos/${name}/commits/${sha}`);
  if (normalizeRepository(repository.input.value) !== name ||
      normalizeCommit(parts.input.value) !== sha) return;
  if (data === "rate-limited") {
    return settle("", githubRateLimitMessage("that commit"));
  }
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
  checkedCommit = { name, sha, data };
  if (!prior) scheduleComparatorPathLookup();
  describeLayout(name, sha);
});

const layout = document.getElementById("layout");
const layoutMessage = document.getElementById("layout-message");
const projectPath = document.getElementById("project_path");
const configPath = comparatorConfig.input;
const metadataPath = document.getElementById("formalization_metadata_path");
const comparatorSuggestionList = document.getElementById("comparator-config-suggestions");
const DEFAULT_COMPARATOR_PATH = "comparator.json";
let comparatorPaths = [DEFAULT_COMPARATOR_PATH];

/**
 * Keep only a small matching window in the DOM. The complete candidate list
 * stays in memory, so typing can reach every path without making a large
 * repository's datalist slow down the input itself.
 */
function renderComparatorSuggestions() {
  if (!comparatorSuggestionList) return;
  const fragment = document.createDocumentFragment();
  for (const path of comparatorPathSuggestions(comparatorPaths, configPath?.value)) {
    const option = document.createElement("option");
    option.value = path;
    fragment.append(option);
  }
  comparatorSuggestionList.replaceChildren(fragment);
}

function resetComparatorSuggestions() {
  comparatorPaths = [DEFAULT_COMPARATOR_PATH];
  renderComparatorSuggestions();
}

function setComparatorSuggestions(entries) {
  const found = comparatorConfigurationPaths(entries);
  comparatorPaths = found.includes(DEFAULT_COMPARATOR_PATH)
    ? found
    : [DEFAULT_COMPARATOR_PATH, ...found];
  renderComparatorSuggestions();
}

let comparatorPathToken = 0;
let comparatorPathTimer;

/** Check the exact file, without turning a GitHub outage into a verdict. */
async function inspectComparatorPath() {
  const mine = ++comparatorPathToken;
  const current = () => mine === comparatorPathToken;
  const path = normalizeRepositoryPath(configPath?.value);
  const name = normalizeRepository(repository.input?.value);
  const sha = normalizeCommit(commit.input?.value);
  if (!path) {
    const typed = configPath?.value.trim();
    return show(
      comparatorConfig,
      typed ? "missing" : "",
      typed
        ? "Use a repository-relative file path without . or .. segments."
        : DEFAULT.comparator_config_path,
    );
  }
  if (!name || !sha || checkedCommit?.name !== name || checkedCommit.sha !== sha) {
    return show(comparatorConfig, "", DEFAULT.comparator_config_path);
  }

  show(comparatorConfig, "checking", `Looking for ${path} at that commit…`);
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  let response;
  try {
    response = await fetch(
      `https://api.github.com/repos/${name}/contents/${encodedPath}?ref=${encodeURIComponent(sha)}`,
      { headers: { accept: "application/vnd.github+json" } },
    );
  } catch {
    if (current()) show(comparatorConfig, "", DEFAULT.comparator_config_path);
    return;
  }
  if (!current()) return;
  if (response.status === 404) {
    return show(comparatorConfig, "missing", `We can’t find ${path} at that commit.`);
  }
  if (response.status === 403 || response.status === 429 || !response.ok) {
    return show(comparatorConfig, "", DEFAULT.comparator_config_path);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    if (current()) show(comparatorConfig, "", DEFAULT.comparator_config_path);
    return;
  }
  if (!current()) return;
  if (data?.type !== "file") {
    return show(comparatorConfig, "missing", `${path} exists at that commit, but it is not a file.`);
  }
  show(
    comparatorConfig,
    "found",
    `Found ${path} at that commit`,
    `https://github.com/${name}/blob/${sha}/${encodedPath}`,
  );
}

function scheduleComparatorPathLookup() {
  // Invalidate a response for the old repository, commit, or path before the
  // replacement request's debounce has elapsed.
  comparatorPathToken += 1;
  clearTimeout(comparatorPathTimer);
  show(comparatorConfig, "", DEFAULT.comparator_config_path);
  comparatorPathTimer = setTimeout(inspectComparatorPath, 400);
}

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
  // Once the submitter interacts with this field, even clearing it is a
  // choice. An asynchronous tree response must never take ownership back.
  if (input === configPath && input.dataset.userOwned === "true") return;
  const mine = input.dataset.suggested !== undefined && input.value === input.dataset.suggested;
  if (input.value !== "" && !mine) return;
  input.value = value;
  if (value) input.dataset.suggested = value;
  else delete input.dataset.suggested;
  if (input === projectPath || input === configPath) scheduleRegistrationLookup();
  if (input === configPath) {
    renderComparatorSuggestions();
    scheduleComparatorPathLookup();
  }
  if (input === commit.input) {
    checkedCommit = null;
    invalidateLayout();
    scheduleRegistrationLookup();
    scheduleComparatorPathLookup();
  }
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
const registrationManual = document.getElementById("registration-target-manual");
const submissionDetails = document.getElementById("submission-details");
let registrationToken = 0;
let registrationTimer;

function registrationState(state, ...content) {
  if (registrationTarget) registrationTarget.dataset.state = state;
  if (registrationMessage) registrationMessage.replaceChildren(...content);
  const blocked = state === "duplicate";
  if (submissionDetails) {
    if (blocked && !submissionDetails.disabled &&
        submissionDetails.contains(document.activeElement) && registrationMessage) {
      registrationMessage.tabIndex = -1;
      registrationMessage.focus();
    }
    submissionDetails.disabled = blocked;
    submissionDetails.hidden = blocked;
  }
  const message = content.map((part) =>
    typeof part === "string" ? part : part.textContent ?? "").join("");
  if (["duplicate", "version", "ambiguous", "unavailable"].includes(state)) {
    announce(message);
  }
}

function registeredEntry(identifier) {
  const link = document.createElement("a");
  link.href = `https://palomar-registry.org/entry.html?id=${encodeURIComponent(identifier)}`;
  link.textContent = identifier;
  link.target = "_blank";
  link.rel = "noreferrer noopener";
  return link;
}

function manualRegistration({ hidden, open }) {
  if (!registrationManual) return;
  if (hidden && registrationManual.contains(document.activeElement) && registrationMessage) {
    registrationMessage.tabIndex = -1;
    registrationMessage.focus();
  }
  registrationManual.hidden = hidden;
  if (hidden) registrationManual.open = false;
  else if (open !== undefined) registrationManual.open = open;
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

async function inspectRegistrationTarget() {
  const mine = ++registrationToken;
  const current = () => mine === registrationToken;
  const repositoryName = normalizeRepository(repository.input?.value)?.toLowerCase();
  const commitSha = normalizeCommit(commit.input?.value);
  const identity = registrationIdentity(
    repositoryName,
    projectPath?.value,
    configPath?.value,
  );
  if (!repositoryName || !commitSha || !identity) {
    if (registrationTarget) registrationTarget.hidden = true;
    clearAutomaticExistingId();
    manualRegistration({ hidden: false });
    return registrationState("unchecked", "");
  }

  if (registrationTarget) registrationTarget.hidden = false;
  registrationState("checking", `Checking previous registrations for ${repositoryName}…`);
  const identityAnswer = await registrationIdentityDigest(identity).then((digest) =>
    digest
      ? registryJson(`/registration-identities/${digest}.json`)
      : { kind: "unavailable" }).catch(() => ({ kind: "unavailable" }));
  if (!current()) return;

  const identityDocument = identity && identityAnswer.kind === "found"
    ? exactRegistration(identityAnswer.value, identity)
    : null;
  const invalid = identityAnswer.kind === "found" && !identityDocument;

  if (identityDocument && !identityDocument.ambiguous &&
      identityDocument.commits.includes(commitSha)) {
    const identifier = identityDocument.registration_id;
    manualRegistration({ hidden: true });
    return registrationState(
      "duplicate",
      ...(identifier ? ["The result ", registeredEntry(identifier)] : ["This result"]),
      " has already been registered at this commit and cannot be registered again. " +
        "Enter a different commit to create a new version with the same Palomar identifier, " +
        "or specify a different Comparator configuration path to register a different theorem " +
        "from the same repository.",
    );
  }

  if (identityDocument && !identityDocument.ambiguous) {
    const identifier = identityDocument.registration_id;
    if (!automaticExistingId(identifier)) {
      manualRegistration({ hidden: false, open: true });
      return registrationState(
        "unavailable",
        `We found the previous registration ${identifier}, but the manually entered Palomar ID is different. Check the intended registration below.`,
      );
    }
    manualRegistration({ hidden: true });
    return registrationState(
      "version",
      "There is already a registration for this repository and Comparator configuration: ",
      registeredEntry(identifier),
      ". This submission will create a new version with the same Palomar identifier.",
    );
  }

  clearAutomaticExistingId();
  if (identityDocument?.ambiguous) {
    manualRegistration({ hidden: false, open: true });
    return registrationState(
      "ambiguous",
      "Palomar found more than one active registration for these exact paths. " +
        (identityDocument.commits.includes(commitSha)
          ? "This commit appears in their registration history. "
          : "") +
        "Enter the intended Palomar ID below.",
    );
  }
  if (invalid || identityAnswer.kind === "unavailable") {
    manualRegistration({ hidden: false, open: true });
    return registrationState(
      "unavailable",
      "Palomar could not check previous registrations just now. You can still submit, or enter an existing Palomar ID manually below.",
    );
  }

  manualRegistration({ hidden: false });
  return registrationState(
    "new",
    "This looks like a new submission. If you are trying to replace an existing submission, expand this box.",
  );
}

function scheduleRegistrationLookup() {
  // Invalidate an in-flight answer immediately; the replacement request is
  // debounced, but the old repository/path tuple stopped being current now.
  registrationToken += 1;
  if (submissionDetails) {
    submissionDetails.disabled = false;
    submissionDetails.hidden = false;
  }
  clearTimeout(registrationTimer);
  registrationTimer = setTimeout(inspectRegistrationTarget, 250);
}

// A default-branch commit belongs to the repository for which it was found.
// Changing that repository clears only an untouched suggestion; a commit the
// submitter typed or edited is never discarded.
repository.input?.addEventListener("input", () => {
  updateRepositorySuggestions();
  checkedRepository = null;
  checkedDefaultHead = null;
  checkedCommit = null;
  invalidateLayout();
  registrationToken += 1;
  clearAutomaticExistingId();
  scheduleRegistrationLookup();
  scheduleComparatorPathLookup();
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
  checkedCommit = null;
  invalidateLayout();
  commit.input.dataset.defaultDeclined = "true";
  if (commit.input.dataset.suggested !== commit.input.value) {
    delete commit.input.dataset.suggested;
  }
  clearAutomaticExistingId();
  scheduleRegistrationLookup();
  scheduleComparatorPathLookup();
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
let describedLayout = null;

function invalidateLayout() {
  layoutToken += 1;
  describedLayout = null;
  resetComparatorSuggestions();
  clearSuggestions();
}

async function describeLayout(name, sha) {
  if (!layout) return;
  if (describedLayout?.name === name && describedLayout.sha === sha) return;
  // Every exit below is a change of subject: whatever is filled in describes
  // the previous commit, and must go before anything is said about this one.
  const mine = ++layoutToken;
  const current = () => mine === layoutToken;
  describedLayout = null;
  resetComparatorSuggestions();
  clearSuggestions();
  if (!name || !sha) return;

  let tree;
  try {
    tree = await githubJson(`repos/${name}/git/trees/${sha}?recursive=1`);
    if (!current()) return;
    if (tree === "rate-limited") {
      return say(`${githubRateLimitMessage("the file layout")} Fill these in if the project is not at the root.`);
    }
  } catch {
    return;
  }
  if (!current() || !Array.isArray(tree?.tree)) return;
  if (tree.truncated) {
    layout.open = true;
    return say("This repository is too large for GitHub to list in one request, so the layout was not checked. Fill these in if the project is not at the root.");
  }
  describedLayout = { name, sha };
  setComparatorSuggestions(tree.tree);
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
    if (input === configPath) input.dataset.userOwned = "true";
    registrationToken += 1;
    clearAutomaticExistingId();
    scheduleRegistrationLookup();
    if (input === configPath) {
      renderComparatorSuggestions();
      scheduleComparatorPathLookup();
    }
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
if (configPath?.value) scheduleComparatorPathLookup();
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
