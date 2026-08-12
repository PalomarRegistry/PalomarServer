/**
 * How a submitted value is read, defined once.
 *
 * A submission is checked in three places: by the browser's own validation of
 * the `pattern` attribute, by the live checks beside each field, and by the
 * server. If those disagree about what a value means, a submitter is told
 * their commit was found and then that it does not match the requested format,
 * which is what happens when the same string is trimmed by two of the three.
 *
 * This module is imported by the browser and bundled into the Worker, so there
 * is one definition rather than three that have to be kept in step.
 */

export const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const COMMIT_RE = /^[0-9a-f]{40}$/;
export const PALOMAR_ID_RE = /^PALOMAR-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}$/;

/**
 * A repository as `owner/name`, from a bare pair or a GitHub URL, or null.
 *
 * Anything else is refused rather than guessed at.
 */
export function normalizeRepository(raw) {
  const value = String(raw ?? "").trim().replace(/\.git$/, "").replace(/\/+$/, "");
  if (REPOSITORY_RE.test(value) && !value.split("/").some((part) => part === "." || part === "..")) {
    return value;
  }
  const match = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(value);
  return match && !match[1].split("/").some((part) => part === "." || part === "..")
    ? match[1]
    : null;
}

/**
 * The completed owner and partial repository in a value still being typed.
 *
 * A slash is the boundary that makes the owner unambiguous, so callers can
 * wait for it before doing any network work. The URL form is retained so an
 * autocomplete choice does not unexpectedly replace a URL with a bare pair.
 */
export function repositoryQuery(raw) {
  const value = String(raw ?? "").trim();
  const match = /^(https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]*)$/.exec(value);
  if (!match || match[2] === "." || match[2] === "..") return null;
  return { owner: match[2], prefix: match[3], url: Boolean(match[1]) };
}

/** Return safe public repository choices matching the value being typed. */
export function publicRepositorySuggestions(rows, raw, limit = 100) {
  const query = repositoryQuery(raw);
  if (!query || !Array.isArray(rows) || !Number.isInteger(limit) || limit < 1) return [];
  const owner = query.owner.toLowerCase();
  const prefix = query.prefix.toLowerCase();
  const seen = new Set();
  const suggestions = [];
  for (const row of rows) {
    if (row?.private !== false) continue;
    const fullName = normalizeRepository(row.full_name);
    if (!fullName) continue;
    const [candidateOwner, candidateName] = fullName.split("/");
    const key = fullName.toLowerCase();
    if (candidateOwner.toLowerCase() !== owner ||
        !candidateName.toLowerCase().startsWith(prefix) || seen.has(key)) continue;
    seen.add(key);
    suggestions.push(query.url ? `https://github.com/${fullName}` : fullName);
    if (suggestions.length === limit) break;
  }
  return suggestions;
}

/** A full commit, lowercased, or null. Abbreviations are not commits. */
export function normalizeCommit(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  return COMMIT_RE.test(value) ? value : null;
}

/**
 * The immutable default-branch commit it is still safe to suggest.
 *
 * Repository and focus checks belong in this pure boundary so an answer that
 * arrives while somebody is changing the form cannot be mistaken for one
 * that was current when the lookup began.
 */
export function defaultCommitSuggestion({
  checkedRepository,
  currentRepository,
  currentCommit,
  headSha,
  commitFocused = false,
  suggestionDeclined = false,
}) {
  if (normalizeRepository(currentRepository) !== checkedRepository) return null;
  if (String(currentCommit ?? "").trim() || commitFocused || suggestionDeclined) return null;
  return normalizeCommit(headSha);
}

/** A Palomar identifier, uppercased, or null. */
export function normalizePalomarId(raw) {
  const value = String(raw ?? "").trim().toUpperCase();
  return PALOMAR_ID_RE.test(value) ? value : null;
}

