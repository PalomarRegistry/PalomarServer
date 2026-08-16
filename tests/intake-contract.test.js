import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizationRelationshipLabel,
  MAX_PREFLIGHT_REPAIR_BYTES,
  validateIntake,
} from "../src/intake-contract.js";

const COMMIT = "A".repeat(40);
const ID = "palomar-2026-07-29-000123";

function fields(overrides = {}) {
  return new Map(Object.entries({
    repository: " https://github.com/Owner/Repo.git ",
    commit: ` ${COMMIT} `,
    existing_id: ` ${ID} `,
    context: "  Notes for the reviewer.  ",
    authorization_relationship: " maintainer ",
    authorization_evidence: "  Directly maintained.  ",
    project_path: " proof ",
    comparator_config_path: "proof/comparator.json",
    formalization_metadata_path: " docs/formalization.yaml ",
    ...overrides,
  }));
}

test("a valid intake has one normalized record projection and redisplay values", () => {
  const result = validateIntake(fields());

  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.submission, {
    repository: "Owner/Repo",
    commit: "a".repeat(40),
    existing_id: "PALOMAR-2026-07-29-000123",
    context: "Notes for the reviewer.",
    requested_paths: {
      project_path: "proof",
      comparator_config_path: "proof/comparator.json",
      formalization_metadata_path: "docs/formalization.yaml",
    },
    authorization_relationship: "maintainer",
    authorization_evidence: "Directly maintained.",
  });
  assert.deepEqual(result.values, {
    repository: " https://github.com/Owner/Repo.git ",
    commit: ` ${COMMIT} `,
    existing_id: "palomar-2026-07-29-000123",
    context: "Notes for the reviewer.",
    authorization_relationship: "maintainer",
    authorization_evidence: "Directly maintained.",
    project_path: " proof ",
    comparator_config_path: "proof/comparator.json",
    formalization_metadata_path: " docs/formalization.yaml ",
  });
});

test("an invalid intake has stable actionable problems and no record projection", () => {
  const result = validateIntake(fields({
    repository: "not-a-repository",
    commit: "short",
    existing_id: "not-an-id",
    authorization_relationship: "delegated",
    project_path: "/proof",
    comparator_config_path: "../comparator.json",
    formalization_metadata_path: "docs//formalization.yaml",
  }));

  assert.equal(result.submission, null);
  assert.deepEqual(result.problems, [
    "Repository must be a GitHub owner/name or URL.",
    "Commit must be a full 40-character SHA. Branches and tags move.",
    "Existing Palomar ID is malformed.",
    "Say whether you maintain this formalization or have approval from a responsible author or maintainer.",
    "Comparator configuration is required. Give the repository-relative path to the one configuration this entry records.",
    "Project directory must be a path inside the repository, written with forward slashes.",
    "Comparator configuration must be a path inside the repository, written with forward slashes.",
    "Formalization metadata must be a path inside the repository, written with forward slashes.",
  ]);
});

test("optional prose is trimmed, bounded, and represented consistently", () => {
  const result = validateIntake(fields({
    existing_id: "",
    context: `  ${"c".repeat(4001)}  `,
    authorization_evidence: `  ${"e".repeat(4001)}  `,
    project_path: "",
    formalization_metadata_path: "",
  }));

  assert.deepEqual(result.problems, []);
  assert.equal(result.submission.existing_id, null);
  assert.equal(result.submission.context, "c".repeat(4000));
  assert.equal(result.submission.authorization_evidence, "e".repeat(4000));
  assert.equal(result.submission.requested_paths.project_path, null);
  assert.equal(result.submission.requested_paths.formalization_metadata_path, null);
  assert.equal(result.values.context, "c".repeat(4000));
  assert.equal(result.values.authorization_evidence, "e".repeat(4000));
});

test("a preliminary repair survives redisplay only within its private payload bound", () => {
  const payload = JSON.stringify({ profile_version: 2, edits: [] });
  assert.equal(
    validateIntake(fields({ preflight_repair: payload })).values.preflight_repair,
    payload,
  );
  assert.equal(
    Object.hasOwn(validateIntake(fields({
      preflight_repair: "x".repeat(MAX_PREFLIGHT_REPAIR_BYTES + 1),
    })).values, "preflight_repair"),
    false,
  );
});

test("repository paths reject every non-relative spelling without rewriting", () => {
  const badPaths = [
    "/absolute",
    "../outside",
    "proof/./inside",
    "proof//inside",
    "proof\\inside",
    "proof?inside",
    "proof#inside",
    "C:proof/inside",
    "proof\ninside",
    "a".repeat(401),
  ];
  for (const projectPath of badPaths) {
    const result = validateIntake(fields({ project_path: projectPath }));
    assert.equal(result.submission, null, `${JSON.stringify(projectPath)} was accepted`);
    assert.deepEqual(result.problems, [
      "Project directory must be a path inside the repository, written with forward slashes.",
    ]);
  }

  assert.equal(
    validateIntake(fields({ project_path: "invalid" })).submission.requested_paths.project_path,
    "invalid",
  );
});

test("the current relationship vocabulary maps exactly to verifier inputs", () => {
  assert.equal(
    authorizationRelationshipLabel("maintainer"),
    "I am a responsible author or maintainer",
  );
  assert.equal(
    authorizationRelationshipLabel("approved"),
    "I have approval from a responsible author or maintainer",
  );
  assert.equal(
    authorizationRelationshipLabel("technical-test"),
    "I am a Palomar Technical Maintainer testing the workflow",
  );
  assert.equal(authorizationRelationshipLabel("delegated"), undefined);
});

test("a technical test is an explicit normalized relationship", () => {
  const result = validateIntake(fields({
    authorization_relationship: " technical-test ",
    authorization_evidence: "",
  }));
  assert.deepEqual(result.problems, []);
  assert.equal(result.submission.authorization_relationship, "technical-test");
});
