/**
 * Pure normalization and validation for both browser and agent intake.
 *
 * Body decoding, responses, GitHub reads, and State writes stay in the Worker
 * composition root. This module decides whether submitted fields describe one
 * current intake and, only when they do, returns the normalized record fields.
 */

import {
  normalizeCommit,
  normalizePalomarId,
  normalizeRepository,
} from "./submission.js";

const RELATIONSHIPS = new Set(["maintainer", "approved", "technical-test"]);
// The verifier speaks the long form; the form and the record speak the short.
const RELATIONSHIP_LABELS = {
  maintainer: "I am a responsible author or maintainer",
  approved: "I have approval from a responsible author or maintainer",
  "technical-test": "I am a Palomar Technical Maintainer testing the workflow",
};

export function authorizationRelationshipLabel(relationship) {
  return RELATIONSHIP_LABELS[relationship];
}

// A repository-relative path, as `{path}` or `{invalid: true}`.
//
// The rules are the verifier's, character for character. Anywhere the two
// disagree the submitter loses: a path this accepts and the verifier refuses
// costs a dispatched run that was always going to fail, and one this refuses
// and the verifier would have accepted is a submission turned away for no
// reason. A tagged result rather than a sentinel string, so a directory
// genuinely called `invalid` is a path and not an error.
function repositoryPath(fields, name) {
  const raw = String(fields.get(name) ?? "").trim();
  if (!raw) return { path: null };
  // Nothing here is rewritten. A trailing slash and a leading slash are both
  // refused rather than trimmed: quietly turning what somebody typed into a
  // different path is worse than telling them.
  const segments = raw.split("/");
  const bad =
    raw.startsWith("/") ||
    raw.length > 400 ||
    segments.some((part) => !part || part === "." || part === "..") ||
    /[\\?#]/.test(raw) ||
    segments[0].includes(":") ||
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f\x7f]/.test(raw);
  return bad ? { invalid: true } : { path: raw };
}

/**
 * Validate a FormData- or Map-like collection with a synchronous `get` method.
 *
 * `values` is what the browser form must show again after any later refusal.
 * `submission` is deliberately null on failure, so invalid tagged paths can
 * never be mistaken for normalized record fields by a caller that checks it.
 */
export function validateIntake(fields) {
  const repository = normalizeRepository(fields.get("repository"));
  const commit = normalizeCommit(fields.get("commit"));
  const rawExistingId = String(fields.get("existing_id") ?? "").trim();
  const existingId = normalizePalomarId(rawExistingId);
  const context = String(fields.get("context") ?? "").trim().slice(0, 4000);
  const relationship = String(fields.get("authorization_relationship") ?? "").trim();
  const evidence = String(fields.get("authorization_evidence") ?? "").trim().slice(0, 4000);

  const projectPath = repositoryPath(fields, "project_path");
  const configPath = repositoryPath(fields, "comparator_config_path");
  const metadataPath = repositoryPath(fields, "formalization_metadata_path");

  const values = {
    repository: String(fields.get("repository") ?? ""),
    commit: String(fields.get("commit") ?? ""),
    existing_id: rawExistingId,
    context,
    authorization_relationship: relationship,
    authorization_evidence: evidence,
    project_path: String(fields.get("project_path") ?? ""),
    comparator_config_path: String(fields.get("comparator_config_path") ?? ""),
    formalization_metadata_path: String(fields.get("formalization_metadata_path") ?? ""),
  };

  const problems = [];
  if (!repository) problems.push("Repository must be a GitHub owner/name or URL.");
  if (!commit) {
    problems.push("Commit must be a full 40-character SHA. Branches and tags move.");
  }
  if (rawExistingId && !existingId) {
    problems.push("Existing Palomar ID is malformed.");
  }
  if (!RELATIONSHIPS.has(relationship)) {
    problems.push(
      "Say whether you maintain this formalization, have approval, or are running a technical-team test.",
    );
  }
  if (!configPath.path) {
    problems.push(
      "Comparator configuration is required. Give the repository-relative path to the one configuration this entry records.",
    );
  }
  for (const [name, value] of [
    ["Project directory", projectPath],
    ["Comparator configuration", configPath],
    ["Formalization metadata", metadataPath],
  ]) {
    if (value.invalid) {
      problems.push(`${name} must be a path inside the repository, written with forward slashes.`);
    }
  }

  return {
    values,
    problems,
    submission: problems.length ? null : {
      repository,
      commit,
      existing_id: existingId || null,
      context: context || null,
      requested_paths: {
        project_path: projectPath.path,
        comparator_config_path: configPath.path,
        formalization_metadata_path: metadataPath.path,
      },
      authorization_relationship: relationship,
      // The server-owned technical-test path must not carry submitter-written
      // approval evidence, even when a hand-written POST supplies it.
      authorization_evidence: relationship !== "technical-test" && evidence ? evidence : null,
    },
  };
}
