/**
 * The decision endpoints: what the submitter can see, and what they must do
 * before anything about their submission becomes public.
 *
 * The state repository is stubbed at the fetch boundary, which is the only way
 * the Worker reaches durable state.
 */

import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";
import { statePath, tokenDigest } from "../src/submission.js";

const ENV = {
  STATE_REPO: "PalomarRegistry/PalomarSubmissionState",
  SITE_URL: "https://palomar-registry.org",
  GITHUB_TOKEN: "state-token",
  SUBMISSION_TOKEN: "dispatch-token",
  TOKEN_PEPPER: "test-pepper",
};

const TOKEN = "a".repeat(64);

function encode(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf-8").toString("base64");
}

/** A state repository held in memory, plus a log of what was written to it. */
function stubState(files, workflowRuns = null) {
  const written = [];
  const store = new Map(Object.entries(files));
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(url);
    if (target.pathname.includes("/actions/workflows/")) {
      return Response.json({ workflow_runs: workflowRuns ?? [] });
    }
    const path = decodeURI(
      target.pathname.replace(`/repos/${ENV.STATE_REPO}/contents/`, ""),
    );
    if ((init.method ?? "GET") === "GET") {
      if (!store.has(path)) return new Response("", { status: 404 });
      return Response.json({ content: encode(store.get(path)), sha: `sha-${path}` });
    }
    const body = JSON.parse(init.body);
    const value = JSON.parse(Buffer.from(body.content, "base64").toString("utf-8"));
    written.push({ path, value, sha: body.sha });
    store.set(path, value);
    return Response.json({ content: {} });
  };
  return { written, store };
}

async function fixture(overrides = {}) {
  const record = {
    schema_version: 1,
    id: "a1b2c3d4e5f6",
    status: "review-ready",
    repository: "example/project",
    commit: "1".repeat(40),
    owner: "example",
    submitter: "someone",
    push_verified: true,
    existing_id: null,
    context: null,
    authorization: { relationship: "maintainer" },
    created_at: "2026-08-01T00:00:00Z",
    run: { id: 12345 },
    review_sha256: "f".repeat(64),
    events: [],
    ...overrides,
  };
  return {
    [`index/tokens/${await tokenDigest(ENV, TOKEN)}.json`]: { id: record.id },
    [statePath(record.id, "state.json")]: record,
    [statePath(record.id, "review.json")]: {
      schema_version: 1,
      submission_id: record.id,
      decision: "accept",
      summary: "An example review.",
      scores: {},
      warnings: [],
      requested_changes: [],
      passes: [],
    },
  };
}

function request(path, method = "GET", cookie = `palomar_session=${TOKEN}`) {
  return new Request(`https://submit.palomar-registry.org${path}`, {
    method,
    headers: cookie ? { cookie } : {},
  });
}

test("the review is delivered only to whoever holds the access token", async () => {
  stubState(await fixture());
  const held = await worker.fetch(request("/api/review"), ENV);
  assert.equal(held.status, 200);
  assert.equal((await held.json()).decision, "accept");

  const anonymous = await worker.fetch(request("/api/review", "GET", ""), ENV);
  assert.equal(anonymous.status, 404);

  const wrongToken = await worker.fetch(
    request("/api/review", "GET", `palomar_session=${"b".repeat(64)}`),
    ENV,
  );
  assert.equal(wrongToken.status, 404);
});

