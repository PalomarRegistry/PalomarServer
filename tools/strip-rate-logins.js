#!/usr/bin/env node

/**
 * Drop the `login` field from rate documents written before the Server stopped
 * recording it.
 *
 * Ordinary traffic already sheds it: `resetRateRecord` deletes it whenever a
 * registration touches a document. But a submitter who never registers again
 * leaves theirs sitting there, so this is the one-time pass over a local clone
 * of the state repository. It rewrites files in place; the operator reviews the
 * diff, commits, and pushes.
 *
 * Nothing here needs the GitHub API or the pepper. The files are plain JSON on
 * disk, and this only ever removes a field.
 *
 *   tools/strip-rate-logins.js ../PalomarSubmissionState            # report only
 *   tools/strip-rate-logins.js ../PalomarSubmissionState --write    # rewrite
 *
 * Rewriting is not erasure. Git history in the state repository retains the old
 * bodies, and the retention policy is what covers those.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const write = argv.includes("--write");
const root = argv.find((item) => !item.startsWith("--"));
if (!root) {
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

let carrying = 0;
for (const name of names) {
  const path = resolve(directory, name);
  const text = await readFile(path, "utf8");
  const value = JSON.parse(text);
  if (!Object.hasOwn(value, "login")) continue;
  carrying += 1;
  // Rewrite the whole document rather than editing the text, so the result is
  // the same JSON the Worker would have written, and never a partial edit of a
  // file whose shape surprised us.
  delete value.login;
  // The trailing newline matches what the state writer produces.
  if (write) await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  console.log(`${write ? "rewrote" : "carries a login"} index/rate/${name}`);
}

console.log(
  `${carrying} of ${names.length} rate documents ${write ? "rewritten" : "still carry a login"}`,
);
if (!write && carrying > 0) console.log("re-run with --write to rewrite them, then commit");
