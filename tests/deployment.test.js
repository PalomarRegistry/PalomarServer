import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mainConfig = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const redirectConfig = await readFile(
  new URL("../redirect/wrangler.jsonc", import.meta.url),
  "utf8",
);

test("both Workers disable alternate Cloudflare hostnames", () => {
  for (const config of [mainConfig, redirectConfig]) {
    assert.equal(config.match(/"workers_dev"\s*:\s*false/g)?.length, 1);
    assert.equal(config.match(/"preview_urls"\s*:\s*false/g)?.length, 1);
    assert.doesNotMatch(config, /"(?:workers_dev|preview_urls)"\s*:\s*true/);
  }
});

test("the only configured routes are the three reviewed hostnames", () => {
  assert.equal(mainConfig.match(/"pattern"\s*:/g)?.length, 1);
  assert.match(mainConfig, /"pattern"\s*:\s*"submit\.palomar-registry\.org\/\*"/);
  assert.equal(redirectConfig.match(/"pattern"\s*:/g)?.length, 2);
  assert.match(redirectConfig, /"pattern"\s*:\s*"palomarregistry\.org"/);
  assert.match(redirectConfig, /"pattern"\s*:\s*"www\.palomarregistry\.org"/);
});

test("deployment applies the hostname policy before uploading a version", async () => {
  const workflow = await readFile(new URL("../.github/workflows/test.yml", import.meta.url), "utf8");
  const applyAt = workflow.indexOf("/workers/scripts/palomar-server/subdomain");
  const uploadAt = workflow.indexOf("run: npx wrangler versions upload");
  const promoteAt = workflow.indexOf("run: npx wrangler versions deploy");
  assert.ok(applyAt >= 0);
  assert.ok(uploadAt > applyAt);
  assert.ok(promoteAt > uploadAt);
  assert.equal(workflow.match(/\/workers\/scripts\/palomar-server\/subdomain/g)?.length, 1);
  assert.equal(workflow.match(/enabled: false, previews_enabled: false/g)?.length, 1);
  assert.doesNotMatch(workflow, /wrangler triggers deploy/);
});
