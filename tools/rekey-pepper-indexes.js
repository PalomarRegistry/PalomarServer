#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { CLOSED } from "../public/statuses.js";

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function json(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function ordinaryJsonFiles(directory) {
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
}

/** Rebuild pepper-derived indexes in a checked-out Submission State repository. */
export async function rekeyPepperIndexes({ root, pepper, write = false }) {
  if (!pepper) throw new Error("TOKEN_PEPPER is required");
  const submissionsRoot = path.join(root, "submissions");
  const principalRoot = path.join(root, "index", "principals");
  const rateRoot = path.join(root, "index", "rate");
  const submissionDirectories = (await readdir(submissionsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const principals = new Map();
  let records = 0;
  let recoverable = 0;

  for (const identifier of submissionDirectories) {
    const record = await json(path.join(submissionsRoot, identifier, "state.json"));
    if (record.id !== identifier) throw new Error(`${identifier}: state id does not match its directory`);
    records += 1;
    const principal = record.push_proof?.principal?.id;
    const canonical = Number.isSafeInteger(principal) && principal > 0;
    if (!CLOSED.has(record.status) && !canonical) {
      throw new Error(`${identifier}: nonclosed submission has no numeric GitHub principal`);
    }
    if (!canonical) continue;
    recoverable += 1;
    const name = digest(`${pepper}:${principal}`);
    const identifiers = principals.get(name) ?? [];
    identifiers.push(identifier);
    principals.set(name, identifiers);
  }

  const oldPrincipals = await ordinaryJsonFiles(principalRoot);
  const oldRates = await ordinaryJsonFiles(rateRoot);
  if (write) {
    for (const name of oldPrincipals) await rm(path.join(principalRoot, name));
    for (const name of oldRates) await rm(path.join(rateRoot, name));
    await mkdir(principalRoot, { recursive: true });
    for (const [name, submissions] of [...principals].sort(([a], [b]) => a.localeCompare(b))) {
      const value = `${JSON.stringify({ schema_version: 1, submissions }, null, 2)}\n`;
      await writeFile(path.join(principalRoot, `${name}.json`), value, { flag: "wx", mode: 0o600 });
    }
  }
  return {
    mode: write ? "write" : "dry-run",
    records,
    recoverable_records: recoverable,
    principal_documents_before: oldPrincipals.length,
    principal_documents_after: principals.size,
    rate_documents_removed: oldRates.length,
    token_documents_preserved: (await ordinaryJsonFiles(path.join(root, "index", "tokens"))).length,
  };
}

function usage() {
  return "usage: TOKEN_PEPPER=... tools/rekey-pepper-indexes.js [--write] <PalomarSubmissionState checkout>";
}

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const positional = args.filter((argument) => argument !== "--write");
  if (positional.length !== 1 || args.some((argument) => argument.startsWith("--") && argument !== "--write")) {
    throw new Error(usage());
  }
  const report = await rekeyPepperIndexes({
    root: path.resolve(positional[0]),
    pepper: process.env.TOKEN_PEPPER,
    write,
  });
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
