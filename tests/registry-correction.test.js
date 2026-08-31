import assert from "node:assert/strict";
import test from "node:test";

import {
  correctableMetadata,
  normalizeRegistryCorrection,
  registryCorrectionDelta,
} from "../public/registry-correction.js";

const baseline = {
  id: "PALOMAR-2026-08-31-000001",
  version: 2,
  title: "Old title",
  abstract: "A result.",
  authors: [{ name: "Ada" }],
  classification: { arxiv: ["math.LO"], msc2020: ["03B35"] },
  provenance: {
    responsible_maintainers: [{ name: "Ada", github: "ada" }],
    mathematical_sources: [],
    related_formalizations: [],
  },
};

function correction(metadata = correctableMetadata(baseline)) {
  return {
    schema_version: 1,
    based_on: { id: baseline.id, version: baseline.version },
    explanation: "Correct a transcription error in the public title.",
    metadata,
  };
}

test("a registry correction derives its changed fields from the exact baseline", () => {
  const metadata = correctableMetadata(baseline);
  metadata.title = "Correct title";
  const result = registryCorrectionDelta(correction(metadata), baseline);
  assert.deepEqual(result.changed_fields, ["title"]);
  assert.deepEqual(result.edits, [{ field: "title", value: "Correct title" }]);
  assert.equal(result.kind, "palomar-maintainer");
});

test("a registry correction may retain an empty mathematical-source list", () => {
  const normalized = normalizeRegistryCorrection(correction());
  assert.deepEqual(normalized.metadata.provenance.mathematical_sources, []);
});

test("a no-op or stale correction fails closed", () => {
  assert.throws(() => registryCorrectionDelta(correction(), baseline), /does not change/);
  const stale = correction();
  stale.metadata.title = "Correct title";
  stale.based_on.version = 1;
  assert.throws(() => registryCorrectionDelta(stale, baseline), /identity disagrees/);
});

test("the correction contract rejects fields outside the public metadata allowlist", () => {
  const value = correction();
  value.metadata.repository = "other/repository";
  assert.throws(() => normalizeRegistryCorrection(value), /unsupported fields/);
});
