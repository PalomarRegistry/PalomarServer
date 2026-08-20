import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  classificationMaximum,
  FORMALIZATION_FIELDS,
  FORMALIZATION_PROFILE_VERSION,
} from "../public/formalization-profile.js";
import {
  BROWSER_PREFLIGHT_POLICY,
  validatePortable,
} from "../browser/preflight.js";

const upstream = resolve(process.argv[2] ?? "../PalomarSubmission");
const load = async (path) => JSON.parse(await readFile(path, "utf8"));
const profile = await load(resolve(upstream, "formalization-profile.json"));
const browserPolicy = await load(resolve(upstream, "browser-preflight-policy.json"));

assert.deepEqual(
  BROWSER_PREFLIGHT_POLICY,
  browserPolicy,
  "the browser preflight policy drifted from PalomarSubmission",
);

// The repair form and the repair contract cap classification lists without
// reading the policy, because the browser loads them unbundled.
for (const [name, [, maximum]] of Object.entries(
  browserPolicy.formalization.classification_cardinality,
)) {
  assert.equal(
    classificationMaximum(`classification.${name}`),
    maximum,
    `the ${name} classification maximum drifted from PalomarSubmission`,
  );
}

assert.equal(FORMALIZATION_PROFILE_VERSION, profile.schema_version);
assert.deepEqual(
  Object.fromEntries(
    Object.entries(FORMALIZATION_FIELDS).map(([field, value]) => [field, value.input]),
  ),
  Object.fromEntries(
    Object.entries(profile.fields).map(([field, value]) => [field, value.input]),
  ),
  "the guided repair field and input profile drifted from PalomarSubmission",
);

for (const name of ["arxiv-categories.json", "msc2020-codes.json"]) {
  const producer = await load(resolve(upstream, "taxonomies", name));
  const consumer = await load(resolve("public", "taxonomies", name));
  const producerCodes = Object.keys(producer).sort();
  const consumerCodes = (Array.isArray(consumer) ? consumer : Object.keys(consumer)).sort();
  assert.deepEqual(
    consumerCodes,
    producerCodes,
    `${name} code set drifted from PalomarSubmission`,
  );
  if (!Array.isArray(consumer)) {
    assert.deepEqual(consumer, producer, `${name} summaries drifted from PalomarSubmission`);
  }
}

const fixtureDocument = await load(resolve(upstream, "tests", "fixtures", "browser-preflight.json"));
assert.equal(fixtureDocument.schema_version, 1);
for (const fixture of fixtureDocument.cases) {
  const input = {};
  for (const name of ["formalization", "comparator", "toolchain"]) {
    if (fixture[name] !== undefined) input[name] = fixture[name];
  }
  for (const [name, path] of Object.entries(fixture.files ?? {})) {
    input[name] = await readFile(resolve(upstream, "tests", "fixtures", path), "utf8");
  }
  assert.deepEqual(
    validatePortable(input).map((item) => item.code).sort(),
    fixture.expected_codes,
    `browser preflight fixture ${fixture.id} drifted from PalomarSubmission`,
  );
}

console.log("Formalization repair and browser preflight contracts match PalomarSubmission.");
