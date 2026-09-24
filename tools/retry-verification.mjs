#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { GitHubError } from "../src/github.js";
import { authenticatedOperator, retryVerification } from "../src/operator-retry.js";

const { values } = parseArgs({ options: {
  id: { type: "string" }, reason: { type: "string" },
  profile: { type: "string", default: "palomar-namespace-16x32-v1" },
  apply: { type: "boolean", default: false },
} });
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
try {
  const { principal, at } = authenticatedOperator(gh("api", "--include", "user"));
  const token = gh("auth", "token");
  const result = await retryVerification({ GITHUB_TOKEN: token, STATE_REPO: "PalomarRegistry/PalomarSubmissionState" },
    values.id, { principal, reason: values.reason, profile: values.profile,
      attempt: randomBytes(16).toString("hex"), at },
    { apply: values.apply });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  // Child-process errors can contain credentials or private API data.
  console.error(error instanceof GitHubError ? error.message
    : error.status !== undefined ? "Authenticated GitHub command failed" : error.message);
  process.exitCode = 1;
}