test("publication consent is recorded, and only by the submitter", async () => {
  const { written } = stubState(await fixture());
  const response = await worker.fetch(request("/publish", "POST"), ENV);
  assert.equal(response.status, 200);
  const state = written.find((item) => item.path.endsWith("state.json"));
  assert.equal(state.value.publish_consent, true);
  assert.equal(state.value.publish_consent_review_sha256, "f".repeat(64));
  assert.match(state.value.publish_consent_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(state.sha, `sha-${statePath("a1b2c3d4e5f6", "state.json")}`);
});

test("consent cannot be given before there is a review to consent to", async () => {
  const { written } = stubState(await fixture({ status: "awaiting-review" }));
  const response = await worker.fetch(request("/publish", "POST"), ENV);
  assert.equal(response.status, 409);
  assert.equal(written.length, 0);
});

test("a withdrawn submission cannot then be published", async () => {
  const { written } = stubState(await fixture({ status: "withdrawn" }));
  const response = await worker.fetch(request("/publish", "POST"), ENV);
  assert.equal(response.status, 409);
  assert.equal(written.length, 0);
});

test("consent is not forged by an anonymous request", async () => {
  const { written } = stubState(await fixture());
  const response = await worker.fetch(request("/publish", "POST", ""), ENV);
  assert.equal(response.status, 404);
  assert.equal(written.length, 0);
});

test("consent is refused when no review has been delivered", async () => {
  // Consent is to a particular review. A record in review-ready state that
  // carries no delivered digest is not something anyone can consent to.
  const { written } = stubState(await fixture({ review_sha256: undefined }));
  const response = await worker.fetch(request("/publish", "POST"), ENV);
  assert.equal(response.status, 409);
  assert.equal(written.length, 0);
});

test("the status feed never carries the submitter or the review", async () => {
  stubState(await fixture());
  const response = await worker.fetch(request("/api/submission"), ENV);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.ok(!body.includes("someone"), "the submitter's login must not be echoed");
  assert.ok(!body.includes("An example review"), "the review must not ride along");
});

test("the verification run is pinned once, and a later namesake cannot take it", async () => {
  // The submission id is public: it is in the run name. A second run carrying
  // it must not be able to become the run this submission is judged on.
  const { written } = stubState(
    await fixture({ status: "verifying", run: { id: 12345 } }),
    [{
      id: 99999,
      name: "Verify submission a1b2c3d4e5f6",
      status: "completed",
      conclusion: "success",
      html_url: "https://github.com/PalomarRegistry/PalomarSubmission/actions/runs/99999",
      run_started_at: "2026-08-01T00:00:00Z",
    }],
  );
  const response = await worker.fetch(request("/api/submission"), ENV);
  const body = await response.json();
  assert.equal(body.run.id, 12345);
  assert.equal(body.status, "verifying");
  assert.equal(written.length, 0, "a namesake run must not rewrite the record");
});

test("a run whose name merely quotes the submission id is not this submission's", async () => {
  const { written } = stubState(
    await fixture({ status: "verifying", run: undefined }),
    [{
      id: 99999,
      name: "Verify submission a1b2c3d4e5f6 (rerun)",
      status: "completed",
      conclusion: "success",
      html_url: "https://github.com/PalomarRegistry/PalomarSubmission/actions/runs/99999",
      run_started_at: "2026-08-01T00:00:00Z",
    }],
  );
  const response = await worker.fetch(request("/api/submission"), ENV);
  assert.equal((await response.json()).status, "verifying");
  assert.equal(written.length, 0);
});

test("the state token never reaches the submission repository, and vice versa", async () => {
  // A fine-grained token grants the same permissions everywhere it reaches, so
  // the two are separate on purpose. Sending either to the other's repository
  // would quietly restore the single over-privileged token.
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push({
      host: new URL(url).pathname,
      token: (init.headers?.authorization ?? "").replace("Bearer ", ""),
    });
    if (new URL(url).pathname.includes("/actions/workflows/")) {
      return Response.json({ workflow_runs: [] });
    }
    return new Response("", { status: 404 });
  };
  const env = { ...ENV, SUBMISSION_REPO: "PalomarRegistry/PalomarSubmission",
                VERIFY_WORKFLOW: "submission.yml" };
  const { dispatchVerification, findVerificationRun, readState, writeState } =
    await import("../src/github.js");
  await findVerificationRun(env, "a1b2c3d4e5f6");
  await readState(env, "submissions/a1b2c3d4e5f6/state.json");
  await dispatchVerification(env, {
    repositoryName: "example/project", commit: "1".repeat(40),
    requestId: "a1b2c3d4e5f6", options: {},
  }).catch(() => {});
  await writeState(env, "submissions/a1b2c3d4e5f6/state.json", {}, "m").catch(() => {});

  for (const call of seen) {
    if (call.host.includes("PalomarSubmission/")) {
      assert.equal(call.token, "dispatch-token", "the state token must not reach verification");
    }
    if (call.host.includes("PalomarSubmissionState")) {
      assert.equal(call.token, "state-token", "the dispatch token must not reach the record");
    }
  }
  assert.ok(
    seen.some((call) => call.host.includes("/actions/workflows/")),
    "the dispatch path must be exercised",
  );
  assert.ok(
    seen.some((call) => call.host.includes("PalomarSubmissionState/contents")),
    "the state path must be exercised",
  );
});
