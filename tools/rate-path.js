#!/usr/bin/env node

/**
 * Print the state-repository path of one submitter's rate document.
 *
 * The document is filed under a peppered digest of the submitter's numeric
 * GitHub id and its body names nobody, so there is no way to find a person's
 * file by reading the repository. That is the point. This is the way back in
 * for an operator who holds the pepper and needs to release somebody whose
 * exponential backoff has run away from them: given the login, it says which
 * file to delete.
 *
 * The digest is computed by the Worker's own `digest`, imported rather than
 * reimplemented, so this tool cannot drift from what intake writes.
 *
 * The pepper is read from `TOKEN_PEPPER` by preference. `--pepper` exists for
 * a shell that does not have it exported, at the cost of putting the secret in
 * the process list and the shell history; neither path ever prints it.
 *
 *   TOKEN_PEPPER=... tools/rate-path.js --login someone
 *   TOKEN_PEPPER=... tools/rate-path.js --id 4242
 */

import { execFileSync } from "node:child_process";

import { digest } from "../src/submission.js";

const USAGE = [
  "usage: tools/rate-path.js (--login <login> | --id <numeric id>) [--pepper <pepper>]",
  "",
  "  --login   GitHub login; its numeric id is resolved with `gh api users/<login>`",
  "  --id      numeric GitHub id, when it is already known or `gh` is unavailable",
  "  --pepper  the deployment's TOKEN_PEPPER, if it is not already in the environment",
].join("\n");

function bail(message) {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

const options = {};
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const flag = argv[index];
  if (!["--login", "--id", "--pepper"].includes(flag)) bail(`unknown argument ${flag}`);
  const value = argv[index += 1];
  if (value === undefined) bail(`${flag} needs a value`);
  if (options[flag]) bail(`${flag} was given twice`);
  options[flag] = value;
}

const pepper = options["--pepper"] ?? process.env.TOKEN_PEPPER;
if (!pepper) bail("no pepper: set TOKEN_PEPPER or pass --pepper");
if (options["--login"] && options["--id"]) bail("pass one of --login or --id, not both");

let id = options["--id"];
if (id === undefined) {
  const login = options["--login"];
  if (!login) bail("pass --login or --id");
  if (!/^[A-Za-z0-9_-]{1,39}$/.test(login)) bail(`${login} is not a GitHub login`);
  try {
    id = execFileSync("gh", ["api", `users/${login}`, "--jq", ".id"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }).trim();
  } catch {
    // `gh` prints its own diagnosis to stderr above.
    bail(`could not resolve the numeric id of ${login}`);
  }
}
// The path is a digest of the id exactly as the Worker interpolated it, so a
// value that is not a bare decimal integer would silently name a file that
// cannot exist.
if (!/^[1-9]\d*$/.test(id)) bail(`${id} is not a numeric GitHub id`);

console.log(`index/rate/${await digest(`${pepper}:${id}`)}.json`);
