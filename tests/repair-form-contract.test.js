import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  canonicalClassification,
  classificationProblem,
  shouldShowDiagnostic,
  taxonomyIndex,
} from "../public/repair-form-contract.js";
import {
  canAddClassification,
  classificationMaximum,
  safeDraft,
} from "../public/formalization-profile.js";

test("taxonomy indexes support canonical case and MSC summary records", async () => {
  const msc = JSON.parse(await readFile(
    new URL("../public/taxonomies/msc2020-codes.json", import.meta.url), "utf8",
  ));
  assert.equal(typeof msc, "object");
  assert.equal(Array.isArray(msc), false);
  assert.ok(Object.keys(msc).every((code) => /^[0-9]{2}(?:-|[A-Z])[0-9]{2}$/.test(code)));
  assert.ok(Object.values(msc).every((summary) =>
    typeof summary === "string" && summary.length > 0));
  const index = taxonomyIndex(msc);
  assert.equal(canonicalClassification(" 05c10 ", index), "05C10");
  assert.equal(
    index.summaries.get("05C10"),
    "Planar graphs; geometric and topological aspects of graph theory",
  );
  assert.equal(taxonomyIndex({}), null, "an empty snapshot must not reject every value");
});

test("classification validation accepts canonicalizable case and detects real problems", () => {
  const index = taxonomyIndex({ "05C10": "Planar graphs", "03B35": "Mechanized proofs" });
  assert.equal(classificationProblem("05c10", index, true), "");
  assert.match(classificationProblem("05C10", index, true, ["05c10"]), /only once/);
  assert.match(classificationProblem("99Z99", index, true), /official classification/);
  assert.equal(classificationProblem("99Z99", null, true), "");
  assert.equal(classificationProblem("99Z99", index, false), "");
});

test("classification repair drafts and add controls share the field limits", () => {
  const failure = { repair_draft: { values: {
    "classification.arxiv": ["math.OA", "math.DS", "math.GR"],
    "classification.msc2020": Array.from({ length: 9 }, (_, index) => String(index)),
  } } };
  assert.equal(classificationMaximum("classification.arxiv"), 2);
  assert.equal(classificationMaximum("classification.msc2020"), 8);
  assert.deepEqual(safeDraft(failure, "classification.arxiv"), ["math.OA", "math.DS"]);
  assert.equal(safeDraft(failure, "classification.msc2020").length, 8);
  assert.equal(canAddClassification("classification.arxiv", 1), true);
  assert.equal(canAddClassification("classification.arxiv", 2), false);
});

test("guided diagnostics are hidden only when a matching repair form is visible", () => {
  const guided = { field: "project.name" };
  const manual = { field: "repository.path" };
  const repaired = new Set(["project.name"]);
  assert.equal(shouldShowDiagnostic(guided, true, repaired), false);
  assert.equal(shouldShowDiagnostic(guided, false, repaired), true);
  assert.equal(shouldShowDiagnostic(manual, true, repaired), true);
});
