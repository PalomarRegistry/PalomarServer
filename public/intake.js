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

const REGISTRY_INDEX =
  "https://raw.githubusercontent.com/PalomarRegistry/PalomarDatabase/main/index.json";
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT_RE = /^[0-9a-f]{40}$/i;
const PALOMAR_ID_RE = /^PALOMAR-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}$/;

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

function show(parts, state, message) {
  if (parts.status) parts.status.dataset.state = state ?? "";
  if (parts.message && message) parts.message.textContent = message;
  if (state === "found" || state === "missing") announce(message);
}

/** owner/name, from a bare pair or a GitHub URL, or null. */
function parseRepository(raw) {
  const value = String(raw ?? "").trim().replace(/\.git$/, "").replace(/\/+$/, "");
  if (REPOSITORY_RE.test(value)) return value;
  const match = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(value);
  return match ? match[1] : null;
}

/** Run the newest request only: an earlier answer must not overwrite a later one. */
function latest(run) {
  let token = 0;
  return async (...args) => {
    const mine = ++token;
    const settle = (state, message) => {
      if (mine === token) show(args[0], state, message);
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
  const name = parseRepository(parts.input.value);
  if (!name) return settle("", DEFAULT.repository);
  settle("checking", `Looking for ${name}…`);
  const data = await githubJson(`repos/${name}`);
  if (data === "rate-limited") return settle("", DEFAULT.repository);
  if (!data) return settle("missing", `No public repository called ${name}.`);
  if (data.private) return settle("missing", `${name} is private; Palomar indexes public repositories.`);
  settle("found", `Found ${data.full_name}.`);
  checkCommit(commit);
});

const checkCommit = latest(async (settle, parts) => {
  const sha = parts.input.value.trim().toLowerCase();
  const name = parseRepository(repository.input.value);
  if (!COMMIT_RE.test(sha)) {
    return settle(sha ? "missing" : "", sha ? "A commit is 40 hexadecimal characters." : DEFAULT.commit);
  }
  if (!name) return settle("", DEFAULT.commit);
  settle("checking", "Looking for that commit…");
  const data = await githubJson(`repos/${name}/commits/${sha}`);
  if (data === "rate-limited") return settle("", DEFAULT.commit);
  if (!data?.sha) return settle("missing", `That commit is not in ${name}.`);
  const when = String(data.commit?.committer?.date ?? "").slice(0, 10);
  settle("found", when ? `Found that commit, from ${when}.` : "Found that commit.");
});

const checkExistingId = latest(async (settle, parts) => {
  const value = parts.input.value.trim();
  if (!value) return settle("", DEFAULT.existing_id);
  if (!PALOMAR_ID_RE.test(value)) {
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
  settle("found", `Found ${value}; this would become version ${current + 1}.`);
});

repository.input?.addEventListener("input", debounce(() => checkRepository(repository), 400));
repository.input?.addEventListener("blur", () => checkRepository(repository));
commit.input?.addEventListener("input", debounce(() => checkCommit(commit), 400));
commit.input?.addEventListener("blur", () => checkCommit(commit));
existingId.input?.addEventListener("input", debounce(() => checkExistingId(existingId), 400));
existingId.input?.addEventListener("blur", () => checkExistingId(existingId));

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
