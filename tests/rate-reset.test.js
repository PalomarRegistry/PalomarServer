import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";
import { retryVerification } from "../src/operator-retry.js";
import { nextRateRecord, rateDecision } from "../src/admission-contract.js";
import {
  RATE_RESET_INDEX_PATH, ratePath, rateResetQueue, reconcileRateResets, settleRateReset,
} from "../src/rate-reset.js";

const ENV = { STATE_REPO: "example/state", GITHUB_TOKEN: "test", TOKEN_PEPPER: "test-pepper" };
const ID = "a1b2c3d4e5f6";
const RECORD_PATH = `submissions/${ID}/state.json`;

/** Git commits are staged until a non-forced ref update succeeds. No network. */
function stateApi(t, files) {
  let sequence = 1;
  const sha = () => (sequence++).toString(16).padStart(40, "0");
  let head = sha();
  const commits = new Map([[head, { files: structuredClone(files) }]]);
  const trees = new Map();
  const state = {
    rejectReset: false, race: null, applied: [], malformed: new Set(),
    files: () => commits.get(head).files,
    commit(changes) {
      const next = { ...structuredClone(state.files()), ...changes };
      head = sha();
      commits.set(head, { files: next });
    },
  };
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const target = new URL(url);
    assert.equal(target.origin, "https://api.github.com");
    const route = target.pathname.replace(`/repos/${ENV.STATE_REPO}/`, "");
    const method = init.method ?? "GET";
    const body = init.body && JSON.parse(init.body);
    if (route === "git/ref/heads/main") {
      return Response.json({ object: { type: "commit", sha: head } });
    }
    if (route.startsWith("git/commits/") && method === "GET") {
      return Response.json({ tree: { sha: "a".repeat(40) } });
    }
    if (route.startsWith("contents/")) {
      const path = route.slice("contents/".length);
      if (path === "pending") return Response.json([]);
      const source = commits.get(target.searchParams.get("ref") ?? head).files;
      if (!Object.hasOwn(source, path)) return new Response("", { status: 404 });
      return Response.json({
        sha: `blob-${path}`, content: Buffer.from(state.malformed.has(path) ? "{" : JSON.stringify(source[path])).toString("base64"),
      });
    }
    if (route === "git/trees" && method === "POST") {
      if (state.rejectReset && body.tree.some(item => item.path.startsWith("index/rate/"))) {
        return new Response("unavailable", { status: 503 });
      }
      const id = sha();
      trees.set(id, body.tree);
      return Response.json({ sha: id });
    }
    if (route === "git/commits" && method === "POST") {
      const id = sha();
      commits.set(id, { parent: body.parents[0], tree: trees.get(body.tree) });
      return Response.json({ sha: id });
    }
    if (route === "git/refs/heads/main" && method === "PATCH") {
      assert.equal(body.force, false);
      if (state.race) {
        const race = state.race;
        state.race = null;
        race(state);
      }
      const commit = commits.get(body.sha);
      if (commit.parent !== head) return new Response("conflict", { status: 409 });
      const next = structuredClone(state.files());
      for (const item of commit.tree) {
        if (item.sha === null) delete next[item.path];
        else next[item.path] = JSON.parse(item.content);
      }
      commit.files = next;
      head = body.sha;
      state.applied.push(commit.tree.map(item => item.path));
      return Response.json({ object: { sha: head } });
    }
    throw new Error(`unexpected mocked request: ${method} ${route}`);
  });
  return state;
}

async function fixture(t, { status = "registered", rate, record = {} } = {}) {
  const rateFile = await ratePath(ENV, 4242);
  return { rateFile, api: stateApi(t, {
    "index/inflight.json": { open: [] },
    [RATE_RESET_INDEX_PATH]: { schema_version: 1, open: [ID] },
    [RECORD_PATH]: { id: ID, status, push_proof: { principal: { id: 4242 } }, ...record },
    [rateFile]: rate ?? {
      schema_version: 1, starts: 12, interval_seconds: 122880,
      last_start_at: "2026-08-08T00:00:00Z", next_allowed_at: "2026-08-09T10:08:00Z",
    },
  }) };
}

test("scheduled maintenance resets a registered result without a status poll", async t => {
  const { api, rateFile } = await fixture(t);
  await worker.scheduled({}, ENV);
  const rate = api.files()[rateFile];
  assert.equal(rate.interval_seconds, 60);
  assert.equal(rate.starts, 12);
  assert.equal(rateDecision(rate).refused, false);
  assert.ok(api.files()[RECORD_PATH].rate_reset_at);
  assert.deepEqual(api.files()[RATE_RESET_INDEX_PATH].open, []);
  assert.ok(api.applied.some(paths => paths.includes(rateFile) && paths.includes(RECORD_PATH)));
});

