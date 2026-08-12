import assert from "node:assert/strict";
import test from "node:test";

import { normalizedRepairEdits } from "../public/repair-contract.js";

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
