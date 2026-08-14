#!/usr/bin/env node

/**
 * Retire the identifying fields left in rate documents written before the
 * Server stopped recording them.
 *
 * Ordinary traffic already sheds them: `resetRateRecord` drops every field in
 * `IDENTIFYING_FIELDS` whenever a registration touches a document. But a
 * submitter who never registers again leaves theirs sitting there, so this is
 * the one-time pass over a local clone of the state repository. It rewrites
 * files in place; the operator reviews the diff, commits, and pushes.
 *
 * Nothing here needs the GitHub API or the pepper. The files are plain JSON on
 * disk, and the only change ever made is the removal of those fields.
 *
 *   tools/strip-rate-logins.js ../PalomarSubmissionState            # report only
 *   tools/strip-rate-logins.js ../PalomarSubmissionState --write    # rewrite
 *
 * A rewrite is a whole-document reserialization, which in general is not a
 * byte-preserving operation: key order, number spellings, duplicate keys and
 * the precision of very large integers can all move. So a file is only ever
 * rewritten when its bytes are already exactly the canonical serialization of
 * what they parse to, which is what the Worker writes. Anything else is
 * reported and left alone for a human, because this tool cannot rewrite it
 * without also changing something it was not asked to change.
 *
 * Rewriting is not erasure. Git history in the state repository retains the old
 * bodies, and that is a question for its retention policy rather than for this
 * pass.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { IDENTIFYING_FIELDS } from "../src/admission-contract.js";

// Exactly what `src/github.js` writes for every state document.
const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

const argv = process.argv.slice(2);
const write = argv.includes("--write");
const unknown = argv.filter((item) => item.startsWith("--") && item !== "--write");
const root = argv.find((item) => !item.startsWith("--"));
if (!root || unknown.length > 0) {
  if (unknown.length > 0) console.error(`unknown argument ${unknown[0]}`);
  console.error("usage: tools/strip-rate-logins.js <state repository checkout> [--write]");
  process.exit(2);
}

const directory = resolve(root, "index", "rate");
let names;
try {
  names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
} catch (error) {
  console.error(`cannot read ${directory}: ${error.message}`);
  process.exit(2);
}

let rewritable = 0;
let refused = 0;
for (const name of names) {
  const path = resolve(directory, name);
  const text = await readFile(path, "utf8");
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    refused += 1;
    console.error(`index/rate/${name} is not JSON and was left alone: ${error.message}`);
    continue;
  }
  const present = IDENTIFYING_FIELDS.filter((field) => Object.hasOwn(value ?? {}, field));
  if (present.length === 0) continue;

  // Reserializing what we parsed must reproduce the file byte for byte. If it
  // does not, this document holds something that a parse-and-rewrite would
  // silently alter, and removing a field is no longer the only edit we would
  // be making.
  if (serialize(value) !== text) {
    refused += 1;
    console.error(
      `index/rate/${name} carries ${present.join(", ")} but is not canonically ` +
      "formatted; rewriting it would change more than those fields, so it was " +
      "left alone. Edit it by hand.",
    );
    continue;
  }

  rewritable += 1;
  for (const field of present) delete value[field];
  if (write) await writeFile(path, serialize(value));
  console.log(`${write ? "rewrote" : "carries"} ${present.join(", ")} in index/rate/${name}`);
}

console.log(
  `${rewritable} of ${names.length} rate documents ${write ? "rewritten" : "can be rewritten"}`,
);
if (refused > 0) console.error(`${refused} left for a human`);
if (!write && rewritable > 0) console.log("re-run with --write to rewrite them, then commit");
process.exit(refused > 0 ? 1 : 0);
