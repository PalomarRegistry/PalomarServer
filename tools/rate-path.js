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
 * The pepper comes from `TOKEN_PEPPER` in the environment and from nowhere
 * else. A `--pepper` argument would put the deployment's secret into the shell
 * history and into every process listing on the machine for as long as this
 * runs, which is a poor trade for saving one `export`. For the same reason
 * `gh` is spawned with `TOKEN_PEPPER` removed from its environment: it has no
 * use for it, and a subprocess that never receives a secret cannot leak it.
 *
 *   TOKEN_PEPPER=... tools/rate-path.js --login someone
 *   TOKEN_PEPPER=... tools/rate-path.js --id 4242
 */

import { execFileSync } from "node:child_process";

import { digest } from "../src/submission.js";

const USAGE = [
  "usage: TOKEN_PEPPER=... tools/rate-path.js (--login <login> | --id <numeric id>)",
  "",
  "  --login   GitHub login; its numeric id is resolved with `gh api users/<login>`",
  "  --id      numeric GitHub id, when it is already known or `gh` is unavailable",
  "",
  "The pepper is read from TOKEN_PEPPER in the environment. There is deliberately",
  "no argument for it: a shell history and a process listing both outlive the run.",
].join("\n");

function bail(message) {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

const options = {};
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const flag = argv[index];
  if (flag === "--pepper") {
    bail("--pepper is not supported: set TOKEN_PEPPER in the environment instead");
  }
  if (!["--login", "--id"].includes(flag)) bail(`unknown argument ${flag}`);
  const value = argv[index += 1];
  if (value === undefined) bail(`${flag} needs a value`);
  if (options[flag]) bail(`${flag} was given twice`);
  options[flag] = value;
}

const pepper = process.env.TOKEN_PEPPER;
if (!pepper) bail("no pepper: set TOKEN_PEPPER in the environment");
if (options["--login"] && options["--id"]) bail("pass one of --login or --id, not both");

let id = options["--id"];
if (id === undefined) {
  const login = options["--login"];
  if (!login) bail("pass --login or --id");
  if (!/^[A-Za-z0-9_-]{1,39}$/.test(login)) bail(`${login} is not a GitHub login`);
  // `gh` needs a GitHub credential, not this deployment's pepper.
  const environment = { ...process.env };
  delete environment.TOKEN_PEPPER;
  try {
    id = execFileSync("gh", ["api", `users/${login}`, "--jq", ".id"], {
      encoding: "utf8",
      env: environment,
      stdio: ["ignore", "pipe", "inherit"],
    }).trim();
  } catch {
    // `gh` prints its own diagnosis to stderr above.
    bail(`could not resolve the numeric id of ${login}`);
  }
}
// The path digests the id exactly as the Worker interpolated it, so anything
// but a bare canonical decimal would name a file that cannot exist. A value
// past the safe-integer range could not have survived the Worker's own JSON
// round-trip either, so it is a mistake rather than an unusual account.
if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))) {
  bail(`${id} is not a canonical positive safe-integer GitHub id`);
}

console.log(`index/rate/${await digest(`${pepper}:${id}`)}.json`);
