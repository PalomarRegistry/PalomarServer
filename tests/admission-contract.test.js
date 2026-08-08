import assert from "node:assert/strict";
import test from "node:test";

import {
  admissionDecision,
  nextRateRecord,
  rateDecision,
  resetRateRecord,
} from "../src/admission-contract.js";

const AT = Date.parse("2026-08-08T00:00:00Z");

function inflight(overrides = {}) {
  return { owner: "another-owner", submitter: "another-submitter", ...overrides };
}

test("admission allows a submission below every cap", () => {
  assert.deepEqual(
    admissionDecision([inflight()], { owner: "example", submitter: "someone" }),
    { refused: false },
  );
});

test("total capacity takes precedence over the narrower caps", () => {
  const open = Array.from({ length: 12 }, () => inflight({
    owner: "example",
    submitter: "someone",
  }));
  assert.deepEqual(admissionDecision(open, { owner: "example", submitter: "someone" }), {
    refused: true,
    status: 503,
    title: "Palomar is at capacity",
    detail: ["Too many submissions are being verified right now. Please try again later."],
  });
});

test("owner and submitter caps have their exact current responses", () => {
  assert.deepEqual(
    admissionDecision(
      [inflight({ owner: "example" }), inflight({ owner: "example" })],
      { owner: "example", submitter: "someone" },
    ),
    {
      refused: true,
      status: 429,
      title: "That repository already has submissions in flight",
      detail: [
        "Palomar verifies at most 2 submissions at a time from one owner.",
        "Wait for those to finish before submitting another.",
      ],
    },
  );

  assert.deepEqual(
    admissionDecision(
      [inflight({ submitter: "someone" }), inflight({ submitter: "someone" })],
      { owner: "example", submitter: "someone" },
    ),
    {
      refused: true,
      status: 429,
      title: "You already have submissions in flight",
      detail: [
        "Palomar verifies at most 2 submissions at a time from one submitter.",
        "Wait for those to finish before submitting another.",
      ],
    },
  );
});

test("an unknown owner is not grouped into an invented owner quota", () => {
  assert.deepEqual(
    admissionDecision(
      [inflight({ owner: null }), inflight({ owner: null })],
      { owner: null, submitter: "someone" },
    ),
    { refused: false },
  );
});

test("rate state defaults to the floor and reports actionable waits", () => {
  assert.deepEqual(rateDecision(null, AT), {
    refused: false,
    interval: 60,
    starts: 0,
  });

  for (const [seconds, detail] of [
    [61, "Please try again in 61 seconds."],
    [90, "Please try again in 2 minutes."],
    [5400, "Please try again in 2 hours."],
    [172800, "Please try again in 2 days."],
  ]) {
    assert.deepEqual(rateDecision({
      interval_seconds: 3600,
      starts: 3,
      next_allowed_at: new Date(AT + seconds * 1000).toISOString(),
    }, AT), {
      refused: true,
      status: 429,
      title: "You have hit a submission rate limit",
      detail: [detail],
    });
  }
});

test("an expired or reached deadline preserves the current backoff state", () => {
  for (const nextAllowedAt of [
    "2026-08-07T23:59:59Z",
    "2026-08-08T00:00:00Z",
  ]) {
    assert.deepEqual(rateDecision({
      interval_seconds: 3600,
      starts: 3,
      next_allowed_at: nextAllowedAt,
    }, AT), {
      refused: false,
      interval: 3600,
      starts: 3,
    });
  }
});

test("an accepted start gets one deterministic next rate record", () => {
  assert.deepEqual(nextRateRecord({
    login: "someone",
    starts: 0,
    interval: 60,
    startedAt: "2026-08-08T00:00:00Z",
    at: AT,
  }), {
    schema_version: 1,
    login: "someone",
    starts: 1,
    interval_seconds: 60,
    last_start_at: "2026-08-08T00:00:00Z",
    next_allowed_at: "2026-08-08T00:01:00Z",
  });
  assert.equal(nextRateRecord({
    login: "someone",
    starts: 1,
    interval: 60,
    startedAt: "2026-08-08T00:00:00Z",
    at: AT,
  }).interval_seconds, 120);
});

test("registration reset preserves rate history and returns to the floor", () => {
  assert.deepEqual(resetRateRecord({
    schema_version: 1,
    login: "someone",
    starts: 3,
    interval_seconds: 240,
    last_start_at: "2026-08-07T00:00:00Z",
    next_allowed_at: "2026-08-07T00:04:00Z",
  }, "2026-08-08T00:00:00Z"), {
    schema_version: 1,
    login: "someone",
    starts: 3,
    interval_seconds: 60,
    last_start_at: "2026-08-07T00:00:00Z",
    next_allowed_at: "2026-08-08T00:00:00Z",
  });
  assert.deepEqual(resetRateRecord(null, "2026-08-08T00:00:00Z"), {
    schema_version: 1,
    interval_seconds: 60,
    next_allowed_at: "2026-08-08T00:00:00Z",
  });
});
