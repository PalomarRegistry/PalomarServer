import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PROFILE, LARGER_PROFILE, RESOURCE_CONTACT, escalationDecision, maybeEscalate,
  publicFailure, retryProjection, validatePolicy } from "../src/resource-escalation.js";

const policy = { schema_version: 1, users: [{ id: 123, login: "previous-name" }] };
const at = "2026-10-23T03:00:00Z";
const options = { attempt: "b".repeat(32), at, policyHash: "c".repeat(64) };
function state() {
  return { id: "abcdefghijkl", status: "verification-error", owner: "owner", submitter: "renamed-user",
    repository: "owner/project", commit: "a".repeat(40), push_verified: true,
    push_proof: { principal: { id: 123, login: "renamed-user" } },
    authorization: { relationship: "maintainer" }, registration_consent: false, review_retry_after: at,
    requested_paths: { project_path: "project" }, events: [],
    run: { id: 42, status: "completed", conclusion: "failure" },
    failure: { schema_version: 1, mode: "full", phase: "verification", run: { id: 42 },
      resource_failure: { kind: "oom", profile: DEFAULT_PROFILE, run_id: 42 },
      diagnostics: [{ owner: "provider", code: "provider.resource_exhausted", retryable: true }] } };
}
const queue = { schema_version: 1, open: [] };

test("the default allowlist is empty; immutable identity permits a renamed account", () => {
  assert.equal(escalationDecision(state()), null);
  assert.equal(escalationDecision(state(), policy).profile, LARGER_PROFILE);
  const forged = state();
  forged.push_proof.principal.id = 999;
  forged.push_proof.principal.login = "previous-name";
  forged.submitter = "previous-name";
  assert.equal(escalationDecision(forged, policy), null);
  for (const change of [{ push_verified: false }, { push_proof: null }, { authorization: null },
    { submitter: "someone-else" }, { commit: "main" }, { registry_correction: true }, { status: "withdrawn" }]) {
    assert.equal(escalationDecision({ ...state(), ...change }, policy), null);
  }
});
test("allowlist policy rejects duplicate IDs, strings, extra fields and malformed entries", () => {
  for (const value of [null, { ...policy, typo: true }, { ...policy, schema_version: true },
    { ...policy, users: [policy.users[0], policy.users[0]] },
    { ...policy, users: [{ id: "123", login: "user" }] },
    { ...policy, users: [{ ...policy.users[0], enabled: true }] }]) assert.throws(() => validatePolicy(value));
});
test("only authenticated OOM or timeout on the default Namespace tier can escalate", () => {
  for (const change of [{ kind: "disk" }, { run_id: 99 }, { profile: "palomar-standard-v1" },
    { profile: LARGER_PROFILE }, { kind: "timeout", extra: "untrusted" }]) {
    const previous = state();
    Object.assign(previous.failure.resource_failure, change);
    assert.equal(escalationDecision(previous, policy), null);
  }
  for (const diagnostic of [{ owner: "submitter", code: "provider.resource_exhausted" },
    { owner: "provider", code: "provider.workflow_interrupted" },
    { owner: "palomar", code: "palomar.diagnostics_unavailable" }]) {
    const previous = state();
    previous.failure.diagnostics = [diagnostic];
    assert.equal(escalationDecision(previous, policy), null);
  }
  const text = state();
  delete text.failure.resource_failure;
  text.failure.diagnostics[0].summary = "OOM; timed out; exit code 137";
  assert.equal(escalationDecision(text, policy), null);
  const timeout = state();
  timeout.run.conclusion = "timed_out";
  timeout.failure.resource_failure.kind = "timeout";
  timeout.failure.diagnostics[0].code = "provider.workflow_timeout";
  assert.ok(escalationDecision(timeout, policy));
});
test("only one automatic retry survives later operator retries and every failure stays actionable", () => {
  const previous = state();
  previous.execution_history = [{ execution: { automatic: { schema_version: 1 } } }];
  assert.equal(escalationDecision(previous, policy), null);
  previous.execution_history = [];
  previous.execution = { automatic: { schema_version: 1 } };
  assert.equal(escalationDecision(previous, policy), null);
  const result = publicFailure(state());
  assert.equal(result.diagnostics[0].retryable, false);
  assert.equal(result.diagnostics[0].next_action, RESOURCE_CONTACT);
  assert.equal(state().failure.diagnostics[0].retryable, true);
  const larger = state();
  larger.failure.resource_failure.profile = LARGER_PROFILE;
  assert.match(publicFailure(larger).diagnostics[0].next_action, /stops after one retry/);
});
test("retry preserves admitted source, consent, cooldown and alerts while archiving evidence", () => {
  const previous = state();
  previous.operator_alerts = { schema_version: 1, items: [{ key: "old", status: "sent" }] };
  const result = retryProjection(previous, { open: [] }, queue, escalationDecision(previous, policy), options);
  for (const key of ["commit", "repository", "authorization", "push_proof", "registration_consent",
    "review_retry_after", "requested_paths"]) assert.deepEqual(result.state[key], previous[key]);
  assert.equal(result.state.status, "verifying");
  assert.equal(result.state.run, undefined);
  assert.equal(result.state.failure, undefined);
  assert.deepEqual(result.state.execution_history[0].failure, previous.failure);
  assert.equal(result.state.execution.automatic.principal_id, 123);
  assert.equal(result.state.execution.automatic.run_id, 42);
  assert.equal(result.state.execution.profile, LARGER_PROFILE);
  assert.equal(result.state.operator_alerts.items[0].origin.failure.resource_failure.kind, "oom");
  assert.equal(result.inflight.open[0].id, previous.id);
  assert.deepEqual(result.queue.open, [previous.id]);
  assert.equal(previous.status, "verification-error");
});
test("reservations remain byte-identical when held; normal admission limits apply otherwise", () => {
  const previous = state();
  const held = { open: [{ id: previous.id, owner: previous.owner, submitter: previous.submitter, at }] };
  const result = retryProjection(previous, held, queue, escalationDecision(previous, policy), options);
  assert.equal(result.inflight, held);
  assert.equal(result.held, true);
  const occupied = { open: [{ id: "bcdefghijklm", owner: "other", submitter: previous.submitter, at }] };
  assert.equal(retryProjection(previous, occupied, queue, escalationDecision(previous, policy), options), null);
  assert.throws(() => retryProjection(previous, { open: [] }, queue, escalationDecision(previous, policy),
    { ...options, attempt: "invalid" }));
});

