/**
 * Confidential submissions through the Worker, from sign-in to withdrawal
 * (contract v3.1, C2 and C5 to C8). GitHub is stubbed at the fetch boundary
 * and R2 is in memory.
 */

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import worker, { DAILY_CRON } from "../src/index.js";
import { digest, statePath } from "../src/submission.js";
import { publicSubmissionId } from "../src/confidential.js";
import { readLifecycle } from "../src/confidential-store.js";
import { signingKey, verifyCertificate } from "../src/certificates.js";
import { fakeR2 } from "./fake-r2.js";
import { githubTarball, githubTree, PLAIN_PROJECT } from "./tarball.js";

const RUNS = "PalomarRegistry/PalomarConfidentialRuns";
const STATE = "PalomarRegistry/PalomarSubmissionState";
const REPOSITORY = "owner/project";
const COMMIT = "c".repeat(40);
const SOURCE_TOKEN = "ghs_SOURCEAPPTOKENNEVERSHOWN0123456789";
const MAINTAINER = { id: 477956, login: "kim-em" };
const CERT_KEY = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
const APP_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" });

function environment() {
  return {
    SITE_URL: "https://palomar-registry.org",
    STATE_REPO: STATE,
    SUBMISSION_REPO: "PalomarRegistry/PalomarSubmission",
    VERIFY_WORKFLOW: "submission.yml",
    REVIEW_WORKFLOW: "reviewer.yml",
    CONFIDENTIAL_RUNS_REPO: RUNS,
    CONFIDENTIAL_VERIFY_WORKFLOW: "verify.yml",
    CONFIDENTIAL_INTAKE: "test",
    CONFIDENTIAL_SOURCE: fakeR2(),
    CONFIDENTIAL_R2_ACCOUNT_ID: "account",
    CONFIDENTIAL_R2_ACCESS_KEY_ID: "r2-read-key",
    CONFIDENTIAL_R2_SECRET_ACCESS_KEY: "r2-read-secret",
    CERTIFICATE_SIGNING_KEY: CERT_KEY,
    SOURCE_APP_ID: "5960814",
    SOURCE_APP_PRIVATE_KEY: APP_KEY,
    GITHUB_TOKEN: "state-token",
    SUBMISSION_TOKEN: "dispatch-token",
    TOKEN_PEPPER: "test-pepper",
    OAUTH_CLIENT_ID: "client-id",
    OAUTH_CLIENT_SECRET: "client-secret",
    INTAKE_LIMITER: { limit: async () => ({ success: true }) },
  };
}

function encode(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf-8").toString("base64");
}

/**
 * GitHub: State in memory, one repository that is private until `repo.private`
 * is changed, the Source App, and a record of everything else.
 */
