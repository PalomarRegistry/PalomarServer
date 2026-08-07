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
  if (REPOSITORY_RE.test(value)) return value;
  const match = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(value);
  return match ? match[1] : null;
}

/** A full commit, lowercased, or null. Abbreviations are not commits. */
export function normalizeCommit(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  return COMMIT_RE.test(value) ? value : null;
}

/** A Palomar identifier, uppercased, or null. */
export function normalizePalomarId(raw) {
  const value = String(raw ?? "").trim().toUpperCase();
  return PALOMAR_ID_RE.test(value) ? value : null;
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
