import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizedQueuedRepairEdits,
  normalizedRepairEdits,
} from "../public/repair-contract.js";

test("profile two accepts the complete structured metadata payload", () => {
  const edits = normalizedRepairEdits([
    { field: "project.name", value: " Example " },
    { field: "project.authors", value: ["Ada Lovelace"] },
    { field: "project.responsible_maintainers", value: ["Ada Lovelace"] },
    { field: "sources", value: [{
      title: "Source theorem", type: "paper", relationship: "formalizes",
      authors: ["Emmy Noether"],
    }] },
    { field: "automation.methods", value: [{ method: "agent", models: ["gpt-5"] }] },
  ], 2);
  assert.deepEqual(edits.map((edit) => edit.field), [
    "automation.methods", "project.authors", "project.name",
    "project.responsible_maintainers", "sources",
  ]);
  assert.equal(edits.find((edit) => edit.field === "project.name").value, "Example");
});

test("profile two rejects source claims that cannot pass provenance", () => {
  assert.throws(
    () => normalizedRepairEdits([{ field: "sources", value: [{
      title: "Only background", relationship: "background",
    }] }], 2),
    /formalizes, adapts/,
  );
  assert.throws(
    () => normalizedRepairEdits([{ field: "sources", value: [{
      title: "Original", type: "original-proof", relationship: "formalizes",
    }] }], 2),
    /original-proof/,
  );
});

test("profile one remains constrained to its original five fields", () => {
  assert.deepEqual(normalizedRepairEdits([
    { field: "project.name", value: "Example" },
  ]), [{ field: "project.name", value: "Example" }]);
  assert.throws(
    () => normalizedRepairEdits([{ field: "sources", value: [] }]),
    /unsupported/,
  );
});

test("classification repairs canonicalize and enforce the verifier taxonomies", () => {
  const taxonomies = {
    "classification.arxiv": ["math.AG", "math.LO"],
    "classification.msc2020": { "14D20": "Algebraic stacks", "03B35": "Mechanized proofs" },
  };
  assert.deepEqual(normalizedRepairEdits([
    { field: "classification.arxiv", value: ["MATH.ag"] },
    { field: "classification.msc2020", value: ["14d20"] },
  ], 2, taxonomies), [
    { field: "classification.arxiv", value: ["math.AG"] },
    { field: "classification.msc2020", value: ["14D20"] },
  ]);
  assert.throws(
    () => normalizedRepairEdits([
      { field: "classification.arxiv", value: ["math.AG", "MATH.ag"] },
    ], 2, taxonomies),
    /duplicate/,
  );
  assert.throws(
    () => normalizedRepairEdits([
      { field: "classification.msc2020", value: ["99Z99"] },
    ], 2, taxonomies),
    /unrecognized/,
  );
});

test("repair values respect constraints enforced by formalization validation", () => {
  assert.throws(
    () => normalizedRepairEdits([{ field: "sources", value: [{
      title: "Source", relationship: "formalizes", location: "x".repeat(1001),
    }] }], 2),
    /1000/,
  );
  assert.throws(
    () => normalizedRepairEdits([{ field: "repository.substantive_formalization", value: {
      id: "not-a-repository", revision: "a".repeat(40),
    } }], 2),
    /owner\/name/,
  );
});

test("the queued-repair boundary cannot omit either verifier taxonomy", () => {
  const edits = [{ field: "project.name", value: "Example" }];
  assert.throws(() => normalizedQueuedRepairEdits(edits, 2), /taxonomy/);
  assert.deepEqual(normalizedQueuedRepairEdits(edits, 2, {
    "classification.arxiv": new Map(),
    "classification.msc2020": new Map(),
  }), edits);
});