function stubGitHub({ files = {}, repo = { id: 77, private: true, owner: { login: "owner", id: 5 },
  default_branch: "main" }, permission = "admin", user = MAINTAINER, installed = true } = {}) {
  const store = new Map(Object.entries(files));
  const dispatches = [];
  const bodies = [];
  let staged = [];
  let shaCounter = 0;
  const shas = new Map();
  const shaOf = (name) => {
    if (!shas.has(name)) shas.set(name, `sha-${name}-${shaCounter}`);
    return shas.get(name);
  };
  const bump = (name) => { shaCounter += 1; shas.set(name, `sha-${name}-${shaCounter}`); };
  const tarball = githubTarball(PLAIN_PROJECT);
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(url);
    const method = init.method ?? "GET";
    const path = target.pathname;
    const auth = new Headers(init.headers).get("authorization");
    if (init.body && typeof init.body === "string") bodies.push(init.body);
    const state = `/repos/${STATE}`;
    if (target.hostname === "github.com" && path.endsWith("/access_token")) {
      return Response.json({ access_token: "oauth-token" });
    }
    if (path === "/user") return Response.json(user);
    if (path === `${state}/git/ref/heads/main`) return Response.json({ object: { type: "commit", sha: "a".repeat(40) } });
    if (path === `${state}/git/commits/${"a".repeat(40)}`) return Response.json({ tree: { sha: "b".repeat(40) } });
    if (path === `${state}/git/trees` && method === "POST") {
      staged = JSON.parse(init.body).tree;
      return Response.json({ sha: "c".repeat(40) });
    }
    if (path === `${state}/git/commits` && method === "POST") return Response.json({ sha: "d".repeat(40) });
    if (path === `${state}/git/refs/heads/main` && method === "PATCH") {
      for (const change of staged) {
        if (change.sha === null) store.delete(change.path);
        else store.set(change.path, JSON.parse(change.content));
        bump(change.path);
      }
      return Response.json({ object: { sha: "d".repeat(40) } });
    }
    if (path.startsWith(`${state}/contents/`)) {
      const name = decodeURI(path.slice(`${state}/contents/`.length));
      if (method === "GET") {
        if (name === "pending") return Response.json([]);
        if (!store.has(name)) return new Response("", { status: 404 });
        return Response.json({ content: encode(store.get(name)), sha: shaOf(name) });
      }
      if (method === "DELETE") {
        store.delete(name);
        return Response.json({});
      }
      const body = JSON.parse(init.body);
      store.set(name, JSON.parse(Buffer.from(body.content, "base64").toString("utf-8")));
      bump(name);
      return Response.json({ content: { sha: shaOf(name) } });
    }
    const dispatch = /^\/repos\/(.+)\/actions\/workflows\/([^/]+)\/dispatches$/.exec(path);
    if (dispatch && method === "POST") {
      dispatches.push({ repository: dispatch[1], workflow: dispatch[2], body: JSON.parse(init.body) });
      return new Response(null, { status: 204 });
    }
    if (path === `/repos/${REPOSITORY}/installation`) {
      return installed ? Response.json({ id: 9 }) : new Response("", { status: 404 });
    }
    if (path === "/app/installations/9/access_tokens" && method === "POST") {
      return Response.json({ token: SOURCE_TOKEN, expires_at: "2099-01-01T00:00:00Z" });
    }
    if (path === `/repos/${REPOSITORY}`) {
      if (repo.private && auth !== `Bearer ${SOURCE_TOKEN}`) return new Response("", { status: 404 });
      return Response.json(repo);
    }
    if (path === `/repos/${REPOSITORY}/collaborators/${user.login}/permission`) {
      assert.equal(auth, `Bearer ${SOURCE_TOKEN}`);
      return Response.json({ permission, user: { id: user.id, login: user.login } });
    }
    if (path === `/repos/${REPOSITORY}/git/trees/${COMMIT}`) return Response.json(githubTree(PLAIN_PROJECT));
    if (path === `/repos/${REPOSITORY}/tarball/${COMMIT}`) return new Response(tarball);
    if (path === `/repos/${REPOSITORY}/compare/main...${COMMIT}`) return Response.json({ status: "behind" });
    if (path === `/repos/${REPOSITORY}/commits/${COMMIT}`) return Response.json({ sha: COMMIT });
    if (/\/actions\/workflows\/[^/]+\/runs$/.test(path)) return Response.json({ workflow_runs: [] });
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { store, dispatches, bodies, repo };
}

const BINDING = "9".repeat(64);
const NONCE = "8".repeat(64);

async function pendingFiles() {
  return {
    "index/inflight.json": { open: [] },
    "index/open.json": { schema_version: 1, open: [] },
    [`pending/${await digest(NONCE)}.json`]: {
      schema_version: 2,
      binding_sha256: await digest(BINDING),
      method: "oauth",
      challenge: "7".repeat(64),
      repository_id: null,
      attempts: 0,
      repository: REPOSITORY,
      commit: COMMIT,
      existing_id: null,
      context: null,
      requested_paths: { project_path: null, comparator_config_path: "comparator.json",
        formalization_metadata_path: null },
      authorization_relationship: "maintainer",
      authorization_evidence: null,
      visibility: "confidential",
      created_at: new Date().toISOString(),
    },
  };
}

async function signIn(env) {
  const name = `__Host-palomar_intake_${(await digest(NONCE)).slice(0, 16)}`;
  return worker.fetch(new Request(
    `https://submit.palomar-registry.org/oauth/callback?code=c&state=${NONCE}`,
    { headers: { cookie: `${name}=${BINDING}` } },
  ), env);
}

