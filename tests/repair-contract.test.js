import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizedQueuedRepairEdits,
  normalizedRepairEdits,
} from "../public/repair-contract.js";
import {
  sourceContributorLines,
  sourceContributorText,
} from "../public/formalization-profile.js";

test("profile two accepts the complete structured metadata payload", () => {
  const edits = normalizedRepairEdits([
    { field: "project.name", value: " Example " },
    { field: "project.authors", value: ["Ada Lovelace"] },
    { field: "project.responsible_maintainers", value: ["Ada Lovelace"] },
    { field: "sources", value: [{
      title: "Source theorem", type: "article", relationship: "formalizes",
      authors: ["Emmy Noether"],
    }] },
    { field: "automation.methods", value: [{ method: "agent", models: ["gpt-5"] }] },
  ], 2);
  assert.deepEqual(edits.map((edit) => edit.field), [
    "automation.methods", "project.authors", "project.name",
    "project.responsible_maintainers", "sources",
  ]);
  assert.equal(edits.find((edit) => edit.field === "project.name").value, "Example");
  assert.equal(edits.find((edit) => edit.field === "sources").value[0].type, "article");
});

test("profile three adds a bounded multiline project description", () => {
  assert.deepEqual(normalizedRepairEdits([{
    field: "project.description",
    value: "  A theorem about configurations.\nIt proves the selected extremal result.  ",
  }], 3), [{
    field: "project.description",
    value: "A theorem about configurations.\nIt proves the selected extremal result.",
  }]);
  assert.throws(
    () => normalizedRepairEdits([{ field: "project.description", value: "Description" }], 2),
    /unsupported/,
  );
  assert.throws(
    () => normalizedRepairEdits([{ field: "project.description", value: "x".repeat(10_001) }], 3),
    /10000/,
  );
});

test("profile four adds structured non-author source credits", () => {
  const edits = normalizedRepairEdits([{
    field: "sources",
    value: [{
      title: "Source theorem",
      authors: ["Emmy Noether"],
      contributors: [
        { name: "Wilhelm Magnus", role: "problem-proposer" },
        { name: "Evgenii Khukhro", role: "editor" },
      ],
      relationship: "formalizes",
    }],
  }], 4);
  assert.deepEqual(edits[0].value[0].contributors, [
    { name: "Wilhelm Magnus", role: "problem-proposer" },
    { name: "Evgenii Khukhro", role: "editor" },
  ]);
  assert.throws(
    () => normalizedRepairEdits([{
      field: "sources",
      value: [{
        title: "Source theorem",
        contributors: [{ name: "Wilhelm Magnus", role: "problem-proposer" }],
        relationship: "formalizes",
      }],
    }], 3),
    /unsupported/,
  );
  assert.throws(
    () => normalizedRepairEdits([{
      field: "sources",
      value: [{
        title: "Source theorem",
        contributors: [{ name: "Wilhelm Magnus" }],
        relationship: "formalizes",
      }],
    }], 4),
    /name and role|one line/,
  );
});

test("source contributor controls round-trip names and free-form roles", () => {
  const contributors = [
    { name: "Wilhelm Magnus", role: "problem-proposer" },
    { name: "Evgenii Khukhro", role: "editor | coordinating editor" },
  ];
  assert.deepEqual(
    sourceContributorLines(sourceContributorText(contributors)),
    contributors,
  );
  assert.deepEqual(sourceContributorLines("Missing role"), [
    { name: "Missing role", role: "" },
  ]);
});

test("source types are bounded free text", () => {
  for (const type of ["article", "formalization", "web-discussion", "conversation"]) {
    const edits = normalizedRepairEdits([{ field: "sources", value: [{
      title: "Source theorem", type, relationship: "formalizes",
    }] }], 2);
    assert.equal(edits[0].value[0].type, type);
  }
  assert.throws(
    () => normalizedRepairEdits([{ field: "sources", value: [{
      title: "Source theorem", type: "x".repeat(201), relationship: "formalizes",
    }] }], 2),
    /200/,
  );
});

test("descriptive source and automation values are bounded free text", () => {
  const edits = normalizedRepairEdits([
    { field: "sources", value: [
      { title: "Source theorem", relationship: "formalizes" },
      {
        title: "Informal notes",
        type: "private correspondence",
        relationship: "suggested the key lemma",
        note: "The source supplied an idea, not the theorem.\nThis exact nuance is retained.",
        author_endorsement: "reviewed an early draft",
      },
    ] },
    { field: "automation.methods", value: [{ method: "AI-assisted" }] },
  ], 2);
  assert.equal(edits[0].value[0].method, "AI-assisted");
  assert.equal(edits[1].value[1].relationship, "suggested the key lemma");
  assert.match(edits[1].value[1].note, /exact nuance is retained/);
  assert.equal(edits[1].value[1].author_endorsement, "reviewed an early draft");

  const original = normalizedRepairEdits([{ field: "sources", value: [{
    title: "Original result",
    type: "original-proof",
    relationship: "first presented in this formalization",
  }] }], 2);
  assert.equal(original[0].value[0].relationship, "first presented in this formalization");
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
