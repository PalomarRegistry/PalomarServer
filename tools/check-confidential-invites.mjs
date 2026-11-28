// Fails when the bundled confidential invite list differs from PalomarPolicy's.
// Usage: node tools/check-confidential-invites.mjs <PalomarPolicy checkout>
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validInvites } from "../src/confidential-intake.js";

const upstream = resolve(process.argv[2] ?? "../PalomarPolicy", "invited-confidential.json");
const local = JSON.parse(readFileSync(new URL("../src/invited-confidential.json", import.meta.url)));
assert.ok(validInvites(local), "src/invited-confidential.json is malformed");
// Until PalomarPolicy publishes the list, nobody is invited.
const policy = existsSync(upstream)
  ? JSON.parse(readFileSync(upstream, "utf8"))
  : { schema_version: 1, github_user_ids: [] };
assert.ok(validInvites(policy), `${upstream} is malformed`);
assert.deepEqual(
  [...local.github_user_ids].sort((a, b) => a - b),
  [...policy.github_user_ids].sort((a, b) => a - b),
  "the confidential invite list drifted from PalomarPolicy",
);
console.log(`confidential invite list matches (${local.github_user_ids.length} ids)`);