function bearer(env, token, path, init = {}) {
  return worker.fetch(new Request(`https://submit.palomar-registry.org${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  }), env);
}

/** Sign in and admit a private repository; returns the id and access token. */
async function admitted(env, options = {}) {
  const stub = stubGitHub({ files: await pendingFiles(), ...options });
  const response = await signIn(env);
  assert.equal(response.status, 303, await response.clone().text());
  const token = new URL(response.headers.get("location")).hash.slice(1);
  const [, record] = [...stub.store.entries()].find(([key]) => key.endsWith("/state.json"));
  return { ...stub, response, token, id: record.id };
}

/** Make the State record say what the reviewer writes when a review passes. */
function passReview(store, id) {
  const path = statePath(id, "state.json");
  store.set(path, { ...store.get(path), status: "review-ready", review_sha256: "e".repeat(64) });
  store.set(statePath(id, "review.json"), {
    schema_version: 3, submission_id: id, outcome: "neutral", summary: "", warnings: [],
    requested_changes: [], reviewed_at: "2026-11-28T00:00:00Z", reviewer_models: [],
  });
}

function captureLogs() {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const name of Object.keys(saved)) console[name] = (...args) => lines.push(args.map(String).join(" "));
  return { lines, restore: () => Object.assign(console, saved) };
}

test("a private repository is read once at admission and runs from a presigned tarball", async () => {
  const env = environment();
  const logs = captureLogs();
  let flow;
  try {
    flow = await admitted(env);
  } finally {
    logs.restore();
  }
  const { store, dispatches, bodies, id, response } = flow;
  const record = store.get(statePath(id, "state.json"));
  assert.equal(record.visibility, "confidential");
  const lifecycle = (await readLifecycle(env, id)).value;
  assert.equal(lifecycle.state, "reviewing");
  assert.deepEqual(record.confidential, { source_sha256: lifecycle.source_sha256 });
  assert.equal(record.push_proof.repository_id, 77);

  assert.equal(dispatches.length, 1);
  const [{ repository, workflow, body }] = dispatches;
  assert.equal(repository, RUNS);
  assert.equal(workflow, "verify.yml");
  assert.equal(body.inputs.source_sha256, lifecycle.source_sha256);
  assert.match(body.inputs.source_url,
    new RegExp(`^https://account\\.r2\\.cloudflarestorage\\.com/palomar-confidential-source/conf/${id}/source\\.tar\\.gz\\?.*X-Amz-Expires=3600&`));
  assert.match(body.inputs.tombstone_url, new RegExp(`/conf-tombstones/${id}\\?.*X-Amz-Expires=86400&`));

  // The token reached no response, log line, request body, State file or R2 object.
  const everything = [
    await response.text(), response.headers.get("location"), ...logs.lines, ...bodies,
    JSON.stringify([...store.values()]),
    ...[...env.CONFIDENTIAL_SOURCE.objects.values()].map(({ bytes }) => Buffer.from(bytes).toString("latin1")),
  ];
  for (const text of everything) assert.ok(!String(text).includes(SOURCE_TOKEN));
  // Nor does the R2 secret, which only signs.
  assert.ok(!JSON.stringify(dispatches).includes("r2-read-secret"));
});

test("an author without write access to the private repository is refused before admission", async () => {
  const env = environment();
  const stub = stubGitHub({ files: await pendingFiles(), permission: "read" });
  const response = await signIn(env);
  assert.equal(response.status, 403);
  assert.ok(![...stub.store.keys()].some((key) => key.endsWith("/state.json")));
  assert.equal(env.CONFIDENTIAL_SOURCE.objects.size, 0);
});

test("an uninvited author never causes a Source App call", async () => {
  const env = environment();
  const stub = stubGitHub({ files: await pendingFiles(), user: { id: 4242, login: "someone" } });
  let appCalls = 0;
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (/installation|access_tokens/.test(String(url))) appCalls += 1;
    return inner(url, init);
  };
  const response = await signIn(env);
  assert.equal(response.status, 403);
  assert.match(await response.text(), /open only to invited authors/);
  assert.equal(appCalls, 0);
  assert.equal(env.CONFIDENTIAL_SOURCE.objects.size, 0);
  assert.ok(![...stub.store.keys()].some((key) => key.endsWith("/state.json")));
});

