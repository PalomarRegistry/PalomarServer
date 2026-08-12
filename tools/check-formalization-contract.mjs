import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  FORMALIZATION_FIELDS,
  FORMALIZATION_PROFILE_VERSION,
} from "../public/formalization-profile.js";

const upstream = resolve(process.argv[2] ?? "../PalomarSubmission");
const load = async (path) => JSON.parse(await readFile(path, "utf8"));
const profile = await load(resolve(upstream, "formalization-profile.json"));

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

console.log("Formalization repair profile and taxonomy snapshots match PalomarSubmission.");