test("retry commits State and reviewer queue atomically before the ordinary dispatcher runs", async (t) => {
  for (const lose of [false, true]) {
    const previous = state();
    const path = `submissions/${previous.id}/state.json`;
    const files = { [path]: previous, "index/inflight.json": { open: [] }, "index/open.json": queue };
    const writes = [];
    const head = "a".repeat(40);
    t.mock.method(globalThis, "fetch", async (url, init = {}) => {
      const target = new URL(url).pathname;
      const body = init.body ? JSON.parse(init.body) : null;
      if (target.endsWith("/git/ref/heads/main")) return Response.json({ object: { type: "commit", sha: head } });
      if (target.endsWith(`/git/commits/${head}`)) return Response.json({ tree: { sha: "b".repeat(40) } });
      if (target.includes("/contents/")) {
        const value = files[target.split("/contents/")[1]];
        assert.ok(value);
        return Response.json({ content: Buffer.from(JSON.stringify(value)).toString("base64"), sha: "file-sha" });
      }
      if (target.endsWith("/git/trees")) { writes.push(body); return Response.json({ sha: "tree" }); }
      if (target.endsWith("/git/commits")) return Response.json({ sha: "commit" });
      if (target.endsWith("/git/refs/heads/main")) {
        assert.equal(body.force, false);
        return lose ? Response.json({ message: "Update is not a fast forward" }, { status: 422 }) : Response.json({});
      }
      throw new Error(`Unexpected network call (dispatch forbidden): ${target}`);
    });
    const result = await maybeEscalate({ GITHUB_TOKEN: "test", STATE_REPO: "org/state" }, previous, policy);
    assert.equal(result?.status ?? null, lose ? null : "verifying");
    assert.deepEqual(writes[0].tree.map(item => item.path).sort(), [path, "index/open.json", "index/inflight.json"].sort());
    const projected = JSON.parse(writes[0].tree.find(item => item.path === path).content);
    assert.equal(projected.execution.profile, LARGER_PROFILE);
    t.mock.restoreAll();
  }
});

test("a concurrent withdrawal cannot be retried from stale page state", async (t) => {
  const previous = state();
  const path = `submissions/${previous.id}/state.json`;
  const files = { [path]: { ...previous, status: "withdrawn" }, "index/inflight.json": { open: [] }, "index/open.json": queue };
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    assert.equal(init.method ?? "GET", "GET");
    const target = new URL(url).pathname;
    if (target.endsWith("/git/ref/heads/main")) return Response.json({ object: { type: "commit", sha: "a".repeat(40) } });
    if (target.includes("/git/commits/")) return Response.json({ tree: { sha: "b".repeat(40) } });
    return Response.json({ content: Buffer.from(JSON.stringify(files[target.split("/contents/")[1]])).toString("base64"), sha: "file" });
  });
  assert.equal(await maybeEscalate({ GITHUB_TOKEN: "test", STATE_REPO: "org/state" }, previous, policy), null);
});

