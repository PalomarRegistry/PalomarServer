#!/usr/bin/env node
// Retroactive companion to the withdrawal scrub. Records withdrawn before the
// scrub shipped still carry what identified the person who sent them; this
// applies the same emptying to those, and to nothing else.
//
//   node tools/scrub-withdrawn-records.js <state-checkout> [--write]
//
// Without --write it reports. The scrub event it appends carries the record's
// own status, which is what the State validator requires of a last event.
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { WITHDRAWAL_SCRUB_NOTE } from "../src/submission.js";

const [root, ...rest] = process.argv.slice(2);
const write = rest.includes("--write");
if (!root || rest.some((flag) => flag !== "--write")) {
  console.error("usage: scrub-withdrawn-records.js <state-checkout> [--write]");
  process.exit(2);
}

const submissions = join(root, "submissions");
if (!existsSync(submissions)) {
  console.error(`error: ${submissions} does not exist`);
  process.exit(2);
}

const at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
let scrubbed = 0;
let clean = 0;

for (const id of readdirSync(submissions).sort()) {
  const path = join(submissions, id, "state.json");
  if (!existsSync(path)) continue;
  const record = JSON.parse(readFileSync(path, "utf8"));
  if (record.status !== "withdrawn") continue;

  const carries =
    record.submitter !== null ||
    record.context !== null ||
    record.authorization?.evidence !== undefined ||
    record.push_proof?.principal?.login !== undefined;
  if (!carries) {
    clean += 1;
    continue;
  }

  console.log(`carries identifying details in submissions/${id}/state.json`);
  if (!write) {
    scrubbed += 1;
    continue;
  }

  record.submitter = null;
  record.context = null;
  if (record.authorization) delete record.authorization.evidence;
  if (record.push_proof?.principal) delete record.push_proof.principal.login;
  record.events = [
    ...record.events,
    { at, status: record.status, note: WITHDRAWAL_SCRUB_NOTE },
  ];
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
  scrubbed += 1;
}

console.log(
  write
    ? `${scrubbed} withdrawn records scrubbed, ${clean} already clean`
    : `${scrubbed} withdrawn records to scrub, ${clean} already clean`,
);
if (!write && scrubbed > 0) console.log("re-run with --write, then commit");
