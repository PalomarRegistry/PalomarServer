import assert from "node:assert/strict";
import { test } from "node:test";
import { retryTransition } from "../src/operator-retry.js";
const state = { id: "abcdefghijkl", status: "verification-error", repository: "owner/repo", commit: "a".repeat(40),
  authorization: { relationship: "maintainer" }, owner: "owner", submitter: "user", events: [],
  requested_paths: { project_path: "project" }, failure: { diagnostics: [] }, run: { id: 12 } };
const options = { principal: { id: 477956, login: "kim-em" }, reason: "Provider recovery", profile: "palomar-standard-v1",
  attempt: "a".repeat(32), at: "2026-09-16T00:00:00Z" };
const queue = { schema_version: 1, open: [] };
test("recovery archives evidence, retains source and authorization, and reserves slots", () => {
  const result = retryTransition(state, { open: [] }, queue, options);
  assert.equal(result.state.run, undefined);
  assert.equal(result.state.execution_history[0].run.id, 12);
  for (const key of ["repository", "commit", "requested_paths", "authorization"]) assert.deepEqual(result.state[key], state[key]);
  assert.equal(result.inflight.open[0].submitter, "user");
  assert.deepEqual(result.queue.open, [state.id]);
  assert.equal(state.status, "verification-error");
});
test("recovery rejects withdrawn, active, unapproved, unauthorized and occupied submissions", () => {
  for (const status of ["withdrawn", "verifying", "registered"]) {
    assert.throws(() => retryTransition({ ...state, status }, { open: [] }, queue, options));
  }
  for (const change of [{ principal: { id: 1 } }, { profile: "custom" }, { profile: "palomar-namespace-16x32-v1" }]) {
    assert.throws(() => retryTransition(state, { open: [] }, queue, { ...options, ...change }));
  }
  assert.throws(() => retryTransition(state, { open: [{ id: "bcdefghijklm", owner: "other", submitter: "user", at: options.at }] }, queue, options));
});

test("renderability recovery renews the gate budget without shortening backoff", () => {
  const exhausted = { ...state, run: { id: 12, conclusion: "success" },
    renderability_attempts: 3, renderability_started_at: "2026-09-15T00:00:00Z",
    renderability_error: "renderer infrastructure failed",
    review_retry_after: "2026-09-17T00:00:00Z", review_attempts: 2,
    registration_consent: false };
  delete exhausted.failure;
  const result = retryTransition(exhausted, { open: [] }, queue, options).state;
  assert.equal((result.renderability_attempts ?? 0) + 1, 1);
  assert.equal(result.renderability_started_at, undefined);
  assert.equal(result.renderability_error, undefined);
  assert.equal(result.review_retry_after, exhausted.review_retry_after);
  assert.equal(result.review_attempts, 2);
  assert.equal(result.registration_consent, false);
  assert.deepEqual(result.execution_history[0].run, exhausted.run);
  assert.equal(result.execution_history[0].failure, null);
  assert.equal(exhausted.renderability_attempts, 3);
});

test("run discovery cannot reuse the original failed run for a fresh operator attempt", async (t) => {
  const { findVerificationRun } = await import("../src/github.js");
  const original = { id: 1, name: "Verify submission abcdefghijkl", status: "completed", conclusion: "failure" };
  const current = { ...original, id: 2, name: `Verify submission abcdefghijkl [${options.attempt}]`, status: "queued", conclusion: null };
  t.mock.method(globalThis, "fetch", async () => Response.json({ workflow_runs: [original, current] }));
  const env = { SUBMISSION_TOKEN: "test", SUBMISSION_REPO: "PalomarRegistry/PalomarSubmission", VERIFY_WORKFLOW: "submission.yml" };
  const result = await findVerificationRun(env, state.id, { executionAttempt: options.attempt, since: options.at });
  assert.equal(result.run.id, 2);
});

test("retained alert origins are frozen before the current failure is removed", () => {
  const previous = { ...state, operator_alerts: { schema_version: 1, items: [{ key: "a".repeat(64), status: "sent" }] } };
  const result = retryTransition(previous, { open: [] }, queue, options);
  assert.equal(result.state.operator_alerts.schema_version, 2);
  assert.deepEqual(result.state.operator_alerts.items[0].origin.failure, state.failure);
  assert.equal(result.state.failure, undefined);
});

test("operator clock comes from the authenticated GitHub response and attempt IDs cannot be reused", async () => {
  const { authenticatedOperator } = await import("../src/operator-retry.js");
  const auth = authenticatedOperator('HTTP/2.0 200 OK\nDate: Wed, 16 Sep 2026 08:00:00 GMT\n\n{"id":477956,"login":"kim-em"}');
  assert.equal(auth.at, "2026-09-16T08:00:00Z");
  assert.equal(auth.principal.id, 477956);
  assert.throws(() => retryTransition({ ...state, execution: { attempt: options.attempt } }, { open: [] }, queue, options));
  assert.throws(() => authenticatedOperator('{"id":477956}'));
});