test("a passed review holds the submission once, with one verifiable certificate pair", async () => {
  const env = environment();
  const { store, token, id } = await admitted(env);
  passReview(store, id);
  // Two polls at once: one compare-and-set wins, and there is still one pair.
  const [first, second] = await Promise.all([
    bearer(env, token, "/api/submission"), bearer(env, token, "/api/submission"),
  ]);
  for (const response of [first, second]) {
    assert.equal((await response.json()).confidential.state, "held");
  }
  const lifecycle = (await readLifecycle(env, id)).value;
  assert.equal(lifecycle.state, "held");
  assert.equal(lifecycle.review_sha256, "e".repeat(64));
  const pair = await (await bearer(env, token, "/api/certificates")).json();
  const again = await (await bearer(env, token, "/api/certificates")).json();
  assert.deepEqual(again, pair);
  const { publicKey } = await signingKey(CERT_KEY);
  assert.equal(await verifyCertificate(pair.full, publicKey), true);
  assert.equal(await verifyCertificate(pair.anonymous, publicKey), true);
  const full = JSON.parse(pair.full.payload);
  const anonymous = JSON.parse(pair.anonymous.payload);
  assert.equal(full.palomar_id, id);
  assert.equal(full.source_sha256, lifecycle.source_sha256);
  assert.equal(anonymous.certificate_id, lifecycle.anonymous_id);
  for (const presented of [id, anonymous.certificate_id]) {
    const status = await worker.fetch(new Request(`https://submit.palomar-registry.org/api/cert/${presented}`), env);
    assert.deepEqual(await status.json(), { status: "valid" });
    assert.equal(status.headers.get("cache-control"), "no-store");
  }
});

test("a review that has not passed does not hold, and certificates wait", async () => {
  const env = environment();
  const { store, token, id } = await admitted(env);
  passReview(store, id);
  store.set(statePath(id, "review.json"), { ...store.get(statePath(id, "review.json")), outcome: "revision_required" });
  assert.equal((await (await bearer(env, token, "/api/submission")).json()).confidential.state, "reviewing");
  assert.equal((await bearer(env, token, "/api/certificates")).status, 409);
  const status = await worker.fetch(new Request(`https://submit.palomar-registry.org/api/cert/${id}`), env);
  assert.deepEqual(await status.json(), { status: "withdrawn" });
});

test("withdraw writes the tombstone first, then C5, then State, then dispatches cleanup", async () => {
  const env = environment();
  const { store, dispatches, token, id } = await admitted(env);
  passReview(store, id);
  await bearer(env, token, "/api/submission");
  const anonymousId = (await readLifecycle(env, id)).value.anonymous_id;
  env.CONFIDENTIAL_SOURCE.log.length = 0;
  dispatches.length = 0;
  const response = await bearer(env, token, "/withdraw", {
    method: "POST", headers: { "sec-fetch-site": "same-origin" },
  });
  assert.equal(response.status, 200);
  const writes = env.CONFIDENTIAL_SOURCE.log.filter((line) => /^(put|delete) /.test(line));
  assert.deepEqual(writes, [
    `put conf-tombstones/${id}`, `delete conf-anon/${anonymousId}`, `put conf/${id}/lifecycle.json`,
  ]);
  const tombstone = JSON.parse(Buffer.from(env.CONFIDENTIAL_SOURCE.objects.get(`conf-tombstones/${id}`).bytes));
  assert.deepEqual(Object.keys(tombstone).sort(), ["cleanup", "id", "schema", "withdrawn_at"]);
  assert.equal(tombstone.cleanup, "pending");
  assert.equal((await readLifecycle(env, id)).value.state, "withdrawn");
  assert.equal(store.get(statePath(id, "state.json")).status, "withdrawn");
  assert.deepEqual(dispatches, [{
    repository: STATE, workflow: "confidential-cleanup.yml",
    body: { ref: "main", inputs: { submission: id } },
  }]);
  for (const presented of [id, anonymousId]) {
    const status = await worker.fetch(new Request(`https://submit.palomar-registry.org/api/cert/${presented}`), env);
    assert.deepEqual(await status.json(), { status: "withdrawn" });
  }
  // Pressing again is safe and dispatches again.
  assert.equal((await bearer(env, token, "/withdraw", {
    method: "POST", headers: { "sec-fetch-site": "same-origin" },
  })).status, 200);
});