test("a failed reset leaves no receipt, stays queued, and succeeds on a later pass", async t => {
  t.mock.method(console, "error", () => {});
  const { api, rateFile } = await fixture(t);
  api.rejectReset = true;
  await assert.rejects(reconcileRateResets(ENV), /GitHub 503/);
  assert.equal(api.files()[rateFile].interval_seconds, 122880);
  assert.equal(api.files()[RECORD_PATH].rate_reset_at, undefined);
  assert.deepEqual(api.files()[RATE_RESET_INDEX_PATH].open, [ID]);
  api.rejectReset = false;
  await reconcileRateResets(ENV);
  assert.equal(api.files()[rateFile].interval_seconds, 60);
});

test("a concurrent status poll wins once and a stale reset cannot erase a later admission", async t => {
  const { api, rateFile } = await fixture(t);
  api.race = state => {
    const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    state.commit({
      [RECORD_PATH]: { ...state.files()[RECORD_PATH], rate_reset_at: at },
      [rateFile]: nextRateRecord({ starts: 12, interval: 60, startedAt: at }),
    });
  };
  await settleRateReset(ENV, ID);
  assert.equal(api.files()[rateFile].interval_seconds, 120);
  await reconcileRateResets(ENV);
  assert.equal(api.files()[rateFile].interval_seconds, 120);
  assert.deepEqual(api.files()[RATE_RESET_INDEX_PATH].open, []);
});

test("a concurrent rate admission is re-read instead of losing its start count", async t => {
  const { api, rateFile } = await fixture(t);
  api.race = state => state.commit({
    [rateFile]: { ...state.files()[rateFile], starts: 13, interval_seconds: 245760 },
  });
  await settleRateReset(ENV, ID);
  assert.equal(api.files()[rateFile].starts, 13);
  assert.equal(api.files()[rateFile].interval_seconds, 60);
});

test("a malformed rate keeps its reset pending while unrelated resets make progress", async t => {
  t.mock.method(console, "error", () => {});
  const { api, rateFile } = await fixture(t, { rate: { schema_version: 1, interval_seconds: "60" } });
  const other = "b2c3d4e5f6a1";
  const otherPath = `submissions/${other}/state.json`;
  const otherRate = await ratePath(ENV, 42);
  api.commit({
    [RATE_RESET_INDEX_PATH]: { schema_version: 1, open: [ID, other] },
    [otherPath]: { id: other, status: "registered", push_proof: { principal: { id: 42 } } },
    [otherRate]: { schema_version: 1, starts: 2, interval_seconds: 120,
      last_start_at: "2026-10-26T00:00:00Z", next_allowed_at: "2026-10-26T00:02:00Z" },
  });
  await assert.rejects(reconcileRateResets(ENV), /rate resets failed/);
  assert.equal(api.files()[RECORD_PATH].rate_reset_at, undefined);
  assert.equal(api.files()[rateFile].interval_seconds, "60");
  assert.equal(api.files()[otherRate].interval_seconds, 60);
  assert.deepEqual(api.files()[RATE_RESET_INDEX_PATH].open, [ID]);
});

test("active records rotate in a bounded batch so later registrations are reached", async t => {
  const { api, rateFile } = await fixture(t);
  const ids = Array.from({ length: 25 }, (_, i) => String(i).padStart(12, "0"));
  api.commit({
    [RATE_RESET_INDEX_PATH]: { schema_version: 1, open: [...ids, ID] },
    ...Object.fromEntries(ids.map(id => [`submissions/${id}/state.json`, { id, status: "awaiting-review" }])),
  });
  await reconcileRateResets(ENV);
  assert.equal(api.files()[rateFile].interval_seconds, 122880);
  assert.equal(api.files()[RATE_RESET_INDEX_PATH].open[0], ID);
  await reconcileRateResets(ENV);
  assert.equal(api.files()[rateFile].interval_seconds, 60);
});

test("withdrawal and verification failure leave the accumulated cooldown intact", async t => {
  for (const status of ["withdrawn", "verification-failed"]) {
    const { api, rateFile } = await fixture(t, { status });
    await reconcileRateResets(ENV);
    assert.equal(api.files()[rateFile].interval_seconds, 122880);
    assert.equal(api.files()[RECORD_PATH].rate_reset_at, undefined);
    assert.deepEqual(api.files()[RATE_RESET_INDEX_PATH].open, []);
  }
});

test("a queue update preserves concurrent admissions", async t => {
  const { api } = await fixture(t, { status: "withdrawn" });
  const other = "b2c3d4e5f6a1";
  api.race = state => state.commit({
    [RATE_RESET_INDEX_PATH]: { schema_version: 1, open: [ID, other] },
  });
  await reconcileRateResets(ENV);
  assert.deepEqual(api.files()[RATE_RESET_INDEX_PATH].open, [other]);
});

test("queue cleanup cannot drop the same submission after operator recovery reopens it", async t => {
  const { api } = await fixture(t, { status: "verification-failed" });
  api.race = state => state.commit({
    [RECORD_PATH]: { ...state.files()[RECORD_PATH], status: "verifying" },
  });
  await reconcileRateResets(ENV);
  assert.deepEqual(api.files()[RATE_RESET_INDEX_PATH].open, [ID]);
});

