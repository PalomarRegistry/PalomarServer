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

function directoryOf(path) {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/**
 * Given every path in a repository, work out which directory is the project.
 *
 * The Comparator configuration is the marker: it is required, and it sits in
 * the project directory. One of them means one project. Several means the
 * submitter has to choose, and none means there is nothing to submit.
 */
export function locateProject(paths) {
  const configs = paths.filter((path) => path.endsWith("comparator.json"));
  const metadata = paths.filter((path) => path.endsWith("formalization.yaml"));
  const candidates = [...new Set(configs.map(directoryOf))];

  if (candidates.length === 1) {
    const project = candidates[0];
    const lakefile = LAKEFILES.some((name) =>
      paths.includes(project ? `${project}/${name}` : name));
    return {
      found: true,
      project,
      // Metadata may sit at the repository root even for a nested project.
      metadata: metadata.includes(project ? `${project}/formalization.yaml` : "formalization.yaml")
        ? ""
        : (metadata[0] ?? ""),
      lakefile,
      ambiguous: false,
    };
  }
  return {
    found: false,
    project: "",
    metadata: "",
    lakefile: false,
    ambiguous: candidates.length > 1,
    candidates,
  };
}