test("scheduled reconciliation queues allowlisted retries without a browser and retains slots on a CAS loss", async (t) => {
  const { default: configured } = await import("../src/resource-escalation-policy.json", { with: { type: "json" } });
  const { reconcile } = await import("../src/submission-lifecycle.js");
  const original = [...configured.users];
  configured.users.push(policy.users[0]);
  t.after(() => { configured.users.splice(0, configured.users.length, ...original); });
  for (const lose of [false, true]) {
    const previous = state();
    const path = `submissions/${previous.id}/state.json`;
    const files = { [path]: previous, "index/inflight.json": { open: [
      { id: previous.id, owner: previous.owner, submitter: previous.submitter, at },
    ] }, "index/open.json": queue };
    const writes = [];
    const head = "a".repeat(40);
    t.mock.method(globalThis, "fetch", async (url, init = {}) => {
      const target = new URL(url).pathname;
      const body = init.body ? JSON.parse(init.body) : null;
      if (target.endsWith("/git/ref/heads/main")) return Response.json({ object: { type: "commit", sha: head } });
      if (target.endsWith(`/git/commits/${head}`)) return Response.json({ tree: { sha: "b".repeat(40) } });
      if (target.includes("/contents/")) {
        assert.equal(init.method ?? "GET", "GET", "reservation must survive a competing retry");
        const value = files[target.split("/contents/")[1]];
        return Response.json({ content: Buffer.from(JSON.stringify(value)).toString("base64"), sha: "file-sha" });
      }
      if (target.endsWith("/git/trees")) { writes.push(body); return Response.json({ sha: "tree" }); }
      if (target.endsWith("/git/commits")) return Response.json({ sha: "commit" });
      if (target.endsWith("/git/refs/heads/main")) return lose
        ? Response.json({ message: "Update is not a fast forward" }, { status: 422 }) : Response.json({});
      throw new Error(`Unexpected network call: ${target}`);
    });
    assert.deepEqual(await reconcile({ GITHUB_TOKEN: "test", STATE_REPO: "org/state" }), { released: 0, open: 1 });
    assert.deepEqual(writes[0].tree.map(item => item.path).sort(), [path, "index/open.json"].sort());
    t.mock.restoreAll();
  }
});

test("exhausted audit histories do not keep failed submissions eligible", () => {
  const previous = state();
  previous.execution_history = Array.from({ length: 50 }, () => ({ execution: null }));
  assert.equal(escalationDecision(previous, policy), null);
  previous.execution_history = [];
  previous.operator_alerts = { items: Array.from({ length: 50 }, () => ({})) };
  assert.equal(escalationDecision(previous, policy), null);
});

test("one broken retry preserves its slot, releases unrelated terminal slots and reports the failure", async (t) => {
  const { default: configured } = await import("../src/resource-escalation-policy.json", { with: { type: "json" } });
  const { reconcile } = await import("../src/submission-lifecycle.js");
  const original = [...configured.users];
  configured.users.push(policy.users[0]);
  t.after(() => { configured.users.splice(0, configured.users.length, ...original); });
  const previous = state();
  const path = `submissions/${previous.id}/state.json`;
  const terminal = { id: "bcdefghijklm", status: "withdrawn" };
  const badSlot = { id: previous.id, owner: "wrong-owner", submitter: previous.submitter, at };
  const files = { [path]: previous, [`submissions/${terminal.id}/state.json`]: terminal,
    "index/inflight.json": { open: [badSlot, { id: terminal.id, owner: "other", submitter: "other", at }] },
    "index/open.json": queue };
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const target = new URL(url).pathname;
    if (target.endsWith("/git/ref/heads/main")) return Response.json({ object: { type: "commit", sha: "a".repeat(40) } });
    if (target.includes("/git/commits/")) return Response.json({ tree: { sha: "b".repeat(40) } });
    if (target.includes("/contents/")) {
      const file = target.split("/contents/")[1];
      if (init.method === "PUT") {
        assert.equal(file, "index/inflight.json");
        files[file] = JSON.parse(Buffer.from(JSON.parse(init.body).content, "base64"));
        return Response.json({});
      }
      return Response.json({ content: Buffer.from(JSON.stringify(files[file])).toString("base64"), sha: "file" });
    }
    throw new Error(`Unexpected write or dispatch: ${target}`);
  });
  await assert.rejects(() => reconcile({ GITHUB_TOKEN: "test", STATE_REPO: "org/state" }), /resource retry failed/);
  assert.deepEqual(files["index/inflight.json"].open, [badSlot]);
});