test("the daily pass finishes a withdrawal whose Worker died after the tombstone", async () => {
  const env = environment();
  const { store, dispatches, token, id } = await admitted(env);
  passReview(store, id);
  await bearer(env, token, "/api/submission");
  const anonymousId = (await readLifecycle(env, id)).value.anonymous_id;
  // Only the tombstone was written.
  await env.CONFIDENTIAL_SOURCE.put(`conf-tombstones/${id}`, JSON.stringify({
    schema: "palomar-confidential-tombstone/1", id, withdrawn_at: "2026-11-28T00:00:00Z", cleanup: "pending",
  }));
  // And one finished long ago, which must not be dispatched again.
  await env.CONFIDENTIAL_SOURCE.put("conf-tombstones/zzzzzzzzzzzz", JSON.stringify({
    schema: "palomar-confidential-tombstone/1", id: "zzzzzzzzzzzz", withdrawn_at: "2026-11-01T00:00:00Z",
    cleanup: "done", cleaned_at: "2026-11-01T01:00:00Z",
  }));
  dispatches.length = 0;
  await worker.scheduled({ cron: DAILY_CRON }, env);
  assert.equal((await readLifecycle(env, id)).value.state, "withdrawn");
  assert.equal(env.CONFIDENTIAL_SOURCE.objects.has(`conf-anon/${anonymousId}`), false);
  assert.deepEqual(dispatches, [{ repository: STATE, workflow: "confidential-cleanup.yml", body: { ref: "main" } }]);

  // Once the job marks it done, the daily pass dispatches nothing.
  await env.CONFIDENTIAL_SOURCE.put(`conf-tombstones/${id}`, JSON.stringify({
    schema: "palomar-confidential-tombstone/1", id, withdrawn_at: "2026-11-28T00:00:00Z",
    cleanup: "done", cleaned_at: "2026-11-28T01:00:00Z",
  }));
  dispatches.length = 0;
  await worker.scheduled({ cron: DAILY_CRON }, env);
  assert.deepEqual(dispatches, []);
});

test("the daily pass holds a passed review nobody polled for", async () => {
  const env = environment();
  const { store, id } = await admitted(env);
  passReview(store, id);
  await worker.scheduled({ cron: DAILY_CRON }, env);
  assert.equal((await readLifecycle(env, id)).value.state, "held");
});

async function held(env) {
  const flow = await admitted(env);
  passReview(flow.store, flow.id);
  await bearer(env, flow.token, "/api/submission");
  return flow;
}

const submitPublicly = (env, token) => bearer(env, token, "/api/submit-publicly", {
  method: "POST", headers: { "sec-fetch-site": "same-origin" },
});

