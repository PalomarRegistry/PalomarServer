#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { validateDashboardReport } from "../src/dashboard.js";


async function input() {
  const path = process.argv[2];
  if (path) return readFile(path, "utf8");
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}


try {
  const report = JSON.parse(await input());
  validateDashboardReport(report);
  process.stdout.write(`dashboard schema ${report.schema_version} is compatible\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
