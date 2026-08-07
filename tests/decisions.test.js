/**
 * The decision endpoints: what the submitter can see, and what they must do
 * before anything about their submission becomes public.
 *
 * The state repository is stubbed at the fetch boundary, which is the only way
 * the Worker reaches durable state.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
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

async function fixture(overrides = {}, reviewOverrides = {}) {
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
      schema_version: 2,
      submission_id: record.id,
      decision: "accept",
      summary: "An example review.",
      scores: {},
      warnings: [],
      requested_changes: [],
      passes: [],
      ...reviewOverrides,
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

test("registration consent is recorded, and only by the submitter", async () => {
  const { written } = stubState(await fixture());
  const response = await worker.fetch(request("/register", "POST"), ENV);
  assert.equal(response.status, 200);
  const state = written.find((item) => item.path.endsWith("state.json"));
  assert.equal(state.value.registration_consent, true);
  assert.equal(state.value.registration_consent_review_sha256, "f".repeat(64));
  assert.match(state.value.registration_consent_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(state.sha, `sha-${statePath("a1b2c3d4e5f6", "state.json")}`);
});

test("consent cannot be given before there is a review to consent to", async () => {
  const { written } = stubState(await fixture({ status: "awaiting-review" }));
  const response = await worker.fetch(request("/register", "POST"), ENV);
  assert.equal(response.status, 409);
  assert.equal(written.length, 0);
});

test("only an accepted review can be registered", async () => {
  for (const decision of ["revise", "reject"]) {
    const { written } = stubState(await fixture({}, { decision }));
    const response = await worker.fetch(request("/register", "POST"), ENV);
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /only an accepted review/);
    assert.equal(written.length, 0);
  }
});

test("an obsolete review must be rerun before delivery or registration", async () => {
  const old = await fixture({}, { schema_version: 1 });
  stubState(old);
  const delivery = await worker.fetch(request("/api/review"), ENV);
  assert.equal(delivery.status, 409);
  assert.match((await delivery.json()).error, /must be rerun/);

  const { written } = stubState(old);
  const registration = await worker.fetch(request("/register", "POST"), ENV);
  assert.equal(registration.status, 409);
  assert.match((await registration.json()).error, /must be rerun/);
  assert.equal(written.length, 0);
});

test("the status page explains an obsolete review and keeps polling for its rerun", async () => {
  const script = await readFile(new URL("../public/status.js", import.meta.url), "utf8");
  assert.match(script, /response\.status === 409/);
  assert.match(script, /earlier review contract and has to be rerun/);
  assert.match(script, /&& !reviewNeedsRerun/);
});

test("an unknown review decision is not delivered", async () => {
  stubState(await fixture({}, { decision: "unknown" }));
  const response = await worker.fetch(request("/api/review"), ENV);
  assert.equal(response.status, 409);
});

test("a withdrawn submission cannot then be registered", async () => {
  const { written } = stubState(await fixture({ status: "withdrawn" }));
  const response = await worker.fetch(request("/register", "POST"), ENV);
  assert.equal(response.status, 409);
  assert.equal(written.length, 0);
});

test("consent is not forged by an anonymous request", async () => {
  const { written } = stubState(await fixture());
  const response = await worker.fetch(request("/register", "POST", ""), ENV);
  assert.equal(response.status, 404);
  assert.equal(written.length, 0);
});

test("consent is refused when no review has been delivered", async () => {
  // Consent is to a particular review. A record in review-ready state that
  // carries no delivered digest is not something anyone can consent to.
  const { written } = stubState(await fixture({ review_sha256: undefined }));
  const response = await worker.fetch(request("/register", "POST"), ENV);
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

test("the session exchange actually sets the cookie it promises", async () => {
  // json() took two parameters, so the third argument, the cookie, was
  // silently discarded: /session answered 200 and set nothing, and every later
  // request was unauthenticated. The submitter saw "could not be found" on a
  // submission that existed and was theirs.
  stubState(await fixture());
  const response = await worker.fetch(
    new Request("https://submit.palomar-registry.org/session", {
      method: "POST",
      body: new URLSearchParams({ token: TOKEN }),
    }),
    ENV,
  );
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie, "no cookie was set");
  assert.match(cookie, new RegExp(`palomar_session=${TOKEN}`));
  for (const attribute of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) {
    assert.match(cookie, new RegExp(attribute), `cookie lacks ${attribute}`);
  }
});

test("the cookie the exchange sets is the one the status page is read with", async () => {
  // The property that matters is the round trip, not the header: exchange a
  // token, then use nothing but what came back.
  stubState(await fixture());
  const exchange = await worker.fetch(
    new Request("https://submit.palomar-registry.org/session", {
      method: "POST",
      body: new URLSearchParams({ token: TOKEN }),
    }),
    ENV,
  );
  const cookie = exchange.headers.get("set-cookie").split(";")[0];
  const status = await worker.fetch(
    new Request("https://submit.palomar-registry.org/api/submission", { headers: { cookie } }),
    ENV,
  );
  assert.equal(status.status, 200, "the cookie from /session did not authenticate /api/submission");
  assert.equal((await status.json()).id, "a1b2c3d4e5f6");
});

test("a redirect carries the fragment the submitter needs", async () => {
  // The access token rides in the fragment. If the platform dropped it, the
  // submitter would land on a status page with no way to identify themselves.
  const redirect = Response.redirect("https://submit.palomar-registry.org/s#" + TOKEN, 303);
  assert.equal(redirect.headers.get("location"), `https://submit.palomar-registry.org/s#${TOKEN}`);
});

test("the page keeps asking while anything is still moving", async () => {
  // It only re-polled while verifying, so once verification passed the page
  // sat on "waiting for the automated review" and never showed the review.
  const script = await readFile(new URL("../public/status.js", import.meta.url), "utf8");
  const settled = /const SETTLED = new Set\(\[([^\]]*)\]\)/.exec(script)[1];
  for (const moving of ["verifying", "awaiting-review", "reviewing"]) {
    assert.ok(!settled.includes(moving), `${moving} must not be treated as settled`);
  }
  for (const done of ["registered", "withdrawn", "verification-failed"]) {
    assert.ok(settled.includes(done), `${done} should stop the polling`);
  }
});

test("a duration is only claimed once one has been measured", async () => {
  // With nothing recorded the page says nothing about how long a review takes,
  // rather than showing a figure nobody measured.
  stubState(await fixture());
  const empty = await worker.fetch(request("/api/submission"), ENV);
  assert.equal((await empty.json()).typical_review_seconds, null);

  const withTiming = await fixture();
  withTiming["index/review-timing.json"] = { schema_version: 1, seconds: [200, 400, 300] };
  stubState(withTiming);
  const measured = await worker.fetch(request("/api/submission"), ENV);
  assert.equal((await measured.json()).typical_review_seconds, 300, "the median of what was measured");
});

test("an event never claims a status the submission cannot be in", async () => {
  // Reconciliation stamped its events "reconciled", which is not a status
  // anything else recognises, so the timeline disagreed with the record.
  const { STATUSES } = await import("../src/submission.js");
  const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  const stamped = [...source.matchAll(/\{ at: now\(\), status: "([a-z-]+)"/g)].map((m) => m[1]);
  for (const status of stamped) {
    assert.ok(status in STATUSES, `an event claims the status "${status}", which does not exist`);
  }
});

test("a duration is written the way a person would say it", async () => {
  // The page said "about 1 seconds", which is two faults at once: the
  // plural, and a figure that came from a test rather than a review.
  const script = await readFile(new URL("../public/status.js", import.meta.url), "utf8");
  const duration = new Function(
    script.slice(script.indexOf("function duration"), script.indexOf("let reviewShown")) +
      "; return duration;",
  )();
  assert.equal(duration(1), "1 second");
  assert.equal(duration(2), "2 seconds");
  assert.equal(duration(90), "2 minutes");
  assert.equal(duration(60), "60 seconds");
  assert.equal(duration(3600), "60 minutes");
  assert.doesNotMatch(duration(1), /1 seconds/);
});

test("the reviewer is asked to run the moment there is work", async () => {
  // The schedule is best-effort: it went hours without firing and a submission
  // sat ready with nothing looking at it. Waiting for a cron is not a plan.
  const dispatched = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path.includes("/actions/workflows/reviewer.yml/dispatches")) {
      dispatched.push(path);
      return new Response("", { status: 204 });
    }
    if (path.includes("/actions/workflows/")) {
      return Response.json({
        workflow_runs: [{
          id: 12345, name: "Verify submission a1b2c3d4e5f6", status: "completed",
          conclusion: "success", html_url: "https://example.test/run",
          run_started_at: "2026-08-01T00:00:00Z",
        }],
      });
    }
    if ((init.method ?? "GET") !== "GET") return Response.json({ content: {} });
    if (!store.has(path)) return new Response("", { status: 404 });
    return Response.json({ content: encode(store.get(path)), sha: "sha" });
  };
  const files = await fixture({ status: "verifying" });
  const store = new Map(
    Object.entries(files).map(([k, v]) => [`/repos/${ENV.STATE_REPO}/contents/${k}`, v]),
  );
  const env = { ...ENV, SUBMISSION_REPO: "PalomarRegistry/PalomarSubmission",
                VERIFY_WORKFLOW: "submission.yml", REVIEW_WORKFLOW: "reviewer.yml" };
  await worker.fetch(request("/api/submission"), env);
  assert.equal(dispatched.length, 1, "verification finishing did not ask for a review");
});

test("a submission that is not ready does not ask for a review", async () => {
  const dispatched = [];
  globalThis.fetch = async (url) => {
    if (new URL(url).pathname.includes("reviewer.yml/dispatches")) dispatched.push(url);
    return new Response("", { status: 404 });
  };
  const env = { ...ENV, REVIEW_WORKFLOW: "reviewer.yml" };
  stubState(await fixture({ status: "review-ready" }));
  await worker.fetch(request("/api/submission"), env);
  assert.deepEqual(dispatched, []);
});

/**
 * Drive the verification-just-finished transition, which is the one that asks
 * for a review, and hand back what the dispatch was called with.
 */