test("submit publicly makes one ordinary public submission and never touches C5", async () => {
  const env = environment();
  const { store, repo, token, id, dispatches } = await held(env);
  // Still private: refused.
  assert.match((await (await submitPublicly(env, token)).json()).error, /Make the repository public first/);
  repo.private = false;
  const before = (await readLifecycle(env, id)).etag;
  dispatches.length = 0;
  const first = await submitPublicly(env, token);
  assert.equal(first.status, 200, await first.clone().text());
  const answer = await first.json();
  assert.equal(answer.id, await publicSubmissionId(env, id));
  assert.match(answer.status_url, /\/s#[0-9a-f]{64}$/);
  const publicRecord = store.get(statePath(answer.id, "state.json"));
  assert.equal(publicRecord.visibility, undefined);
  assert.equal(publicRecord.confidential, undefined);
  assert.equal(publicRecord.commit, COMMIT);
  assert.doesNotMatch(JSON.stringify(publicRecord), new RegExp(id));
  // It runs in public, like any other submission.
  assert.deepEqual(dispatches.map((item) => item.repository), ["PalomarRegistry/PalomarSubmission"]);
  assert.equal(dispatches[0].body.inputs.source_url, undefined);
  // A second press finds the same submission.
  const second = await (await submitPublicly(env, token)).json();
  assert.equal(second.id, answer.id);
  assert.equal([...store.keys()].filter((key) => key === statePath(answer.id, "state.json")).length, 1);
  assert.equal((await readLifecycle(env, id)).etag, before);
});

test("submit publicly needs an administrator now, through the Source App", async () => {
  const env = environment();
  const flow = await held(env);
  flow.repo.private = false;
  stubGitHub({ files: Object.fromEntries(flow.store), repo: flow.repo, permission: "write" });
  assert.match((await (await submitPublicly(env, flow.token)).json()).error, /Only an administrator/);
  stubGitHub({ files: Object.fromEntries(flow.store), repo: flow.repo, installed: false });
  assert.match((await (await submitPublicly(env, flow.token)).json()).error, /keep it installed/);
});

test("withdraw and submit publicly racing leave a consistent outcome either way", async () => {
  for (const order of ["withdraw-first", "together", "publish-first"]) {
    const env = environment();
    const { store, repo, token, id } = await held(env);
    repo.private = false;
    const withdraw = () => bearer(env, token, "/withdraw", {
      method: "POST", headers: { "sec-fetch-site": "same-origin" },
    });
    let publish;
    if (order === "withdraw-first") {
      await withdraw();
      publish = await submitPublicly(env, token);
    } else if (order === "together") {
      [publish] = await Promise.all([submitPublicly(env, token), withdraw()]);
    } else {
      publish = await submitPublicly(env, token);
      await withdraw();
    }
    // The confidential side always ends withdrawn with its tombstone.
    assert.equal((await readLifecycle(env, id)).value.state, "withdrawn", order);
    assert.ok(env.CONFIDENTIAL_SOURCE.objects.has(`conf-tombstones/${id}`), order);
    const publicId = await publicSubmissionId(env, id);
    const publicRecords = [...store.keys()].filter((key) => key === statePath(publicId, "state.json"));
    assert.ok(publicRecords.length <= 1, order);
    if (order === "withdraw-first") {
      assert.ok([404, 409].includes(publish.status), `${order}: ${publish.status}`);
      assert.equal(publicRecords.length, 0, order);
    }
    if (order === "publish-first") {
      assert.equal(publish.status, 200, order);
      // Deleting the private material does not touch the public submission.
      assert.equal(store.get(statePath(publicId, "state.json")).status, "verifying", order);
    }
  }
});

test("confidential intake stays off when R2 or its read token is missing", async () => {
  const { confidentialIntakeOpen } = await import("../src/confidential-intake.js");
  assert.equal(confidentialIntakeOpen(environment()), true);
  for (const name of ["CONFIDENTIAL_SOURCE", "CONFIDENTIAL_R2_ACCESS_KEY_ID", "CONFIDENTIAL_R2_SECRET_ACCESS_KEY"]) {
    const env = environment();
    delete env[name];
    assert.equal(confidentialIntakeOpen(env), false, name);
  }
  // The default switch is off.
  const wrangler = (await import("node:fs")).readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(wrangler, /"CONFIDENTIAL_INTAKE": "off"/);
});

test("a hold interrupted by a withdrawal leaves no anonymous mapping behind", async () => {
  const env = environment();
  const { store, token, id } = await admitted(env);
  passReview(store, id);
  // Withdraw lands while the hold is making its certificates.
  const bucket = env.CONFIDENTIAL_SOURCE;
  const put = bucket.put.bind(bucket);
  let withdrawn = false;
  bucket.put = async (key, value, options) => {
    const result = await put(key, value, options);
    if (!withdrawn && key.startsWith("conf-anon/")) {
      withdrawn = true;
      await bearer(env, token, "/withdraw", { method: "POST", headers: { "sec-fetch-site": "same-origin" } });
    }
    return result;
  };
  await bearer(env, token, "/api/submission");
  assert.equal(withdrawn, true);
  assert.equal((await readLifecycle(env, id)).value.state, "withdrawn");
  assert.deepEqual([...bucket.objects.keys()].filter((key) => key.startsWith("conf-anon/")), []);
});
