#!/usr/bin/env node

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { CLOSED } from "../public/statuses.js";
import { RATE_RESET_INDEX_PATH, rateResetQueue } from "../src/rate-reset.js";

/** Seed the durable queue for submissions admitted before it existed. */
export async function rebuildRateResetQueue({ root, write = false }) {
  const queuePath = path.join(root, RATE_RESET_INDEX_PATH);
  let existing = null;
  try {
    existing = JSON.parse(await readFile(queuePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const open = new Set(rateResetQueue(existing));
  const before = open.size;
  const directories = await readdir(path.join(root, "submissions"), { withFileTypes: true });
  const candidates = [];
  for (const entry of directories.filter(entry => entry.isDirectory())) {
    const record = JSON.parse(await readFile(path.join(root, "submissions", entry.name, "state.json"), "utf8"));
    if (record.id !== entry.name || !/^[0-9a-z]{12}$/.test(record.id)) {
      throw new Error(`${entry.name}: submission id does not match its directory`);
    }
    const principal = record.push_proof?.principal?.id;
    if (!Number.isSafeInteger(principal) || principal <= 0 || record.rate_reset_at ||
        record.push_proof?.technical_maintainer === true ||
        ["technical-team-test", "technical-team-correction"].includes(record.push_proof?.method)) continue;
    if (!CLOSED.has(record.status) || ["registered", "changes-required"].includes(record.status)) {
      candidates.push(record);
    }
  }
  // Clear completed work first, newest first, before spending the recovery
  // pass's bounded budget on submissions still waiting for the reviewer.
  const resettable = record => ["registered", "changes-required"].includes(record.status);
  const completedAt = record => record.events?.findLast(event => event.status === record.status)?.at ?? record.created_at ?? "";
  candidates.sort((a, b) => Number(resettable(b)) - Number(resettable(a)) ||
    completedAt(b).localeCompare(completedAt(a)) || a.id.localeCompare(b.id));
  for (const record of candidates) open.add(record.id);
  if (write) {
    await mkdir(path.dirname(queuePath), { recursive: true });
    await writeFile(queuePath, `${JSON.stringify({ schema_version: 1, open: [...open] }, null, 2)}\n`);
  }
  return { mode: write ? "write" : "dry-run", before, added: open.size - before, queued: open.size };
}

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const positional = args.filter(argument => argument !== "--write");
  if (positional.length !== 1 || args.some(argument => argument.startsWith("--") && argument !== "--write")) {
    throw new Error("usage: tools/rebuild-rate-reset-queue.js [--write] <PalomarSubmissionState checkout>");
  }
  console.log(JSON.stringify(await rebuildRateResetQueue({ root: path.resolve(positional[0]), write }), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
