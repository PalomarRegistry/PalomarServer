import assert from "node:assert/strict";
import test from "node:test";
import { withInstallationTokens } from "../src/github-app.js";
import { readState } from "../src/github.js";

async function pkcs8() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign"],
  );
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  return `-----BEGIN PRIVATE KEY-----\n${der}\n-----END PRIVATE KEY-----\n`;
}

async function withFetch(handler, body) {
  const previous = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await body();
  } finally {
    globalThis.fetch = previous;
  }
}

test("each role's token comes from its own App installation, once per expiry", async () => {
  const env = {
    STATE_REPO: "PalomarRegistry/PalomarSubmissionState",
    SUBMISSION_REPO: "PalomarRegistry/PalomarSubmission",
    STATE_APP_ID: "11",
    STATE_APP_PRIVATE_KEY: await pkcs8(),
    SUBMISSION_APP_ID: "12",
    SUBMISSION_APP_PRIVATE_KEY: await pkcs8(),
  };
  const calls = [];
  const resolved = await withFetch(async (url, init) => {
    calls.push(String(url));
    assert.match(new Headers(init.headers).get("authorization"), /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const installation = String(url).match(/\/repos\/PalomarRegistry\/(\w+)\/installation$/);
    if (installation) return Response.json({ id: installation[1] === "PalomarSubmission" ? 2 : 1 });
    const minted = String(url).match(/\/app\/installations\/(\d)\/access_tokens$/);
    assert.equal(init.method, "POST");
    return Response.json({
      token: `ghs_installation-${minted[1]}`,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
  }, async () => {
    const first = await withInstallationTokens(env);
    const second = await withInstallationTokens(env);
    assert.deepEqual(second, first);
    return first;
  });
  assert.equal(resolved.GITHUB_TOKEN, "ghs_installation-1");
  assert.equal(resolved.SUBMISSION_TOKEN, "ghs_installation-2");
  assert.equal(calls.length, 4);
});

test("a deployment without an App key keeps its static token", async () => {
  const env = { GITHUB_TOKEN: "state-token", SUBMISSION_TOKEN: "dispatch-token" };
  const resolved = await withFetch(() => assert.fail("no GitHub call expected"), () => withInstallationTokens(env));
  assert.equal(resolved.GITHUB_TOKEN, "state-token");
  assert.equal(resolved.SUBMISSION_TOKEN, "dispatch-token");
});

test("a State reread GitHub answers 304 returns the cached document", async () => {
  const env = { GITHUB_TOKEN: "t", STATE_REPO: "example/conditional" };
  const content = Buffer.from(JSON.stringify({ open: ["a"] })).toString("base64");
  const seen = [];
  await withFetch(async (url, init) => {
    const match = new Headers(init.headers).get("if-none-match");
    seen.push(match);
    if (match === '"v1"') return new Response(null, { status: 304 });
    return Response.json({ type: "file", encoding: "base64", content, sha: "s1" }, { headers: { etag: '"v1"' } });
  }, async () => {
    const first = await readState(env, "index/inflight.json");
    first.value.open.push("mutated by the caller");
    const second = await readState(env, "index/inflight.json");
    assert.deepEqual(second, { value: { open: ["a"] }, sha: "s1" });
  });
  assert.deepEqual(seen, [null, '"v1"']);
});

test("an App key without its App ID does not count as configured", async () => {
  const { default: worker } = await import("../src/index.js");
  const env = {
    TOKEN_PEPPER: "p", OAUTH_CLIENT_ID: "c", OAUTH_CLIENT_SECRET: "s", SUBMISSION_TOKEN: "d",
    STATE_APP_PRIVATE_KEY: "key", INTAKE_LIMITER: { limit: async () => ({ success: true }) },
  };
  const response = await worker.fetch(new Request("https://submit.example/healthz"), env);
  assert.equal(response.status, 503);
  const configured = await worker.fetch(new Request("https://submit.example/healthz"), { ...env, STATE_APP_ID: "11" });
  assert.equal(configured.status, 200);
});