test("operator recovery restores reset tracking without refunding its cooldown", async t => {
  const { api, rateFile } = await fixture(t, { status: "verification-failed", record: {
    repository: "example/project", commit: "a".repeat(40), owner: "example", submitter: "someone",
    authorization: { relationship: "maintainer" }, events: [], run: { id: 123 },
  } });
  api.commit({
    [RATE_RESET_INDEX_PATH]: { schema_version: 1, open: [] },
    "index/open.json": { schema_version: 1, open: [] },
  });
  const options = {
    principal: { id: 477956, login: "kim-em" }, reason: "Recover an infrastructure failure",
    profile: "palomar-standard-v1", attempt: "a".repeat(32), at: "2026-08-10T00:00:00Z",
  };
  await retryVerification(ENV, ID, options);
  assert.deepEqual(api.files()[RATE_RESET_INDEX_PATH].open, []);
  await retryVerification(ENV, ID, options, { apply: true });
  assert.deepEqual(api.files()[RATE_RESET_INDEX_PATH].open, [ID]);
  assert.equal(api.files()[RECORD_PATH].status, "verifying");
  assert.equal(api.files()[rateFile].interval_seconds, 122880);
});

test("only an absent queue defaults to empty; corrupt queues fail closed", () => {
  assert.deepEqual(rateResetQueue(null), []);
  for (const value of [{}, [], { schema_version: 1, open: [ID, ID] },
    { schema_version: 1, open: ["bad"] }, { schema_version: 1, open: [], login: "someone" }]) {
    assert.throws(() => rateResetQueue(value), /unique submission ids/);
  }
});

test("a full backfill batch commits once and deduplicates each principal's rate file", async t => {
  const { api, rateFile } = await fixture(t);
  const ids = Array.from({ length: 25 }, (_, i) => String(i).padStart(12, "0"));
  const otherRate = await ratePath(ENV, 42);
  api.commit({
    [RATE_RESET_INDEX_PATH]: { schema_version: 1, open: ids },
    [otherRate]: api.files()[rateFile],
    ...Object.fromEntries(ids.map((id, i) => [`submissions/${id}/state.json`, {
      id, status: "registered", push_proof: { principal: { id: i % 2 ? 4242 : 42 } },
    }])),
  });
  await reconcileRateResets(ENV);
  assert.equal(api.applied.length, 1, "backfill emitted a write burst instead of one commit");
  assert.equal(api.applied[0].filter(path => path.startsWith("index/rate/")).length, 2);
  for (const id of ids) assert.ok(api.files()[`submissions/${id}/state.json`].rate_reset_at);
  assert.deepEqual(api.files()[RATE_RESET_INDEX_PATH].open, []);
});

test("returning principal catches up its own registration beyond the maintenance batch", async t => {
  const { api, rateFile } = await fixture(t);
  const others = Array.from({ length: 50 }, (_, i) => String(i).padStart(12, "0"));
  const key = rateFile.replace("index/rate/", "index/principals/");
  api.commit({
    [RATE_RESET_INDEX_PATH]: { schema_version: 1, open: [...others, ID] },
    [key]: { schema_version: 1, submissions: [ID] },
  });
  await reconcileRateResets(ENV, { principalId: 4242 });
  assert.equal(api.files()[rateFile].interval_seconds, 60);
  assert.deepEqual(api.files()[RATE_RESET_INDEX_PATH].open, others);
  assert.equal(api.applied.length, 1);
});

test("a delayed historical registration cannot erase cooldowns from later starts", async t => {
  const { api, rateFile } = await fixture(t, { record: {
    events: [{ at: "2026-08-07T00:00:00Z", status: "registered" }],
  } });
  await reconcileRateResets(ENV);
  assert.equal(api.files()[rateFile].interval_seconds, 122880);
  assert.ok(api.files()[RECORD_PATH].rate_reset_at);
  assert.deepEqual(api.files()[RATE_RESET_INDEX_PATH].open, []);
});

test("a corrupt JSON rate file is isolated while unrelated registrations settle", async t => {
  t.mock.method(console, "error", () => {});
  const { api, rateFile } = await fixture(t);
  const other = "b2c3d4e5f6a1";
  const otherRate = await ratePath(ENV, 42);
  api.commit({
    [RATE_RESET_INDEX_PATH]: { schema_version: 1, open: [ID, other] },
    [`submissions/${other}/state.json`]: {
      id: other, status: "registered", push_proof: { principal: { id: 42 } },
    },
    [otherRate]: api.files()[rateFile],
  });
  api.malformed.add(rateFile);
  await assert.rejects(reconcileRateResets(ENV), /rate resets failed/);
  assert.equal(api.files()[RECORD_PATH].rate_reset_at, undefined);
  assert.equal(api.files()[otherRate].interval_seconds, 60);
  assert.deepEqual(api.files()[RATE_RESET_INDEX_PATH].open, [ID]);
  assert.equal(api.applied.length, 1);
});
