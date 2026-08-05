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

test("a commit racing on the branch is retried, not shown to the submitter", async () => {
  // Every write commits to one branch, so two submissions a second apart, or a
  // submission and the reconciliation cron, collide. That is not a conflict
  // over anything anyone cares about, and it must not surface as an error.
  const attempts = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    if (method === "GET") return new Response("", { status: 404 }); // still absent
    attempts.push(method);
    if (attempts.length < 3) return new Response("conflict", { status: 409 });
    return Response.json({ content: {} });
  };
  const { writeState } = await import("../src/github.js");
  await writeState(ENV, "pending/abc.json", { a: 1 }, "create");
  assert.equal(attempts.length, 3, "the write should have been retried");
});

test("a real change to the file is a conflict and is not retried away", async () => {
  // The file we meant to update is not the file that is there now, so retrying
  // would overwrite whatever landed. The caller has to re-read and re-decide.
  let writes = 0;
  globalThis.fetch = async (url, init = {}) => {
    if ((init.method ?? "GET") === "GET") return Response.json({ sha: "somebody-elses-sha" });
    writes += 1;
    return new Response("conflict", { status: 409 });
  };
  const { writeState, GitHubError } = await import("../src/github.js");
  await assert.rejects(
    () => writeState(ENV, "submissions/x/state.json", { a: 1 }, "update", "the-sha-we-read"),
    (error) => error instanceof GitHubError && /state changed underneath/.test(error.message),
  );
  assert.equal(writes, 1, "a genuine conflict must not be retried");
});

test("a submitter is never left waiting on the retries", async () => {
  // Unbounded doubling would spend half a minute on the last attempt alone.
  const { writeState } = await import("../src/github.js");
  let writes = 0;
  globalThis.fetch = async (url, init = {}) => {
    if ((init.method ?? "GET") === "GET") return new Response("", { status: 404 });
    writes += 1;
    return new Response("conflict", { status: 409 });
  };
  const started = Date.now();
  await assert.rejects(() => writeState(ENV, "pending/abc.json", { a: 1 }, "create"));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 10_000, `retrying took ${elapsed}ms, which a submitter would feel`);
});

test("retrying gives up rather than hammering GitHub", async () => {
  let writes = 0;
  globalThis.fetch = async (url, init = {}) => {
    if ((init.method ?? "GET") === "GET") return new Response("", { status: 404 });
    writes += 1;
    return new Response("conflict", { status: 409 });
  };
  const { writeState } = await import("../src/github.js");
  await assert.rejects(() => writeState(ENV, "pending/abc.json", { a: 1 }, "create"));
  assert.ok(writes <= 10, `gave up after ${writes} attempts`);
  assert.ok(writes > 1, "it should have retried at least once");
});

test("an abandoned sign-in is discarded, and a fresh one is left alone", async () => {
  // A pending record holds what somebody typed. The ones nobody comes back for
  // are never consumed, so without this they accumulate for ever.
  const now = Date.parse("2026-08-05T12:00:00Z");
  const files = {
    "abandoned.json": { created_at: "2026-08-05T09:00:00Z" },
    "fresh.json": { created_at: "2026-08-05T11:59:00Z" },
    "undated.json": {},
  };
  const deleted = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    if (method === "DELETE") {
      deleted.push(path.split("/").pop());
      return Response.json({ ok: true });
    }
    if (path.endsWith("/contents/pending")) {
      return Response.json(
        Object.keys(files).map((name) => ({ name, type: "file", sha: `sha-${name}` })),
      );
    }
    const name = decodeURIComponent(path.split("/").pop());
    return Response.json({
      content: Buffer.from(JSON.stringify(files[name])).toString("base64"),
      sha: `sha-${name}`,
    });
  };
  const { sweepPending } = await import("../src/index.js");
  const removed = await sweepPending(ENV, now);
  assert.deepEqual(deleted.sort(), ["abandoned.json", "undated.json"]);
  assert.equal(removed, 2);
});

test("a commit that does not exist is answered, not treated as a fault", async () => {
  // GitHub answers 422 for a well-formed SHA it does not have, and 404 for a
  // malformed one. Both mean the same thing to a submitter.
  const { resolveCommit } = await import("../src/github.js");
  for (const status of [404, 422]) {
    globalThis.fetch = async () => new Response("no commit found", { status });
    assert.equal(await resolveCommit("t", "owner/name", "0".repeat(40)), null);
  }
  globalThis.fetch = async () => new Response("boom", { status: 500 });
  await assert.rejects(() => resolveCommit("t", "owner/name", "0".repeat(40)));
});
