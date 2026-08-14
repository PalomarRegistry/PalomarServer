import assert from "node:assert/strict";
import test from "node:test";

import {
  admissionDecision,
  IDENTIFYING_FIELDS,
  nextRateRecord,
  RateContractError,
  rateDecision,
  rateRecord,
  resetRateRecord,
} from "../src/admission-contract.js";

const AT = Date.parse("2026-08-08T00:00:00Z");

function inflight(overrides = {}) {
  return { owner: "another-owner", submitter: "another-submitter", ...overrides };
}

function rate(overrides = {}) {
  return {
    schema_version: 1,
    starts: 3,
    interval_seconds: 3600,
    last_start_at: "2026-08-07T23:00:00Z",
    next_allowed_at: "2026-08-08T01:00:00Z",
    ...overrides,
  };
}

test("admission allows a submission below every cap", () => {
  assert.deepEqual(
    admissionDecision([inflight()], { owner: "example", submitter: "someone" }),
    { refused: false },
  );
});

test("unrelated submitters cannot exhaust a global capacity", () => {
  const open = Array.from({ length: 1_000 }, (_, index) => inflight({
    owner: `owner${index}`,
    submitter: `user${index}`,
  }));
  assert.deepEqual(
    admissionDecision(open, { owner: "new-owner", submitter: "new-submitter" }),
    { refused: false },
  );
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
      [inflight({ submitter: "someone" })],
      { owner: "example", submitter: "someone" },
    ),
    {
      refused: true,
      status: 429,
      title: "You already have submissions in flight",
      detail: [
        "Palomar verifies at most one submission at a time from one submitter.",
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
    [1, "Please try again in 1 second."],
    [61, "Please try again in 61 seconds."],
    [90, "Please try again in 2 minutes."],
    [5400, "Please try again in 2 hours."],
    [172800, "Please try again in 2 days."],
  ]) {
    assert.deepEqual(rateDecision(rate({
      next_allowed_at: new Date(AT + seconds * 1000).toISOString().replace(/\.\d+Z$/, "Z"),
    }), AT), {
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
    assert.deepEqual(rateDecision(rate({ next_allowed_at: nextAllowedAt }), AT), {
      refused: false,
      interval: 3600,
      starts: 3,
    });
  }
});

test("present rate state has one strict current contract", () => {
  const malformed = [
    [null, /JSON object/],
    [[], /JSON object/],
    [rate({ schema_version: 2 }), /schema_version/],
    // A login is no longer written, but one that is present is still held to
    // being a login, because a document nobody understands is not a document
    // to admit on.
    [rate({ login: "" }), /login/],
    [rate({ login: "not a login" }), /login/],
    [rate({ login: 42 }), /login/],
    [rate({ login: null }), /login/],
    [rate({ starts: "3" }), /starts/],
    [rate({ starts: 0 }), /starts/],
    [rate({ interval_seconds: "3600" }), /interval_seconds/],
    [rate({ interval_seconds: 59 }), /interval_seconds/],
    [rate({ last_start_at: "yesterday" }), /last_start_at/],
    [rate({ next_allowed_at: "2026-02-30T00:00:00Z" }), /next_allowed_at/],
    [rate({ next_allowed_at: "2026-08-07T22:59:59Z" }), /must not precede/],
  ];
  for (const [value, message] of malformed) {
    assert.throws(
      () => rateRecord(value),
      (error) => error instanceof RateContractError && message.test(error.message),
    );
  }

  const extended = rate({ producer_extension: { retained: true } });
  assert.equal(rateRecord(extended).value, extended);

  // Documents written before the Server stopped recording identity are still
  // read, so a deployment does not lock out everybody who already had a
  // backoff. `submission_ids` is the other one: it was a rate-document field
  // until the principal locator took it over, and the documents that still
  // carry it were never rewritten.
  for (const legacy of [
    rate({ login: "someone" }),
    rate({ submission_ids: ["abcdefghijkl"] }),
    rate({ login: "someone", submission_ids: ["abcdefghijkl"] }),
  ]) {
    assert.equal(rateRecord(legacy).value, legacy);
  }
});

test("an unrepresentable next deadline fails before it can be written", () => {
  assert.throws(
    () => nextRateRecord({
      starts: 20,
      interval: Number.MAX_SAFE_INTEGER,
      startedAt: "2026-08-08T00:00:00Z",
      at: AT,
    }),
    (error) => error instanceof RateContractError && /next interval_seconds/.test(error.message),
  );
});

test("an accepted start gets one deterministic next rate record", () => {
  // Nothing here identifies the submitter. The file name already does, to
  // whoever holds the pepper, and to nobody else.
  assert.deepEqual(nextRateRecord({
    starts: 0,
    interval: 60,
    startedAt: "2026-08-08T00:00:00Z",
    at: AT,
  }), {
    schema_version: 1,
    starts: 1,
    interval_seconds: 60,
    last_start_at: "2026-08-08T00:00:00Z",
    next_allowed_at: "2026-08-08T00:01:00Z",
  });
  assert.equal(nextRateRecord({
    starts: 1,
    interval: 60,
    startedAt: "2026-08-08T00:00:00Z",
    at: AT,
  }).interval_seconds, 120);
});

test("registration reset preserves rate history and returns to the floor", () => {
  assert.deepEqual(resetRateRecord({
    schema_version: 1,
    starts: 3,
    interval_seconds: 240,
    last_start_at: "2026-08-07T00:00:00Z",
    next_allowed_at: "2026-08-07T00:04:00Z",
  }, "2026-08-08T00:00:00Z"), {
    schema_version: 1,
    starts: 3,
    interval_seconds: 60,
    last_start_at: "2026-08-07T00:00:00Z",
    next_allowed_at: "2026-08-08T00:00:00Z",
  });
  assert.throws(
    () => resetRateRecord(null, "2026-08-08T00:00:00Z"),
    RateContractError,
  );
});

test("a reset sheds every identifying field an older document left", () => {
  // The spread that preserves history would otherwise carry these forward
  // forever, so ordinary registration traffic is what retires those bodies.
  const reset = resetRateRecord({
    schema_version: 1,
    login: "someone",
    submission_ids: ["abcdefghijkl"],
    starts: 3,
    interval_seconds: 240,
    last_start_at: "2026-08-07T00:00:00Z",
    next_allowed_at: "2026-08-07T00:04:00Z",
    producer_extension: { retained: true },
  }, "2026-08-08T00:00:00Z");
  for (const field of IDENTIFYING_FIELDS) {
    assert.equal(Object.hasOwn(reset, field), false, `${field} survived a reset`);
  }
  // Everything the document held that does not name the submitter is still
  // opaque to this contract and still preserved.
  assert.deepEqual(reset, {
    schema_version: 1,
    starts: 3,
    interval_seconds: 60,
    last_start_at: "2026-08-07T00:00:00Z",
    next_allowed_at: "2026-08-08T00:00:00Z",
    producer_extension: { retained: true },
  });
});
