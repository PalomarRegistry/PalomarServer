#!/usr/bin/env node

import { execFileSync } from "node:child_process";

import { validateDashboardReport } from "../src/dashboard.js";


const base = process.argv[2];
if (!base) {
  process.stderr.write("usage: check-dashboard-backward-compatibility.js BASE_COMMIT\n");
  process.exit(2);
}

const fixtures = execFileSync(
  "git",
  ["ls-tree", "-r", "--name-only", base, "tests/fixtures"],
  { encoding: "utf8" },
).trim().split("\n").filter((path) => /state-dashboard(?:-v\d+)?\.json$/.test(path));

if (!fixtures.length) {
  process.stderr.write(`no dashboard contract fixtures found at ${base}\n`);
  process.exit(1);
}

for (const path of fixtures) {
  const text = execFileSync("git", ["show", `${base}:${path}`], { encoding: "utf8" });
  const report = JSON.parse(text);
  try {
    validateDashboardReport(report);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`current consumer broke ${path} from ${base}: ${detail}`);
  }
  process.stdout.write(`preserved dashboard schema ${report.schema_version} from ${path}\n`);
}