async function dispatchOnVerificationSuccess(dispatchResponse) {
  const bodies = [];
  const files = await fixture({ status: "verifying" });
  const store = new Map(
    Object.entries(files).map(([k, v]) => [`/repos/${ENV.STATE_REPO}/contents/${k}`, v]),
  );
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path.includes("/actions/workflows/reviewer.yml/dispatches")) {
      bodies.push(init.body);
      return dispatchResponse();
    }
    if (path.includes("/actions/workflows/")) {
      return Response.json({
        workflow_runs: [{
          id: 12345, name: "Verify submission a1b2c3d4e5f6", status: "completed",
          conclusion: "success", html_url: "https://example.test/run",
          run_started_at: "2026-08-01T00:00:00Z",
        }],
      });
    }
    if ((init.method ?? "GET") !== "GET") return Response.json({ content: {} });
    if (!store.has(path)) return new Response("", { status: 404 });
    return Response.json({ content: encode(store.get(path)), sha: "sha" });
  };
  const env = { ...ENV, SUBMISSION_REPO: "PalomarRegistry/PalomarSubmission",
                VERIFY_WORKFLOW: "submission.yml", REVIEW_WORKFLOW: "reviewer.yml" };
  const response = await worker.fetch(request("/api/submission"), env);
  return { bodies, response };
}