export function normalizeRepositoryPath(raw, { empty = false } = {}) {
  const value = String(raw ?? "").trim();
  if (!value) return empty ? "" : null;
  const segments = value.split("/");
  const invalid =
    value.startsWith("/") ||
    value.length > 400 ||
    segments.some((part) => !part || part === "." || part === "..") ||
    /[\\?#]/.test(value) ||
    segments[0].includes(":") ||
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f\x7f]/.test(value);
  return invalid ? null : value;
}

/** The canonical identity used by the public registration lookup. */
export function registrationIdentity(repository, projectPath, comparatorConfigPath) {
  const normalizedRepository = normalizeRepository(repository)?.toLowerCase();
  const normalizedProject = normalizeRepositoryPath(projectPath, { empty: true });
  const normalizedComparator = normalizeRepositoryPath(comparatorConfigPath);
  if (!normalizedRepository || normalizedProject === null || !normalizedComparator) return null;
  return {
    source_repository: normalizedRepository,
    project_path: normalizedProject || null,
    comparator_config_path: normalizedComparator,
  };
}

function sameIdentity(left, right) {
  return left?.source_repository === right?.source_repository &&
    left?.project_path === right?.project_path &&
    left?.comparator_config_path === right?.comparator_config_path;
}

/** SHA-256 of `repository + NUL + project-or-empty + NUL + comparator-path`. */
export async function registrationIdentityDigest(identity) {
  if (!identity || Object.keys(identity).sort().join(",") !==
      "comparator_config_path,project_path,source_repository") return null;
  const normalized = registrationIdentity(
    identity.source_repository,
    identity.project_path,
    identity.comparator_config_path,
  );
  if (!normalized || !sameIdentity(normalized, identity)) return null;
  const bytes = new globalThis.TextEncoder().encode([
    normalized.source_repository,
    normalized.project_path ?? "",
    normalized.comparator_config_path,
  ].join("\0"));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function registrationRow(value) {
  if (!exactKeys(value, ["id", "project_path", "comparator_config_path"])) return null;
  const id = normalizePalomarId(value.id);
  const project = value.project_path === null
    ? ""
    : normalizeRepositoryPath(value.project_path, { empty: true });
  const comparator = normalizeRepositoryPath(value.comparator_config_path);
  if (id !== value.id || project === null || !comparator || comparator !== value.comparator_config_path) {
    return null;
  }
  return { id, project_path: project || null, comparator_config_path: comparator };
}

/** Validate and normalize one bounded repository lookup response. */
export function repositoryRegistrations(value, expectedRepository) {
  const repository = normalizeRepository(expectedRepository)?.toLowerCase();
  if (!repository || !exactKeys(value, [
    "schema_version", "repository", "registrations_total", "truncated", "registrations",
  ])) return null;
  if (value.schema_version !== 1 || value.repository !== repository ||
      !Number.isInteger(value.registrations_total) || value.registrations_total < 0 ||
      typeof value.truncated !== "boolean" || !Array.isArray(value.registrations) ||
      value.registrations.length > 500) return null;
  const registrations = value.registrations.map(registrationRow);
  if (registrations.some((row) => row === null)) return null;
  const ids = registrations.map((row) => row.id);
  if (new Set(ids).size !== ids.length ||
      ids.some((id, index) => index && id >= ids[index - 1]) ||
      value.registrations_total < registrations.length ||
      (value.truncated &&
        (registrations.length !== 500 || value.registrations_total <= 500)) ||
      (!value.truncated && value.registrations_total !== registrations.length)) return null;
  return { ...value, registrations };
}

/** Validate an exact-identity lookup and bind it to the requested identity. */
export function exactRegistration(value, expectedIdentity) {
  const versionOne = value?.schema_version === 1;
  const keys = versionOne
    ? ["schema_version", "identity", "registration_id", "ambiguous"]
    : ["schema_version", "identity", "registration_id", "ambiguous", "commits"];
  if (!exactKeys(value, keys) || ![1, 2].includes(value.schema_version) ||
      typeof value.ambiguous !== "boolean" ||
      !exactKeys(value.identity, [
        "source_repository", "project_path", "comparator_config_path",
      ]) || !sameIdentity(value.identity, expectedIdentity) ||
      (!versionOne && (
        !Array.isArray(value.commits) || !value.commits.length ||
        value.commits.some((commit) => typeof commit !== "string" || !COMMIT_RE.test(commit)) ||
        value.commits.some((commit, index) => index && commit <= value.commits[index - 1])
      ))) return null;
  const registrationId = value.registration_id === null
    ? null
    : normalizePalomarId(value.registration_id);
  if (registrationId !== value.registration_id ||
      (value.ambiguous && registrationId !== null) ||
      (!value.ambiguous && registrationId === null)) return null;
  return {
    ...value,
    registration_id: registrationId,
    commits: versionOne ? [] : [...value.commits],
  };
}

/** An explicit repository-list choice that still describes the current identity. */
export function selectedRegistrationId(selected, identity) {
  const row = registrationRow(selected);
  if (!row || !identity) return null;
  return row.project_path === identity.project_path &&
    row.comparator_config_path === identity.comparator_config_path
    ? row.id
    : null;
}

/**
 * The files Palomar needs, and where it looks for them by default.
 *
 * A submission whose Lean project is not at the repository root is perfectly
 * acceptable; it just has to say so. Working out where things are is something
 * a browser can do from the repository tree, so a submitter should not have to
 * discover the requirement by having a submission refused.
 */
export const REQUIRED_AT_PROJECT_ROOT = ["lean-toolchain", "comparator.json"];
export const LAKEFILES = ["lakefile.toml", "lakefile.lean"];

/**
 * Directories whose contents belong to somebody else.
 *
 * A Lake package cache and a node_modules tree both contain whole projects,
 * complete with their own comparator.json. Suggesting one of those is worse
 * than suggesting nothing, because it is a plausible answer that is wrong.
 */
const VENDORED = /(^|\/)(\.lake|\.git|node_modules)(\/|$)/;

/** Git's mode for a symlink. The verifier refuses every symlinked component. */
const SYMLINK = "120000";

function directoryOf(path) {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

function basenameOf(path) {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * Given a repository tree, work out which directory is the project.
 *
 * The Comparator configuration is the marker: it is required, and it sits in
 * the project directory. One of them means one project. Several means the
 * submitter has to choose, and none means detection failed, which is not the
 * same as saying the repository is unsubmittable: a project may perfectly well
 * name its configuration something else, and this only looks for the default.
 *
 * Entries are `{path, type, mode}`, as GitHub's tree API gives them. The mode
 * matters: a symlinked configuration is detectable here and refused by the
 * verifier, so suggesting it would send somebody to a failed run.
 */
export function locateProject(entries) {
  const files = entries
    .map((entry) => (typeof entry === "string" ? { path: entry, type: "blob" } : entry))
    .filter((entry) => entry?.type === "blob" && entry.mode !== SYMLINK)
    .filter((entry) => !VENDORED.test(entry.path));
  const paths = files.map((entry) => entry.path);
  const named = (name) => paths.filter((path) => basenameOf(path) === name);

  const metadata = named("formalization.yaml");
  const candidates = [...new Set(named("comparator.json").map(directoryOf))]
    // A configuration with no Lakefile beside it is a fixture, not a project.
    .filter((project) =>
      LAKEFILES.some((name) => paths.includes(project ? `${project}/${name}` : name)));

  if (candidates.length === 1) {
    const project = candidates[0];
    const beside = project ? `${project}/formalization.yaml` : "formalization.yaml";
    return {
      found: true,
      project,
      config: project ? `${project}/comparator.json` : "comparator.json",
      // Metadata may sit outside a nested project, but only one candidate is
      // an answer; several is a guess, and a guess here is silently wrong.
      metadata: metadata.includes(beside) ? "" : (metadata.length === 1 ? metadata[0] : ""),
      ambiguous: false,
      candidates,
    };
  }
  return {
    found: false,
    project: "",
    config: "",
    metadata: "",
    ambiguous: candidates.length > 1,
    candidates,
  };
}
