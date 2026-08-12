import assert from "node:assert/strict";
import test from "node:test";

import {
  inflightOpen,
  isCurrentReview,
  principalSubmissions,
  repairOpen,
  reviewerOpen,
  StateContractError,
  submitterReview,
} from "../src/state-contract.js";

const ID = "a1b2c3d4e5f6";

function inflightEntry(overrides = {}) {
  return {
    id: ID,
    owner: "example",
    submitter: "someone",
    at: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

test("the inflight contract returns only a fully validated current list", () => {
  const open = [inflightEntry()];
  assert.equal(inflightOpen({ open }), open);

  for (const [value, message] of [
    [null, /exactly one top-level open array/],
    [{ open, schema_version: 1 }, /exactly one top-level open array/],
    [{ open: [{ ...open[0], legacy: true }] }, /must contain exactly id, owner, submitter, and at/],
    [{ open: [open[0], { ...open[0] }] }, /duplicates another inflight submission/],
    [{ open: [inflightEntry({ at: "2026-08-01T00:00:00.000Z" })] },
      /must be a canonical UTC-seconds timestamp/],
    [{ open: [inflightEntry({ at: "2026-08-01T24:00:00Z" })] },
      /must be a canonical UTC-seconds timestamp/],
  ]) {
    assert.throws(
      () => inflightOpen(value),
      (error) => error instanceof StateContractError && message.test(error.message),
    );
  }
});

test("the reviewer queue validates its owned fields and preserves the rest", () => {
  const value = {
    schema_version: 1,
    open: [ID],
    reviewer_owned_rebuild_at: "2026-08-01T00:00:00.123Z",
  };
  assert.equal(reviewerOpen(value), value.open);
  assert.throws(
    () => reviewerOpen({ ...value, open: [ID, ID] }),
    /index\/open\.json open\[1\] is duplicated/,
  );
  assert.throws(() => reviewerOpen({ schema_version: 2, open: [] }), StateContractError);
});

test("the private principal locator is strict and duplicate-free", () => {
  const path = `index/principals/${"a".repeat(64)}.json`;
  assert.deepEqual(
    principalSubmissions({ schema_version: 1, submissions: [ID] }, path),
    [ID],
  );
  assert.throws(
    () => principalSubmissions({ schema_version: 1, submissions: [ID, ID] }, path),
    /duplicated/,
  );
  assert.throws(
    () => principalSubmissions({ schema_version: 1, submissions: [], extra: true }, path),
    /exactly/,
  );
});

test("the repair outbox is a strict unique submission-id queue", () => {
  const value = { schema_version: 1, open: [ID] };
  assert.equal(repairOpen(value), value.open);
  assert.throws(() => repairOpen({ schema_version: 1, open: [ID, ID] }), /duplicated/);
  assert.throws(() => repairOpen({ schema_version: 1, open: ["not-an-id"] }), /submission id/);
  assert.throws(() => repairOpen({ open: [] }), StateContractError);
});

test("only a matching current review and decision passes the review contract", () => {
  const review = { schema_version: 2, submission_id: ID, decision: "accept" };
  assert.equal(isCurrentReview(review, ID), true);
  for (const candidate of [
    null,
    [],
    { ...review, schema_version: 1 },
    { ...review, submission_id: "b1b2c3d4e5f6" },
    { ...review, decision: "unknown" },
  ]) {
    assert.equal(isCurrentReview(candidate, ID), false);
  }
});

test("the submitter projection is an explicit review-field allowlist", () => {
  assert.deepEqual(submitterReview({
    decision: "revise",
    summary: "Needs another pass.",
    warnings: ["One warning."],
    requested_changes: ["One change."],
    reviewed_at: "2026-08-01T00:00:00Z",
    reviewer_models: ["model-a"],
    scores: { quality: 4 },
    passes: [{ private: true }],
  }), {
    passed: false,
    summary: "Needs another pass.",
    comments: ["One warning."],
    requested_changes: ["One change."],
    reviewed_at: "2026-08-01T00:00:00Z",
    reviewer_models: ["model-a"],
  });

  assert.deepEqual(submitterReview({ decision: "accept" }), {
    passed: true,
    summary: undefined,
    comments: [],
    requested_changes: [],
    reviewed_at: undefined,
    reviewer_models: [],
  });
});