test("a rejected dispatch is logged and does not fail the submitter's request", async () => {
  // Every caller swallows the result, because the backstop schedule picks the
  // submission up anyway. That is exactly what would make a dispatch that
  // always fails — an expired or under-scoped token — invisible: without this
  // log the backstop silently becomes the whole drive train.
  const warned = [];
  const warn = console.warn;
  console.warn = (...args) => warned.push(args);
  let outcome;
  try {
    outcome = await dispatchOnVerificationSuccess(() => new Response("", { status: 403 }));
  } finally {
    console.warn = warn;
  }
  assert.equal(outcome.response.status, 200, "a failed dispatch must not fail the poll");
  assert.equal(warned.length, 1, "a rejected dispatch was not logged");
  assert.ok(warned[0].includes(403), `the status is the whole point: ${warned[0]}`);
});

test("the dispatch carries only a ref, so every reviewer input needs a default", async () => {
  // GitHub fills omitted workflow_dispatch inputs from the defaults declared in
  // the workflow file. reviewer.yml may therefore add inputs freely, but one
  // without a default would be unreachable from here, and the server could not
  // tell: it swallows the result.
  const { bodies } = await dispatchOnVerificationSuccess(
    () => new Response("", { status: 204 }),
  );
  assert.equal(bodies.length, 1, "verification finishing did not ask for a review");
  assert.deepEqual(JSON.parse(bodies[0]), { ref: "main" });
});
