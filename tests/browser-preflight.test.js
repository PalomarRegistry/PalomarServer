import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  BROWSER_PREFLIGHT_POLICY,
  duplicateJsonKeys,
  inspectTree,
  validateComparator,
  validateFormalization,
  validateToolchain,
} from "../browser/preflight.js";

const VALID_FORMALIZATION = `
version: v0.4
project:
  name: Example
  authors: [Example Author]
  license: MIT
  responsible_maintainers: [Example Maintainer]
classification:
  arxiv: [math.LO]
  msc2020: [03B35]
sources:
  - title: Original result
    type: original-proof
    relationship: other
automation:
  methods:
    - method: manual
review:
  status: self-assessed
`;

test("portable metadata validation accepts the current minimal contract", () => {
  assert.deepEqual(validateFormalization(VALID_FORMALIZATION), []);
});

test("YAML duplicate and merge keys are deterministic failures", () => {
  for (const source of [
    "project:\n  name: first\n  name: second\n",
    "defaults: &defaults\n  name: Example\nproject:\n  <<: *defaults\n",
  ]) {
    assert.deepEqual(validateFormalization(source).map((item) => item.code), [
      "formalization.invalid_yaml",
    ]);
  }
});

test("the JSON scanner finds duplicate keys only within their object", () => {
  assert.deepEqual(
    duplicateJsonKeys('{"outer":{"name":"one","name":"two"},"name":"three"}'),
    ["name"],
  );
  assert.deepEqual(duplicateJsonKeys('{"left":{"name":"one"},"right":{"name":"two"}}'), []);
  assert.deepEqual(duplicateJsonKeys('{"items":[{"name":"one","name":"two"}]}'), ["name"]);
});

test("Comparator validation remains strict JSON with duplicate detection", () => {
  assert.deepEqual(
    validateComparator('{"challenge_module":"A","challenge_module":"B"}')
      .map((item) => item.code),
    ["comparator.duplicate_key"],
  );
});

test("toolchain release candidates sort before the matching release", () => {
  assert.deepEqual(validateToolchain("leanprover/lean4:v4.28.0"), []);
  assert.deepEqual(validateToolchain("leanprover/lean4:v4.28.0-rc1").map((item) => item.code), [
    "toolchain.unsupported",
  ]);
});

test("tree inspection binds required files to the selected project", () => {
  const blob = (path, size = 10) => ({ path, type: "blob", mode: "100644", size, sha: path });
  const entries = [
    blob("LICENSE"),
    blob("proof/lakefile.lean"),
    blob("proof/lake-manifest.json"),
    blob("proof/formalization.yaml"),
    blob("proof/comparator.json"),
    blob("proof/lean-toolchain"),
  ];
  const result = inspectTree(entries, {
    project: "proof",
    comparator: "proof/comparator.json",
    metadata: "",
  });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.files.formalization.path, "proof/formalization.yaml");
});

test("a missing conventional license remains advisory in the browser", () => {
  const blob = (path) => ({ path, type: "blob", mode: "100644", size: 10, sha: path });
  const result = inspectTree([
    blob("lakefile.toml"),
    blob("formalization.yaml"),
    blob("comparator.json"),
    blob("lean-toolchain"),
  ], { project: "", comparator: "comparator.json", metadata: "" });
  const license = result.diagnostics.find((item) => item.code === "license.missing");
  assert.equal(license?.advisory, true);
});

test("the shipped policy remains within the browser payload contract", () => {
  assert.equal(BROWSER_PREFLIGHT_POLICY.schema_version, 1);
  assert.ok(JSON.stringify(BROWSER_PREFLIGHT_POLICY).length < 25_000);
});

test("the lazy browser bundle stays below its compressed page-weight budget", async () => {
  const bundle = await readFile(new URL("../public/preflight.js", import.meta.url));
  assert.ok(gzipSync(bundle).byteLength < 100 * 1024);
});
