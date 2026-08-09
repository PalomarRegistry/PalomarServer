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
import { digest, statePath, tokenDigest } from "../src/submission.js";

const ENV = {
  STATE_REPO: "PalomarRegistry/PalomarSubmissionState",
  SITE_URL: "https://palomar-registry.org",
  GITHUB_TOKEN: "state-token",
  SUBMISSION_TOKEN: "dispatch-token",
  TOKEN_PEPPER: "test-pepper",
  OAUTH_CLIENT_ID: "client-id",
  OAUTH_CLIENT_SECRET: "client-secret",
  // Declared in wrangler.jsonc, so production always has one. Intake refuses
  // without it, and a test env lacking it would exercise that refusal instead
  // of whatever the test is about.
  INTAKE_LIMITER: { limit: async () => ({ success: true }) },
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
    // A pinned run is asked for by id rather than searched for by name.
    const byId = /\/actions\/runs\/(\d+)$/.exec(target.pathname);
    if (byId) {
      const run = (workflowRuns ?? []).find((item) => String(item.id) === byId[1]);
      return run ? Response.json(run) : new Response("", { status: 404 });
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
    "index/inflight.json": { open: [] },
    "index/open.json": { schema_version: 1, open: [] },
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

// What a browser on Palomar's own pages sends. The mutating endpoints refuse a
// cookie that did not come from this site, so a helper that omitted this would
// be testing the refusal rather than the endpoint.
function request(path, method = "GET", cookie = `__Host-palomar_session=${TOKEN}`, extra = {}) {
  return new Request(`https://submit.palomar-registry.org${path}`, {
    method,
    headers: { "sec-fetch-site": "same-origin", ...(cookie ? { cookie } : {}), ...extra },
    // Registration says which review it is consenting to. The fixture's review
    // digest is the one the page would have been shown.
    ...(path === "/register" && method === "POST"
      ? { body: JSON.stringify({ review_sha256: "f".repeat(64) }) }
      : {}),
  });
}

test("the review is delivered only to whoever holds the access token", async () => {
  stubState(await fixture());
  const held = await worker.fetch(request("/api/review"), ENV);
  assert.equal(held.status, 200);
  assert.equal((await held.json()).passed, true);

  const anonymous = await worker.fetch(request("/api/review", "GET", ""), ENV);
  assert.equal(anonymous.status, 404);

  const wrongToken = await worker.fetch(
    request("/api/review", "GET", `__Host-palomar_session=${"b".repeat(64)}`),
    ENV,
  );
  assert.equal(wrongToken.status, 404);
});

test("the submitter review exposes only a binary outcome and useful prose", async () => {
  for (const [decision, passed] of [["accept", true], ["revise", false], ["reject", false]]) {
    stubState(await fixture({}, {
      decision,
      scores: { notability: 4 },
      warnings: ["Useful context.", "A substantive criticism."],
      passes: [{ scores: { notability: 4 }, findings: [{ severity: "info" }] }],
    }));
    const response = await worker.fetch(request("/api/review"), ENV);
    assert.equal(response.status, 200);
    const delivered = await response.json();
    assert.deepEqual(delivered.comments, ["Useful context.", "A substantive criticism."]);
    assert.equal(delivered.passed, passed);
    assert.equal(Object.hasOwn(delivered, "decision"), false);
    assert.equal(Object.hasOwn(delivered, "scores"), false);
    assert.equal(Object.hasOwn(delivered, "passes"), false);
  }
});

test("the review route composes the public projection with its reviewed digest", async () => {
  stubState(await fixture({ review_sha256: "e".repeat(64) }, {
    summary: "Ready to register.",
    warnings: undefined,
    requested_changes: undefined,
    reviewed_at: "2026-08-01T00:00:00Z",
    reviewer_models: undefined,
  }));

  const response = await worker.fetch(request("/api/review"), ENV);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    passed: true,
    summary: "Ready to register.",
    comments: [],
    requested_changes: [],
    reviewed_at: "2026-08-01T00:00:00Z",
    reviewer_models: [],
    review_sha256: "e".repeat(64),
  });
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

test("a submission whose review could not be completed is still the submitter's to withdraw", async () => {
  // `review-failed` is a fault at this end. The page stops asking about it,
  // because nothing moves it without an operator, and that is the whole reason
  // somebody might reasonably decide it belongs in the set the server refuses
  // to act on. It does not: the submitter is left with a submission that is
  // going nowhere and no way to take it back.
  const files = await fixture({ status: "review-failed" });
  // This record no longer holds a slot. An unrelated damaged capacity index
  // must not take away the submitter's last way to stop it.
  files["index/inflight.json"] = { open: "damaged" };
  const { written } = stubState(files);
  const inner = globalThis.fetch;
  let inflightReads = 0;
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(url);
    if ((init.method ?? "GET") === "GET" && target.pathname.endsWith("/index/inflight.json")) {
      inflightReads += 1;
    }
    return inner(url, init);
  };
  const response = await worker.fetch(request("/withdraw", "POST"), ENV);
  assert.equal(response.status, 200);
  const state = written.find((item) => item.path.endsWith("state.json"));
  assert.equal(state.value.status, "withdrawn");
  assert.equal(state.value.events.at(-1).note, "Withdrawn by the submitter");
  assert.equal(inflightReads, 0, "a record without a slot consulted unrelated capacity state");
  assert.deepEqual(
    written.map((item) => item.path),
    [statePath("a1b2c3d4e5f6", "state.json")],
    "withdrawal changed capacity state for a record that held no slot",
  );
});

test("withdrawal validates the inflight reservation before changing the record", async () => {
  const files = await fixture({ status: "verifying" });
  files["index/inflight.json"] = { open: "damaged" };
  const { written } = stubState(files);

  const response = await worker.fetch(request("/withdraw", "POST"), ENV);
  assert.equal(response.status, 503);
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.deepEqual(await response.json(), {
    error: "submission decisions are temporarily unavailable",
  });
  assert.deepEqual(written, [], "the record was withdrawn before capacity state was validated");
});

test("withdrawing a verifying submission commits the decision before releasing its slot", async () => {
  const held = {
    id: "a1b2c3d4e5f6",
    owner: "example",
    submitter: "someone",
    at: "2026-08-01T00:00:00Z",
  };
  const files = await fixture({ status: "verifying" });
  files["index/inflight.json"] = { open: [held] };
  const { written, store } = stubState(files);

  const response = await worker.fetch(request("/withdraw", "POST"), ENV);
  assert.equal(response.status, 200);
  assert.equal(store.get(statePath(held.id, "state.json")).status, "withdrawn");
  assert.deepEqual(store.get("index/inflight.json"), { open: [] });
  assert.deepEqual(
    written.map((item) => item.path),
    [statePath(held.id, "state.json"), "index/inflight.json"],
  );
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

test("the health check says whether the service is up and nothing else", async () => {
  // It named the state repository, which is private and holds every record and
  // every pending intake. Anyone at all could ask an unauthenticated endpoint
  // for the name of the thing worth attacking.
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("health check reached the shared GitHub API budget");
  };
  for (const method of ["GET", "HEAD"]) {
    const response = await worker.fetch(request("/healthz", method), ENV);
    assert.equal(response.status, 200, `${method} did not answer`);
  }
  const body = await (await worker.fetch(request("/healthz"), ENV)).json();
  assert.deepEqual(body, { ok: true });
  assert.equal(networkCalls, 0);
  assert.ok(!JSON.stringify(body).includes("PalomarSubmissionState"),
            "the health check still names the state repository");
});

test("a health check sent as anything but a read is no such page", async () => {
  // Every other route matches on the method and lets the rest fall through to
  // the 404. This one answered POST, PUT and DELETE alike.
  stubState(await fixture());
  for (const method of ["POST", "PUT", "DELETE"]) {
    const response = await worker.fetch(request("/healthz", method), ENV);
    assert.equal(response.status, 404, `${method} was answered by the health check`);
  }
});

test("a body the form endpoints cannot read is not reported as Palomar's fault", async () => {
  // `formData()` throws on a JSON body. The throw reached the handler's catch,
  // so posting JSON to either of these got a 500 HTML page saying Palomar had
  // had a bad moment and to try again shortly: not true, not the sender's
  // problem as stated, and a retry that could only fail the same way.
  for (const path of ["/session", "/submit"]) {
    stubState(await fixture());
    const response = await worker.fetch(
      new Request(`https://submit.palomar-registry.org${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
        body: JSON.stringify({ token: TOKEN, repository: "example/project" }),
      }),
      ENV,
    );
    assert.equal(response.status, 400, `${path} did not say the body was the problem`);
    assert.match(response.headers.get("content-type"), /application\/json/,
                 `${path} answered with a page`);
    assert.match((await response.json()).error, /could not be read|as a form/,
                 `${path} did not say what was wrong`);
  }
});

test("a well-formed form body is still read exactly as it was", async () => {
  // The guard above must not have changed what happens to the bodies that
  // parse: /session still exchanges a form for a cookie.
  stubState(await fixture());
  const response = await worker.fetch(
    new Request("https://submit.palomar-registry.org/session", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
      body: new URLSearchParams({ token: TOKEN }),
    }),
    ENV,
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), new RegExp(`__Host-palomar_session=${TOKEN}`));
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

test("a present empty or non-inline state file is not mistaken for a missing file", async () => {
  const { readState } = await import("../src/github.js");
  for (const responseBody of [
    { sha: "empty", content: "" },
    { sha: "not-inline", encoding: "none" },
  ]) {
    globalThis.fetch = async () => Response.json(responseBody);
    await assert.rejects(
      () => readState(ENV, "index/rate/example.json"),
      SyntaxError,
    );
  }

  globalThis.fetch = async () => new Response("", { status: 404 });
  assert.deepEqual(await readState(ENV, "index/rate/example.json"), {
    value: null,
    sha: null,
  });
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
  globalThis.fetch = async (url, init = {}) => {
    if ((init.method ?? "GET") === "GET") return new Response("", { status: 404 });
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

test("a pending directory too long to list is refused, not half-swept", async () => {
  // The contents API answers at most a thousand entries for one directory, and
  // a listing of exactly that length cannot be told apart from a truncated one.
  // Swept quietly, the sweep would report having tidied up while the part it
  // never saw grew without bound, and every record it holds is something
  // somebody typed.
  const deleted = [];
  globalThis.fetch = async (url, init = {}) => {
    if ((init.method ?? "GET") === "DELETE") {
      deleted.push(new URL(url).pathname);
      return Response.json({ ok: true });
    }
    return Response.json(
      Array.from({ length: 1000 }, (_, index) => ({
        name: `${index}.json`, type: "file", sha: `sha-${index}`,
      })),
    );
  };
  const { sweepPending } = await import("../src/index.js");
  await assert.rejects(() => sweepPending(ENV), /at or past the 1000/);
  assert.deepEqual(deleted, []);
});

test("a scheduled pass that could not do its work does not report success", async () => {
  // Nobody is waiting on a cron and nothing reads its response, so a throw here
  // was invisible: admission slots stopped being freed and abandoned intake
  // stopped being discarded, and the first sign of it was intake wedging some
  // hours later.
  const swept = [];
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/contents/index/inflight.json")) throw new TypeError("network down");
    swept.push(path);
    return new Response("", { status: 404 });
  };
  await assert.rejects(() => worker.scheduled({}, ENV), /reconcile/);
  // And the other half of the pass still ran: one failing task must not take
  // the tasks that would have succeeded down with it.
  assert.ok(swept.some((path) => path.endsWith("/contents/pending")),
            "the pending sweep never ran");
});

test("the inflight index refuses obsolete and malformed shapes", async () => {
  const { reconcile } = await import("../src/index.js");
  const current = {
    id: "a1b2c3d4e5f6",
    owner: "example",
    submitter: "someone",
    at: "2026-08-01T00:00:00Z",
  };
  const cases = [
    [{ open: [{ id: current.id, owner: current.owner, at: current.at }] },
      /must contain exactly id, owner, submitter, and at/],
    [{ open: [{ ...current, obsolete: true }] },
      /must contain exactly id, owner, submitter, and at/],
    [{ open: [{ ...current, id: "A1B2C3D4E5F6" }] },
      /id must be a 12-character submission id/],
    [{ open: [{ ...current, id: 123456789012 }] },
      /id must be a 12-character submission id/],
    [{ open: [{ ...current, owner: "example.name" }] },
      /owner must be a GitHub login or null/],
    [{ open: [{ ...current, submitter: "a".repeat(40) }] },
      /submitter must be a GitHub login/],
    [{ open: [{ ...current, submitter: null }] },
      /submitter must be a GitHub login/],
    [{ open: [{ ...current, at: "yesterday" }] },
      /at must be a canonical UTC-seconds timestamp/],
    [{ open: [{ ...current, at: "2026-08-01T00:00:00.000Z" }] },
      /at must be a canonical UTC-seconds timestamp/],
    [{ open: [{ ...current, at: "2026-02-30T00:00:00Z" }] },
      /at must be a canonical UTC-seconds timestamp/],
    [{ open: [current, { ...current }] }, /duplicates another inflight submission/],
    [{ open: [], schema_version: 1 }, /exactly one top-level open array/],
    [{ open: {} }, /exactly one top-level open array/],
    [null, /exactly one top-level open array/],
  ];

  for (const [value, message] of cases) {
    stubState(value === null ? {} : { "index/inflight.json": value }, []);
    await assert.rejects(() => reconcile(ENV), message);
  }

  globalThis.fetch = async (url) => {
    if (new URL(url).pathname.endsWith("/contents/index/inflight.json")) {
      return Response.json({ content: Buffer.from("{").toString("base64"), sha: "bad-json" });
    }
    return new Response("", { status: 404 });
  };
  await assert.rejects(() => reconcile(ENV), /index\/inflight\.json must contain valid JSON/);
});

test("the current inflight contract accepts provider-safe ordinary and managed logins", async () => {
  const { reconcile } = await import("../src/index.js");
  const { store } = stubState({
    "index/inflight.json": {
      open: [
        {
          id: "a1b2c3d4e5f6", owner: null, submitter: "someone_octo",
          at: "2026-08-01T00:00:00Z",
        },
        {
          id: "b1b2c3d4e5f6", owner: "org--team", submitter: "someone__octo",
          at: "2026-08-01T00:00:01Z",
        },
      ],
    },
  }, []);

  assert.deepEqual(await reconcile(ENV), { released: 2, open: 0 });
  assert.deepEqual(store.get("index/inflight.json"), { open: [] });
});

test("the checked-in state bootstrap is the exact empty current contract", async () => {
  const inflight = JSON.parse(await readFile(
    new URL("../state-bootstrap/index/inflight.json", import.meta.url), "utf8",
  ));
  const reviewer = JSON.parse(await readFile(
    new URL("../state-bootstrap/index/open.json", import.meta.url), "utf8",
  ));
  assert.deepEqual(inflight, { open: [] });
  assert.deepEqual(reviewer, { schema_version: 1, open: [] });
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
      headers: { "sec-fetch-site": "same-origin" },
      body: new URLSearchParams({ token: TOKEN }),
    }),
    ENV,
  );
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie, "no cookie was set");
  assert.match(cookie, new RegExp(`__Host-palomar_session=${TOKEN}`));
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
      headers: { "sec-fetch-site": "same-origin" },
      body: new URLSearchParams({ token: TOKEN }),
    }),
    ENV,
  );
  const cookie = exchange.headers.get("set-cookie").split(";")[0];
  const status = await worker.fetch(
    new Request("https://submit.palomar-registry.org/api/submission", {
      headers: {
        // A sibling may leave the retired Domain-cookie name in the browser.
        // It cannot shadow the host-prefixed credential or authenticate alone.
        cookie: `palomar_session=${"b".repeat(64)}; ${cookie}`,
        "sec-fetch-site": "same-origin",
      },
    }),
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
  const { nextPollDelay } = await import("../public/polling.js");
  for (const moving of ["verifying", "awaiting-review", "reviewing"]) {
    assert.ok(nextPollDelay({ status: moving }) > 0, `${moving} must not be treated as settled`);
  }
  for (const done of ["registered", "withdrawn", "verification-failed", "review-failed"]) {
    assert.equal(nextPollDelay({ status: done }), null, `${done} should stop the polling`);
  }
});

test("the page stops asking about exactly one status more than the server calls closed", async () => {
  // Two nearly identical sets, one in the server and one in the browser, with
  // names that read as synonyms. Every status the server will not act on is one
  // there is no point asking about, and `review-failed` and `dispatch-lost` are
  // the two that are the other way round: nothing moves them on their own, so
  // the page stops asking, but the submission is still the submitter's to
  // withdraw. Written as one derivation
  // from one list so that nobody can quietly make the two equal, in either
  // direction, without saying so here.
  const { CLOSED, SETTLED } = await import("../public/statuses.js");
  for (const status of CLOSED) {
    assert.ok(SETTLED.has(status), `${status} is closed but the page would keep asking about it`);
  }
  assert.deepEqual(
    [...SETTLED].filter((status) => !CLOSED.has(status)).sort(),
    ["dispatch-lost", "review-failed"],
  );
  // And the page's own list is that same set, not a copy of it.
  const { SETTLED: fromPolling } = await import("../public/polling.js");
  assert.equal(fromPolling, SETTLED);
});

test("a status page left open cannot spend the server's hourly budget", async () => {
  // Six seconds, for as long as the tab was open, at three or four GitHub
  // calls an ask against a budget of five thousand an hour: three tabs
  // exhausted it, and an exhausted budget is not a slow status page. It is
  // every submission's verification, review and registration failing at once.
  const { nextPollDelay } = await import("../public/polling.js");
  const CALLS_PER_ASK = 4;
  const BUDGET_PER_HOUR = 5000;

  /** How many times one tab asks in an hour, sitting in this status. */
  function asksPerHour(status, hidden = false) {
    let asks = 0;
    for (let elapsed = 0, previous = 0; ; asks += 1) {
      const delay = nextPollDelay({ status, previous, hidden });
      if (delay === null) break;
      elapsed += delay;
      if (elapsed > 3600_000) break;
      previous = delay;
    }
    return asks;
  }

  for (const status of ["verifying", "reviewing", "awaiting-review"]) {
    const tabs = Math.floor(BUDGET_PER_HOUR / (asksPerHour(status) * CALLS_PER_ASK));
    // Twelve submissions may be verified at once, so the budget has to hold
    // more open tabs than that before anyone has left one on a second screen.
    assert.ok(tabs >= 20, `${status} leaves room for only ${tabs} open tabs`);
  }

  // And a tab nobody is looking at costs nothing at all.
  assert.equal(asksPerHour("verifying", true), 0);
});

test("the status page stops asking when nobody is looking at it", async () => {
  const script = await readFile(new URL("../public/status.js", import.meta.url), "utf8");
  assert.match(script, /visibilitychange/);
  assert.match(script, /document\.visibilityState === "hidden"/);
  // And coming back to the tab asks straight away, rather than showing the
  // answer it stopped on until the backoff it had reached elapses again.
  assert.match(script, /pollDelay = 0;\s*\n\s*poll\(\);/);
});

test("a temporary status failure retries instead of pretending the record is missing", async () => {
  const { pollFailureAction } = await import("../public/polling.js");
  assert.equal(pollFailureAction(404), "missing");
  for (const status of [401, 403]) {
    assert.equal(pollFailureAction(status), "unauthorized", `${status} would retry forever`);
  }
  for (const status of [409, 429, 500, 503]) {
    assert.equal(pollFailureAction(status), "retry", `${status} would stop status polling`);
  }
  const script = await readFile(new URL("../public/status.js", import.meta.url), "utf8");
  assert.match(script, /const failure = pollFailureAction\(response\.status\)/);
  assert.match(script, /failure === "missing"/);
  assert.match(script, /failure === "unauthorized"[\s\S]*session has expired or is not authorized/);
  assert.match(script, /Could not refresh this submission\. Retrying\.[\s\S]*askAgain\(lastStatus\)/);
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
    const run = {
      id: 12345, name: "Verify submission a1b2c3d4e5f6", status: "completed",
      conclusion: "success", html_url: "https://example.test/run",
      run_started_at: "2026-08-01T00:00:00Z",
    };
    if (path.includes("/actions/workflows/")) {
      return Response.json({ workflow_runs: [run] });
    }
    if (/\/actions\/runs\/\d+$/.test(path)) return Response.json(run);
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
    const run = {
      id: 12345, name: "Verify submission a1b2c3d4e5f6", status: "completed",
      conclusion: "success", html_url: "https://example.test/run",
      run_started_at: "2026-08-01T00:00:00Z",
    };
    if (path.includes("/actions/workflows/")) {
      return Response.json({ workflow_runs: [run] });
    }
    if (/\/actions\/runs\/\d+$/.test(path)) return Response.json(run);
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

/**
 * The push check, which had no test at all.
 *
 * `permissions.push` on the repository, read with the submitter's own token,
 * is the entire proof that a submitter may submit a repository. Everything
 * downstream rests on it: the reviewer refuses to register anything whose
 * record does not carry `push_verified`. It was never exercised, so nothing
 * would have noticed it being inverted, skipped, or refactored away.
 */
function stubOAuth({
  push,
  files = {},
  login = "someone",
  inflight = { open: [] },
  reviewer = { schema_version: 1, open: [] },
}) {
  const written = [];
  const initial = { ...files };
  if (inflight !== null) initial["index/inflight.json"] = inflight;
  if (reviewer !== null) initial["index/open.json"] = reviewer;
  const store = new Map(Object.entries(initial));
  const deleted = [];
  const dispatched = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(url);
    const method = init.method ?? "GET";
    if (target.hostname === "github.com" && target.pathname.endsWith("/access_token")) {
      return Response.json({ access_token: "the-submitter-token" });
    }
    if (target.pathname === "/user") {
      return Response.json({ login, id: 4242 });
    }
    if (target.pathname === "/repos/example/project") {
      return Response.json({
        full_name: "example/project",
        private: false,
        owner: { login: "example" },
        permissions: { push },
      });
    }
    if (target.pathname.includes("/actions/workflows/")) {
      dispatched.push(target.pathname);
      return Response.json({ ok: true });
    }
    const path = decodeURI(
      target.pathname.replace(`/repos/${ENV.STATE_REPO}/contents/`, ""),
    );
    if (method === "GET") {
      if (!store.has(path)) return new Response("", { status: 404 });
      return Response.json({ content: encode(store.get(path)), sha: `sha-${path}` });
    }
    if (method === "DELETE") {
      deleted.push(path);
      store.delete(path);
      return Response.json({ ok: true });
    }
    const body = JSON.parse(init.body);
    written.push({ path, value: JSON.parse(Buffer.from(body.content, "base64").toString("utf-8")) });
    store.set(path, JSON.parse(Buffer.from(body.content, "base64").toString("utf-8")));
    return Response.json({ content: {} });
  };
  return { written, deleted, dispatched, store };
}

// The browser half of the intake. `beginSubmission` mints this, keeps only its
// digest, and hands the secret back in a cookie scoped to the callback; the
// callback refuses anything that cannot present it.
const BINDING = "9".repeat(64);

const PENDING = {
  schema_version: 2,
  binding_sha256: await digest(BINDING),
  repository: "example/project",
  commit: "1".repeat(40),
  existing_id: null,
  context: null,
  requested_paths: {},
  authorization_relationship: "maintainer",
  authorization_evidence: null,
  created_at: "2026-08-01T00:00:00Z",
};

async function callback(nonce, { binding = BINDING, cookies = [] } = {}) {
  const name = `__Host-palomar_intake_${(await digest(nonce)).slice(0, 16)}`;
  const cookie = [...cookies, ...(binding ? [`${name}=${binding}`] : [])].join("; ");
  return worker.fetch(
    new Request(`https://submit.palomar-registry.org/oauth/callback?code=c&state=${nonce}`, {
      headers: cookie ? { cookie } : {},
    }),
    ENV,
  );
}

async function clearedIntakeCookie(nonce) {
  const name = `__Host-palomar_intake_${(await digest(nonce)).slice(0, 16)}`;
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

test("a submitter who cannot push writes no submission", async () => {
  const nonce = "b".repeat(64);
  const { written } = stubOAuth({
    push: false,
    files: { [`pending/${await digest(nonce)}.json`]: PENDING },
  });
  const response = await callback(nonce);

  assert.equal(response.status, 403);
  assert.match(await response.text(), /cannot push to that repository/);
  assert.equal(response.headers.get("set-cookie"), null, "a retryable intake lost its binding");
  // Nothing may be admitted, indexed, or dispatched on a failed proof.
  assert.deepEqual(written.map((item) => item.path), []);
});

test("a submitter who can push is recorded as having proved it", async () => {
  const nonce = "c".repeat(64);
  const { written } = stubOAuth({
    push: true,
    files: { [`pending/${await digest(nonce)}.json`]: PENDING },
  });
  const response = await callback(nonce);

  assert.equal(response.status, 303);
  const record = written.find((item) => item.path.endsWith("state.json"));
  assert.ok(record, "no submission record was written");
  assert.equal(record.value.push_verified, true);
  assert.equal(record.value.submitter, "someone");
  assert.equal(response.headers.get("set-cookie"), await clearedIntakeCookie(nonce));
});

test("browser intake fails closed and visibly when inflight state is unusable", async () => {
  for (const [name, inflight] of [
    ["missing", null],
    ["malformed", { open: "not-an-array" }],
  ]) {
    const nonce = name === "missing" ? "1".repeat(64) : "2".repeat(64);
    const pendingPath = `pending/${await digest(nonce)}.json`;
    const stub = stubOAuth({
      push: true,
      inflight,
      files: { [pendingPath]: PENDING },
    });

    const response = await callback(nonce);
    assert.equal(response.status, 503, `${name} state did not stop browser intake`);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const body = await response.text();
    assert.match(body, /Submission intake is temporarily unavailable/);
    assert.match(body, /sign-in was spent/);
    assert.match(body, /Start a new submission from the submission form/);
    assert.doesNotMatch(body, /inflight|open array|state-contract/);
    assert.equal(response.headers.get("set-cookie"), await clearedIntakeCookie(nonce));
    assert.deepEqual(stub.deleted, [pendingPath], "the proved nonce was not consumed once");
    assert.deepEqual(
      stub.written.filter((item) => !item.path.startsWith("pending/")),
      [],
      "a browser proof created durable submission state after admission failed",
    );
    assert.deepEqual(stub.dispatched, [], "a browser proof dispatched work after admission failed");
  }
});

test("browser intake also treats malformed rate state as a retryable contract failure", async () => {
  const nonce = "4".repeat(64);
  const pendingPath = `pending/${await digest(nonce)}.json`;
  const ratePathName = await agentRatePath();
  const stub = stubOAuth({
    push: true,
    files: {
      [pendingPath]: PENDING,
      [ratePathName]: { schema_version: 1, interval_seconds: "60" },
    },
  });

  const response = await callback(nonce);
  assert.equal(response.status, 503);
  assert.match(await response.text(), /Submission intake is temporarily unavailable/);
  assert.deepEqual(stub.deleted, [pendingPath]);
  assert.deepEqual(
    stub.written.filter((item) => !item.path.startsWith("pending/")),
    [],
  );
  assert.deepEqual(stub.dispatched, []);
});

test("a browser capacity refusal says the completed sign-in was spent", async () => {
  const nonce = "3".repeat(64);
  const inflight = { open: Array.from({ length: 12 }, (_, index) => ({
    id: index.toString(36).padStart(12, "0"),
    owner: `owner${index}`,
    submitter: `user${index}`,
    at: "2026-08-01T00:00:00Z",
  })) };
  const stub = stubOAuth({
    push: true,
    inflight,
    files: { [`pending/${await digest(nonce)}.json`]: PENDING },
  });

  const response = await callback(nonce);
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.match(body, /Palomar is at capacity/);
  assert.match(body, /sign-in was spent/);
  assert.match(body, /Start a new submission from the submission form/);
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
  assert.deepEqual(
    stub.written.filter((item) => !item.path.startsWith("pending/")),
    [],
  );
  assert.deepEqual(stub.dispatched, []);
});

test("a refused submitter keeps what they typed, and the nonce", async () => {
  // Consuming the pending record first meant a failed proof destroyed the
  // whole submission, undoing the care the form takes to hand it back.
  const nonce = "d".repeat(64);
  const path = `pending/${await digest(nonce)}.json`;
  const { deleted, store } = stubOAuth({ push: false, files: { [path]: PENDING } });
  await callback(nonce);
  assert.deepEqual(deleted, []);
  assert.ok(store.has(path), "the intake was consumed by a submission that never happened");
});

test("a nonce that cannot be consumed admits nothing", async () => {
  // The delete is the only thing between one sign-in and two submissions, so
  // its failure is fatal rather than advisory.
  const nonce = "e".repeat(64);
  const path = `pending/${await digest(nonce)}.json`;
  const { written } = stubOAuth({ push: true, files: { [path]: PENDING } });
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) =>
    (init.method ?? "GET") === "DELETE"
      ? new Response("", { status: 409 })
      : inner(url, init);

  const response = await callback(nonce);
  assert.equal(response.status, 409);
  assert.equal(response.headers.get("set-cookie"), null, "a retryable consume conflict was cleared");
  assert.deepEqual(written.map((item) => item.path), []);
});

test("an unattributable sign-in is refused rather than bucketed", async () => {
  // `?? ""` put every such submission in one bucket, where they throttled
  // each other and counted as one submitter.
  const nonce = "f".repeat(64);
  const { written } = stubOAuth({
    push: true, login: null, files: { [`pending/${await digest(nonce)}.json`]: PENDING },
  });
  const response = await callback(nonce);
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.match(body, /sign-in was spent/);
  assert.match(body, /Start a new submission from the submission form/);
  assert.equal(response.headers.get("set-cookie"), await clearedIntakeCookie(nonce));
  assert.deepEqual(written.map((item) => item.path), []);
});

test("an unexpected failure after browser proof consumption is honest and terminal", async () => {
  const nonce = "0".repeat(64);
  const pendingPath = `pending/${await digest(nonce)}.json`;
  const stub = stubOAuth({ push: true, files: { [pendingPath]: PENDING } });
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(url);
    if ((init.method ?? "GET") === "PUT" && target.pathname.includes("/contents/submissions/")) {
      return new Response("upstream failure", { status: 502 });
    }
    return inner(url, init);
  };

  const response = await callback(nonce);
  assert.equal(response.status, 500);
  const body = await response.text();
  assert.match(body, /could not be completed/);
  assert.match(body, /sign-in was spent/);
  assert.match(body, /Start a new submission from the submission form/);
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
  assert.deepEqual(stub.deleted, [pendingPath]);
  assert.deepEqual(stub.written, []);
  assert.deepEqual(stub.dispatched, []);
});

/**
 * The agent path: what an agent must prove, and what it must not be able to
 * skip.
 *
 * A browser proves push access by signing in; an agent proves it by creating a
 * tag, which needs the same write access, and a gist, which is the only half
 * that carries an identity. Neither alone is enough and the record says so.
 */
function stubAgent(config = {}) {
  const {
    inflight = { open: [] },
    reviewer = { schema_version: 1, open: [] },
    ...proofConfig
  } = config;
  const state = { tag: {}, gist: {}, repoId: 987654321, ...proofConfig };
  const written = [];
  const initial = [];
  if (inflight !== null) initial.push(["index/inflight.json", inflight]);
  if (reviewer !== null) initial.push(["index/open.json", reviewer]);
  const store = new Map(initial);
  const deleted = [];
  const dispatched = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(url);
    const method = init.method ?? "GET";
    if (target.pathname.startsWith("/repos/example/project/git/ref/tags/palomar-verify-")) {
      if (!state.tag.exists) return new Response("", { status: 404 });
      return Response.json({ object: { type: state.tag.type ?? "commit", sha: state.tag.sha } });
    }
    if (target.pathname.startsWith("/gists/")) {
      if (!state.gist.exists) return new Response("", { status: 404 });
      return Response.json({
        owner: state.gist.owner ?? { type: "User", login: "someone", id: 4242 },
        // Secret, and made after the challenge was issued: what the
        // instructions ask an agent for.
        public: state.gist.public ?? false,
        created_at: state.gist.created_at ?? "2030-01-01T00:00:00Z",
        files: { "palomar.txt": { content: state.gist.content } },
      });
    }
    if (target.pathname === "/repos/example/project") {
      return Response.json({
        id: state.repoId, full_name: "example/project", private: false,
        owner: { login: "example" }, permissions: { push: true },
      });
    }
    if (target.pathname.includes("/commits/")) return Response.json({ sha: "1".repeat(40) });
    if (target.pathname.includes("/actions/workflows/")) {
      dispatched.push({ path: target.pathname, body: JSON.parse(init.body) });
      return Response.json({ ok: true });
    }
    const path = decodeURI(target.pathname.replace(`/repos/${ENV.STATE_REPO}/contents/`, ""));
    if (method === "GET") {
      if (!store.has(path)) return new Response("", { status: 404 });
      return Response.json({ content: encode(store.get(path)), sha: `sha-${path}` });
    }
    if (method === "DELETE") { deleted.push(path); store.delete(path); return Response.json({ ok: true }); }
    const body = JSON.parse(init.body);
    const value = JSON.parse(Buffer.from(body.content, "base64").toString("utf-8"));
    written.push({ path, value });
    store.set(path, value);
    return Response.json({ content: {} });
  };
  return { written, deleted, dispatched, store, state };
}

const AGENT_SUBMISSION = {
  repository: "example/project",
  commit: "1".repeat(40),
  comparator_config_path: "comparator.json",
  authorization_relationship: "maintainer",
};

async function agentSubmit(overrides = {}) {
  const response = await worker.fetch(
    new Request("https://submit.palomar-registry.org/api/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...AGENT_SUBMISSION, ...overrides }),
    }),
    ENV,
  );
  return response.json();
}

async function agentVerify(body) {
  const name = `__Host-palomar_intake_${(
    await digest(String(body.pending_secret ?? ""))
  ).slice(0, 16)}`;
  return worker.fetch(
    new Request("https://submit.palomar-registry.org/api/verify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // The agent's explicit pending secret and proof stay authoritative;
        // ambient browser-cookie ambiguity belongs only to the OAuth callback.
        cookie:
          `${name}=${"8".repeat(64)}; ` +
          `${name}=${"9".repeat(64)}`,
      },
      body: JSON.stringify(body),
    }),
    ENV,
  );
}

async function agentRatePath() {
  return `index/rate/${await digest(`${ENV.TOKEN_PEPPER}:4242`)}.json`;
}

test("an agent is told what to create, and the challenge is not the key", async () => {
  stubAgent();
  const begun = await agentSubmit();
  assert.match(begun.pending_secret, /^[0-9a-f]{64}$/);
  assert.match(begun.challenge, /^[0-9a-f]{64}$/);
  // The challenge goes into a public tag name. If the pending record were
  // filed under its digest, anyone reading that tag could compute the lookup
  // key and take the access token with it.
  assert.notEqual(begun.pending_secret, begun.challenge);
  assert.match(begun.instructions, /git\/refs/);
  assert.match(begun.instructions, /gists/);
});

test("agent intake writes every normalized optional field to the pending record", async () => {
  const stub = stubAgent();
  await agentSubmit({
    existing_id: "palomar-2026-07-29-000123",
    context: "  Reviewer context.  ",
    authorization_evidence: "  Maintainer evidence.  ",
    project_path: " proof ",
    comparator_config_path: " proof/comparator.json ",
    formalization_metadata_path: " docs/formalization.yaml ",
  });

  const pending = stub.written.find((item) => item.path.startsWith("pending/"));
  assert.ok(pending, "agent intake did not write a pending record");
  assert.equal(pending.value.existing_id, "PALOMAR-2026-07-29-000123");
  assert.equal(pending.value.context, "Reviewer context.");
  assert.equal(pending.value.authorization_evidence, "Maintainer evidence.");
  assert.deepEqual(pending.value.requested_paths, {
    project_path: "proof",
    comparator_config_path: "proof/comparator.json",
    formalization_metadata_path: "docs/formalization.yaml",
  });
});

test("a tag and a gist together admit a submission", async () => {
  const stub = stubAgent();
  const begun = await agentSubmit();
  stub.state.tag = { exists: true, sha: "1".repeat(40) };
  stub.state.gist = { exists: true, content: begun.challenge };
  const response = await agentVerify({ pending_secret: begun.pending_secret, gist_id: "abc123" });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.match(body.submission_id, /^[0-9a-z]{12}$/);
  assert.match(body.access_token, /^[0-9a-f]{64}$/);
  const record = stub.written.find((item) => item.path.endsWith("state.json"));
  assert.equal(record.value.push_verified, true);
  assert.equal(record.value.submitter, "someone");
  // The record must not claim the binding OAuth gets.
  assert.equal(record.value.push_proof.method, "tag-and-gist");
  assert.equal(record.value.push_proof.binding, "separately-attested");
  assert.equal(record.value.push_proof.principal.id, 4242);
  assert.equal(stub.dispatched.length, 1);
  assert.equal(
    JSON.parse(stub.dispatched[0].body.inputs.options).authorization_relationship,
    "I am a responsible author or maintainer",
  );
});

test("agent intake fails closed and in JSON when admission indexes are unusable", async () => {
  const cases = [
    ["missing inflight", { inflight: null }],
    ["malformed inflight", { inflight: { open: [{ id: "old" }] } }],
    ["missing reviewer queue", { reviewer: null }],
    ["malformed reviewer queue", { reviewer: { schema_version: 1, open: "bad" } }],
  ];
  for (const [name, config] of cases) {
    const stub = stubAgent(config);
    const begun = await agentSubmit();
    stub.state.tag = { exists: true, sha: "1".repeat(40) };
    stub.state.gist = { exists: true, content: begun.challenge };
    const before = stub.written.length;

    const response = await agentVerify({
      pending_secret: begun.pending_secret,
      gist_id: "abc123",
    });
    assert.equal(response.status, 503, `${name} did not stop agent intake`);
    assert.match(response.headers.get("content-type"), /application\/json/);
    const body = await response.json();
    assert.deepEqual(body, {
      error: "submission intake is temporarily unavailable",
      proof_consumed: true,
      restart: "This proof was consumed. Start a new submission and create a new proof.",
    });
    assert.ok(stub.deleted.some((path) => path.startsWith("pending/")),
              `${name} did not consume the proved challenge exactly once`);
    assert.deepEqual(
      stub.written.slice(before).filter((item) => !item.path.startsWith("pending/")),
      [],
      `${name} created a state record or index`,
    );
    assert.deepEqual(stub.dispatched, [], `${name} dispatched verification`);
  }
});

test("an agent capacity refusal says its accepted proof was consumed", async () => {
  const inflight = { open: Array.from({ length: 12 }, (_, index) => ({
    id: index.toString(36).padStart(12, "0"),
    owner: `owner${index}`,
    submitter: `user${index}`,
    at: "2026-08-01T00:00:00Z",
  })) };
  const stub = stubAgent({ inflight });
  const begun = await agentSubmit();
  stub.state.tag = { exists: true, sha: "1".repeat(40) };
  stub.state.gist = { exists: true, content: begun.challenge };
  const before = stub.written.length;

  const response = await agentVerify({
    pending_secret: begun.pending_secret,
    gist_id: "abc123",
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error, "Palomar is at capacity");
  assert.equal(body.proof_consumed, true);
  assert.match(body.restart, /Start a new submission and create a new proof/);
  assert.deepEqual(
    stub.written.slice(before).filter((item) => item.path.includes("submissions/")),
    [],
  );
  assert.deepEqual(stub.dispatched, []);
});

test("agent admission applies owner and submitter caps after proof", async () => {
  const cases = [
    [
      "owner",
      Array.from({ length: 2 }, (_, index) => ({
        id: `${index}`.padStart(12, "0"),
        owner: "example",
        submitter: `user${index}`,
        at: "2026-08-01T00:00:00Z",
      })),
      "That repository already has submissions in flight",
    ],
    [
      "submitter",
      Array.from({ length: 2 }, (_, index) => ({
        id: `${index}`.padStart(12, "0"),
        owner: `owner${index}`,
        submitter: "someone",
        at: "2026-08-01T00:00:00Z",
      })),
      "You already have submissions in flight",
    ],
  ];

  for (const [name, open, error] of cases) {
    const stub = stubAgent({ inflight: { open } });
    const begun = await agentSubmit();
    stub.state.tag = { exists: true, sha: "1".repeat(40) };
    stub.state.gist = { exists: true, content: begun.challenge };
    const before = stub.written.length;

    const response = await agentVerify({
      pending_secret: begun.pending_secret,
      gist_id: "abc123",
    });
    const body = await response.json();
    assert.equal(response.status, 429, `${name} cap returned the wrong status`);
    assert.equal(body.error, error);
    assert.equal(body.proof_consumed, true, `${name} cap ran before proof consumption`);
    assert.ok(
      stub.deleted.some((path) => path.startsWith("pending/")),
      `${name} cap left the proved challenge reusable`,
    );
    assert.deepEqual(
      stub.written.slice(before).filter((item) => item.path.includes("submissions/")),
      [],
      `${name} cap wrote a submission record`,
    );
    assert.deepEqual(stub.dispatched, [], `${name} cap dispatched verification`);
  }
});

test("an admitted submission is put where the reviewer will find it", async () => {
  // The reviewer used to find its work by listing `submissions/`, which is an
  // API call per submission per pass and stops at the thousand names the
  // contents API will list. It reads `index/open.json` now, and a submission
  // this end never indexes is one nothing reviews until that index is next
  // rebuilt from scratch.
  const stub = stubAgent();
  const begun = await agentSubmit();
  stub.state.tag = { exists: true, sha: "1".repeat(40) };
  stub.state.gist = { exists: true, content: begun.challenge };
  const body = await (await agentVerify({
    pending_secret: begun.pending_secret, gist_id: "abc123",
  })).json();

  const index = stub.written.find((item) => item.path === "index/open.json");
  assert.ok(index, "the submission was admitted without being indexed");
  assert.deepEqual(index.value.open, [body.submission_id]);
});

test("indexing preserves reviewer-owned fields without interpreting them", async () => {
  // Written by two writers: this one appends, the reviewer prunes and records
  // when the whole file next needs rebuilding from the records. Dropping what
  // the other end put there would make the index look permanently overdue, and
  // an overdue index is rebuilt by cloning every record there is.
  const stub = stubAgent();
  stub.store.set("index/open.json", {
    schema_version: 1,
    rebuild_after: "2099-01-01T00:00:00Z",
    reviewer_owned: { format: "future", timestamp: "not-the-server's-contract" },
    open: ["aaaaaaaaaaaa"],
  });
  const begun = await agentSubmit();
  stub.state.tag = { exists: true, sha: "1".repeat(40) };
  stub.state.gist = { exists: true, content: begun.challenge };
  const body = await (await agentVerify({
    pending_secret: begun.pending_secret, gist_id: "abc123",
  })).json();

  const index = stub.written.find((item) => item.path === "index/open.json");
  assert.deepEqual(index.value.open, ["aaaaaaaaaaaa", body.submission_id]);
  assert.equal(index.value.rebuild_after, "2099-01-01T00:00:00Z");
  assert.deepEqual(index.value.reviewer_owned, {
    format: "future", timestamp: "not-the-server's-contract",
  });
});

test("a proof that does not hold admits nothing", async () => {
  // Each of these is a way the tag or the gist could be present and still not
  // be evidence that this submitter can write to this repository.
  const cases = [
    ["no tag", { tag: { exists: false }, gist: true }, /no tag by that name/],
    ["a tag on another commit", { tag: { exists: true, sha: "9".repeat(40) }, gist: true },
     /different commit/],
    ["an annotated tag", { tag: { exists: true, type: "tag", sha: "1".repeat(40) }, gist: true },
     /annotated/],
    ["no gist", { tag: { exists: true, sha: "1".repeat(40) }, gist: { exists: false } },
     /no such gist/],
    ["a gist with the wrong content",
     { tag: { exists: true, sha: "1".repeat(40) }, gist: { exists: true, content: "not it" } },
     /does not carry the challenge/],
    ["a gist owned by a bot",
     { tag: { exists: true, sha: "1".repeat(40) }, gist: { exists: true, bot: true } },
     /not owned by a GitHub user/],
  ];

  for (const [name, setup, expected] of cases) {
    const stub = stubAgent();
    const begun = await agentSubmit();
    stub.state.tag = setup.tag;
    stub.state.gist = setup.gist === true
      ? { exists: true, content: begun.challenge }
      : setup.gist.bot
        ? { exists: true, content: begun.challenge, owner: { type: "Bot", login: "ci[bot]", id: 1 } }
        : setup.gist;

    const response = await agentVerify({
      pending_secret: begun.pending_secret, gist_id: "abc123",
    });
    const body = await response.json();
    assert.equal(response.status, 403, `${name} was admitted`);
    assert.match(`${body.tag} ${body.gist}`, expected, name);
    assert.equal(
      stub.written.filter((item) => item.path.includes("submissions/")).length, 0,
      `${name} wrote a submission record`,
    );
  }
});

test("a challenge cannot be spent twice", async () => {
  const stub = stubAgent();
  const begun = await agentSubmit();
  stub.state.tag = { exists: true, sha: "1".repeat(40) };
  stub.state.gist = { exists: true, content: begun.challenge };

  const first = await agentVerify({ pending_secret: begun.pending_secret, gist_id: "abc123" });
  assert.equal(first.status, 200);
  const second = await agentVerify({ pending_secret: begun.pending_secret, gist_id: "abc123" });
  assert.equal(second.status, 404, "a spent challenge admitted a second submission");
});

test("a browser sign-in cannot be completed as an agent submission", async () => {
  // The two intakes prove different things and record different bindings.
  // A pending record must be redeemed by the path that created it.
  const stub = stubAgent();
  await worker.fetch(
    new Request("https://submit.palomar-registry.org/submit", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
      body: new URLSearchParams(AGENT_SUBMISSION),
    }),
    ENV,
  );
  const pending = stub.written.find((item) => item.path.startsWith("pending/"));
  assert.equal(pending.value.method, "oauth");
});

test("starting a submission doubles the wait, and only registering clears it", async () => {
  const stub = stubAgent();
  const submit = async () => {
    const begun = await agentSubmit();
    stub.state.tag = { exists: true, sha: "1".repeat(40) };
    stub.state.gist = { exists: true, content: begun.challenge };
    return agentVerify({ pending_secret: begun.pending_secret, gist_id: "abc123" });
  };
  const rate = () => [...stub.store.entries()].find(([path]) => path.startsWith("index/rate/"))?.[1];

  assert.equal((await submit()).status, 200);
  assert.equal(rate().interval_seconds, 60, "the first start asks for a minute");

  // The second is refused, because the first has not been registered.
  const second = await submit();
  assert.equal(second.status, 429);
  const refused = await second.json();
  assert.match(refused.error, /rate limit/);
  assert.equal(refused.proof_consumed, true);
  assert.match(refused.restart, /Start a new submission and create a new proof/);

  // Time passing lets it through, and doubles the wait again.
  const file = [...stub.store.keys()].find((path) => path.startsWith("index/rate/"));
  stub.store.set(file, {
    ...stub.store.get(file),
    last_start_at: "2019-12-31T23:59:00Z",
    next_allowed_at: "2020-01-01T00:00:00Z",
  });
  assert.equal((await submit()).status, 200);
  assert.equal(rate().interval_seconds, 120, "a second start did not double the wait");
});

test("malformed present rate state consumes the proof but admits and writes nothing", async () => {
  const malformed = [
    null,
    {
      schema_version: 1,
      login: "someone",
      starts: 1,
      interval_seconds: "60",
      last_start_at: "2026-08-01T00:00:00Z",
      next_allowed_at: "2026-08-01T00:01:00Z",
    },
    {
      schema_version: 1,
      login: "someone",
      starts: 20,
      interval_seconds: Number.MAX_SAFE_INTEGER,
      last_start_at: "2019-12-31T23:59:00Z",
      next_allowed_at: "2020-01-01T00:00:00Z",
    },
  ];

  for (const value of malformed) {
    const stub = stubAgent();
    const begun = await agentSubmit();
    const path = await agentRatePath();
    stub.store.set(path, value);
    stub.state.tag = { exists: true, sha: "1".repeat(40) };
    stub.state.gist = { exists: true, content: begun.challenge };
    const before = stub.written.length;

    const response = await agentVerify({
      pending_secret: begun.pending_secret,
      gist_id: "abc123",
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "submission intake is temporarily unavailable",
      proof_consumed: true,
      restart: "This proof was consumed. Start a new submission and create a new proof.",
    });
    assert.deepEqual(
      stub.written.slice(before).filter((item) => !item.path.startsWith("pending/")),
      [],
      "malformed rate state caused a partial admission write",
    );
    assert.deepEqual(stub.dispatched, [], "malformed rate state dispatched verification");
    assert.equal(stub.store.get(path), value, "intake rewrote the malformed rate document");
  }
});

test("empty and invalid-JSON rate files also fail closed before admission writes", async () => {
  for (const text of ["", "{"]) {
    const stub = stubAgent();
    const begun = await agentSubmit();
    const path = await agentRatePath();
    stub.state.tag = { exists: true, sha: "1".repeat(40) };
    stub.state.gist = { exists: true, content: begun.challenge };
    const before = stub.written.length;
    const inner = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const target = new URL(url);
      const requested = decodeURI(
        target.pathname.replace(`/repos/${ENV.STATE_REPO}/contents/`, ""),
      );
      if ((init.method ?? "GET") === "GET" && requested === path) {
        return Response.json({
          content: Buffer.from(text, "utf-8").toString("base64"),
          sha: "rate-sha",
        });
      }
      return inner(url, init);
    };

    const response = await agentVerify({
      pending_secret: begun.pending_secret,
      gist_id: "abc123",
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).proof_consumed, true);
    assert.deepEqual(
      stub.written.slice(before).filter((item) => !item.path.startsWith("pending/")),
      [],
    );
    assert.deepEqual(stub.dispatched, []);
  }
});

test("a registration puts the interval back to a minute", async () => {
  const stub = stubAgent();
  const begun = await agentSubmit();
  stub.state.tag = { exists: true, sha: "1".repeat(40) };
  stub.state.gist = { exists: true, content: begun.challenge };
  const verified = await (await agentVerify({
    pending_secret: begun.pending_secret, gist_id: "abc123",
  })).json();

  // Wind the interval up, then register, as the reviewer would.
  const file = [...stub.store.keys()].find((path) => path.startsWith("index/rate/"));
  stub.store.set(file, { ...stub.store.get(file), interval_seconds: 3600 });
  const statePathName = statePath(verified.submission_id, "state.json");
  stub.store.set(statePathName, { ...stub.store.get(statePathName), status: "registered" });

  const response = await worker.fetch(
    // An agent presents the token rather than exchanging it for a cookie,
    // which is what llms.txt now tells it to do.
    new Request("https://submit.palomar-registry.org/api/submission", {
      headers: { authorization: `Bearer ${verified.access_token}` },
    }),
    ENV,
  );
  assert.equal(response.status, 200);
  assert.equal(stub.store.get(file).interval_seconds, 60, "registering did not clear the wait");
});

test("registration reset leaves malformed rate state unapplied without hiding the result", async () => {
  const stub = stubAgent();
  const begun = await agentSubmit();
  stub.state.tag = { exists: true, sha: "1".repeat(40) };
  stub.state.gist = { exists: true, content: begun.challenge };
  const verified = await (await agentVerify({
    pending_secret: begun.pending_secret, gist_id: "abc123",
  })).json();
  const path = await agentRatePath();
  stub.store.set(path, { schema_version: 1, interval_seconds: "60" });
  const recordPath = statePath(verified.submission_id, "state.json");
  const registered = { ...stub.store.get(recordPath), status: "registered" };
  stub.store.set(recordPath, registered);
  const before = stub.written.length;

  const response = await worker.fetch(new Request(
    "https://submit.palomar-registry.org/api/submission",
    { headers: { authorization: `Bearer ${verified.access_token}` } },
  ), ENV);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "registered");
  assert.deepEqual(stub.written.slice(before), []);
  assert.equal(stub.store.get(recordPath), registered);
  assert.equal(Object.hasOwn(stub.store.get(recordPath), "rate_reset_at"), false);
});

test("registration reset does not synthesize a partial rate document when it is absent", async () => {
  const stub = stubAgent();
  const begun = await agentSubmit();
  stub.state.tag = { exists: true, sha: "1".repeat(40) };
  stub.state.gist = { exists: true, content: begun.challenge };
  const verified = await (await agentVerify({
    pending_secret: begun.pending_secret, gist_id: "abc123",
  })).json();
  const path = await agentRatePath();
  stub.store.delete(path);
  const recordPath = statePath(verified.submission_id, "state.json");
  stub.store.set(recordPath, { ...stub.store.get(recordPath), status: "registered" });

  const response = await worker.fetch(new Request(
    "https://submit.palomar-registry.org/api/submission",
    { headers: { authorization: `Bearer ${verified.access_token}` } },
  ), ENV);
  assert.equal(response.status, 200);
  assert.equal(stub.store.has(path), false);
  assert.match(stub.store.get(recordPath).rate_reset_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("the tag name is one GitHub will actually accept", async () => {
  // GitHub refuses a branch or tag whose name is 40 or 64 hex characters,
  // because it could not be told apart from a SHA. The challenge is 64 hex, so
  // an unprefixed name could never be created and the whole path was
  // unusable — which only a live attempt revealed.
  stubAgent();
  const begun = await agentSubmit();
  const tagName = begun.instructions.match(/refs\/tags\/(\S+)/)[1];
  assert.doesNotMatch(tagName, /^[0-9a-f]{40}$/);
  assert.doesNotMatch(tagName, /^[0-9a-f]{64}$/);
  assert.ok(tagName.endsWith(begun.challenge), "the tag no longer carries the challenge");
});

test("a sign-in completed in a browser that did not begin it is refused", async () => {
  // `state` travels in a URL, and a URL can be handed to somebody else. Without
  // the cookie half, an attacker who begins an intake and passes on the
  // authorize link gets a submission attributed to whoever follows it.
  for (const binding of [null, "0".repeat(64)]) {
    const nonce = "7".repeat(64);
    const path = `pending/${await digest(nonce)}.json`;
    const { written, deleted } = stubOAuth({ push: true, files: { [path]: PENDING } });
    const response = await callback(nonce, { binding });

    assert.equal(response.status, 400);
    assert.match(await response.text(), /did not begin here/);
    // Nothing admitted, and the code never exchanged.
    assert.deepEqual(written.map((item) => item.path), []);
    // Consumed, so the same link cannot be offered to the next person.
    assert.deepEqual(deleted, [path]);
  }
});

test("a sibling legacy Domain cookie cannot unlock or shadow a browser intake", async () => {
  const nonce = "6".repeat(64);
  const digestPrefix = (await digest(nonce)).slice(0, 16);
  const pendingPath = `pending/${await digest(nonce)}.json`;
  const legacy = `palomar_intake_${digestPrefix}=${BINDING}`;

  const refused = stubOAuth({ push: true, files: { [pendingPath]: PENDING } });
  const withoutHostCookie = await callback(nonce, { binding: null, cookies: [legacy] });
  assert.equal(withoutHostCookie.status, 400);
  assert.match(await withoutHostCookie.text(), /did not begin here/);
  assert.deepEqual(refused.deleted, [pendingPath]);
  assert.deepEqual(refused.written, []);

  const accepted = stubOAuth({ push: true, files: { [pendingPath]: PENDING } });
  const withHostCookie = await callback(nonce, {
    cookies: [`palomar_intake_${digestPrefix}=${"8".repeat(64)}`],
  });
  assert.equal(withHostCookie.status, 303);
  assert.ok(accepted.written.find((item) => item.path.endsWith("state.json")));
});

test("an invalid or ambiguous protected intake cookie is refused before provider I/O", async () => {
  const nonce = "5".repeat(64);
  const name = `__Host-palomar_intake_${(await digest(nonce)).slice(0, 16)}`;
  for (const cookie of [
    `${name}=${"8".repeat(64)}; ${name}=${"9".repeat(64)}`,
    `${name}=not-hex`,
  ]) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      throw new Error("a refused cookie reached a provider");
    };

    const response = await callback(nonce, { binding: null, cookies: [cookie] });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /did not begin here/);
    assert.equal(
      response.headers.get("set-cookie"),
      `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    );
    assert.equal(calls, 0);
  }
});

test("two submissions in two tabs do not overwrite each other's binding", async () => {
  // A fixed cookie name would mean starting the second sign-in clobbered the
  // first one's cookie, and finishing the first would then look exactly like
  // the attack above: refused, and its intake deleted, for doing nothing wrong.
  // A submitter may have two in flight, so this is ordinary use, not an edge.
  const first = "1".repeat(64);
  const second = "2".repeat(64);
  const names = await Promise.all(
    [first, second].map(async (nonce) =>
      `__Host-palomar_intake_${(await digest(nonce)).slice(0, 16)}`),
  );
  assert.notEqual(names[0], names[1], "both intakes would share one cookie");

  // Both cookies present at once, as a browser would hold them.
  const cookie = `${names[0]}=${BINDING}; ${names[1]}=${BINDING}`;
  for (const nonce of [first, second]) {
    const { written } = stubOAuth({
      push: true,
      files: { [`pending/${await digest(nonce)}.json`]: PENDING },
    });
    const response = await worker.fetch(
      new Request(
        `https://submit.palomar-registry.org/oauth/callback?code=c&state=${nonce}`,
        { headers: { cookie } },
      ),
      ENV,
    );
    assert.equal(response.status, 303, "a legitimate sign-in was refused");
    assert.ok(written.find((item) => item.path.endsWith("state.json")));
  }
});

test("a mutating call that did not come from this site is refused", async () => {
  // SameSite is scoped to the registrable domain, so data.palomar-registry.org
  // is same-site with this host and its documents carry the session cookie
  // here. That origin serves renders built from submitted Lean source.
  for (const path of ["/register", "/withdraw"]) {
    for (const headers of [
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "cross-site" },
      { origin: "https://data.palomar-registry.org" },
      { origin: "null" },
      {},
    ]) {
      const { written } = stubState(await fixture());
      // Built directly: the shared helper sends `same-origin` by default, which
      // is exactly the header these cases must not carry.
      const response = await worker.fetch(
        new Request(`https://submit.palomar-registry.org${path}`, {
          method: "POST",
          headers: { cookie: `__Host-palomar_session=${TOKEN}`, ...headers },
        }),
        ENV,
      );
      assert.equal(response.status, 403, `${path} accepted ${JSON.stringify(headers)}`);
      assert.equal(written.length, 0, `${path} wrote something`);
    }
  }
});

test("an agent presenting the token as a header needs no cookie and no origin", async () => {
  // The cookie is ambient and a header is not, so there is nothing to forge.
  // This is the path llms.txt points a client that is not a browser at.
  const { written } = stubState(await fixture());
  const response = await worker.fetch(
    new Request("https://submit.palomar-registry.org/register", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        // Cookie ambiguity cannot turn a presented non-ambient credential into
        // an anonymous request.
        cookie:
          `__Host-palomar_session=${TOKEN}; __Host-palomar_session=${"b".repeat(64)}`,
      },
      body: JSON.stringify({ review_sha256: "f".repeat(64) }),
    }),
    ENV,
  );
  assert.equal(response.status, 200);
  const state = written.find((item) => item.path.endsWith("state.json"));
  assert.equal(state.value.registration_consent, true);

  // And a token that is not one is still nobody.
  const wrong = await worker.fetch(
    new Request("https://submit.palomar-registry.org/register", {
      method: "POST",
      headers: { authorization: `Bearer ${"b".repeat(64)}` },
    }),
    ENV,
  );
  assert.equal(wrong.status, 404);
});

test("the session exchange refuses a cross-site caller", async () => {
  // This is what hands out the ambient credential, so a cross-site post to it
  // fixes a session in somebody's browser.
  stubState(await fixture());
  const response = await worker.fetch(
    new Request("https://submit.palomar-registry.org/session", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
      body: new URLSearchParams({ token: TOKEN }),
    }),
    ENV,
  );
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("the session exchange accepts an exact-origin fallback without fetch metadata", async () => {
  stubState(await fixture());
  const stateFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ method: init.method ?? "GET", path: new URL(url).pathname });
    return stateFetch(url, init);
  };

  const response = await worker.fetch(
    new Request("https://submit.palomar-registry.org/session", {
      method: "POST",
      headers: { origin: "https://submit.palomar-registry.org" },
      body: new URLSearchParams({ token: TOKEN }),
    }),
    ENV,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(
    response.headers.get("set-cookie"),
    `__Host-palomar_session=${TOKEN}; Path=/; Max-Age=43200; HttpOnly; Secure; ` +
      "SameSite=Strict",
  );
  assert.deepEqual(calls.map(({ method }) => method), ["GET", "GET"]);
  assert.match(calls[0].path, /\/contents\/index\/tokens\/[0-9a-f]{64}\.json$/);
  assert.match(calls[1].path, /\/contents\/submissions\/a1b2c3d4e5f6\/state\.json$/);
});

test("the status read is guarded too, because it is not really a read", async () => {
  // `refresh` writes records, releases capacity, spends the shared GitHub
  // budget and dispatches reviewer work. A same-site sibling could cause all of
  // that with the session cookie attached even though it could never read the
  // answer, and the point of the guard is to stop depending on the render CSP
  // to prevent it.
  const { written } = stubState(await fixture({ status: "verifying" }));
  const forged = await worker.fetch(
    new Request("https://submit.palomar-registry.org/api/submission", {
      headers: {
        cookie: `__Host-palomar_session=${TOKEN}`,
        origin: "https://data.palomar-registry.org",
      },
    }),
    ENV,
  );
  assert.equal(forged.status, 403);
  assert.equal(written.length, 0, "a forged status read still moved the submission");
});

test("status refresh reports inflight contract failures as typed retryable 503s", async () => {
  const run = {
    id: 12345,
    name: "Verify submission a1b2c3d4e5f6",
    status: "completed",
    conclusion: "success",
    html_url: "https://example.test/run",
    run_started_at: "2026-08-01T00:00:00Z",
  };
  const files = {
    ...(await fixture({ status: "verifying" })),
    "index/inflight.json": { open: "damaged" },
  };
  const { written } = stubState(files, [run]);
  const response = await worker.fetch(request("/api/submission"), ENV);
  assert.equal(response.status, 503);
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.deepEqual(await response.json(), {
    error: "submission status is temporarily unavailable",
  });
  assert.deepEqual(written, [], "the malformed inflight index partially changed the record");
});

test("a broken reviewer queue leaves a completed verification held for a repaired retry", async () => {
  const run = {
    id: 12345,
    name: "Verify submission a1b2c3d4e5f6",
    status: "completed",
    conclusion: "success",
    html_url: "https://example.test/run",
    run_started_at: "2026-08-01T00:00:00Z",
  };
  const held = {
    id: "a1b2c3d4e5f6",
    owner: "example",
    submitter: "someone",
    at: "2026-08-01T00:00:00Z",
  };
  const files = {
    ...(await fixture({ status: "verifying" })),
    "index/inflight.json": { open: [held] },
    "index/open.json": { schema_version: 1, open: "damaged" },
  };
  const { written, store } = stubState(files, [run]);
  const inner = globalThis.fetch;
  const activity = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(url);
    const method = init.method ?? "GET";
    if (method === "PUT" && target.pathname.endsWith("/index/open.json")) {
      activity.push("open queue");
    } else if (method === "POST" && target.pathname.includes("/actions/workflows/")) {
      activity.push("dispatch reviewer");
    } else if (method === "PUT" && target.pathname.endsWith("/index/inflight.json")) {
      activity.push("release slot");
    } else if (method === "PUT" && target.pathname.endsWith("/state.json")) {
      activity.push("update record");
    }
    return inner(url, init);
  };

  const refreshEnv = { ...ENV, REVIEW_WORKFLOW: "reviewer.yml" };
  const failed = await worker.fetch(request("/api/submission"), refreshEnv);
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), {
    error: "submission status is temporarily unavailable",
  });
  assert.deepEqual(store.get("index/inflight.json"), { open: [held] });
  assert.deepEqual(written, [], "queue failure released capacity or changed the record");
  assert.deepEqual(activity, [], "queue failure performed a partial transition");

  store.set("index/open.json", { schema_version: 1, open: [] });
  const retried = await worker.fetch(request("/api/submission"), refreshEnv);
  assert.equal(retried.status, 200);
  assert.equal((await retried.json()).status, "awaiting-review");
  assert.deepEqual(store.get("index/open.json").open, ["a1b2c3d4e5f6"]);
  assert.deepEqual(store.get("index/inflight.json"), { open: [] });
  assert.equal(store.get(statePath("a1b2c3d4e5f6", "state.json")).status, "awaiting-review");
  assert.deepEqual(activity, [
    "open queue",
    "dispatch reviewer",
    "update record",
    "release slot",
  ]);
});

test("a pinned run is asked for by id, not searched for by name", async () => {
  // Searching by name and then refusing whatever came back would wedge a record
  // whose own run had simply fallen further down the list than the search
  // reached, which is how a lost run used to hold three quotas for ever.
  const asked = [];
  const store = new Map(Object.entries(await fixture({ status: "verifying" })));
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    asked.push(path);
    if (/\/actions\/runs\/12345$/.test(path)) {
      return Response.json({
        id: 12345, name: "Verify submission a1b2c3d4e5f6", status: "completed",
        conclusion: "success", html_url: "https://example.test/run",
        run_started_at: "2026-08-01T00:00:00Z",
      });
    }
    if (path.includes("/actions/")) return Response.json({ workflow_runs: [] });
    const key = decodeURI(path.replace(`/repos/${ENV.STATE_REPO}/contents/`, ""));
    if ((init.method ?? "GET") === "GET") {
      if (!store.has(key)) return new Response("", { status: 404 });
      return Response.json({ content: encode(store.get(key)), sha: `sha-${key}` });
    }
    return Response.json({ content: {} });
  };
  const response = await worker.fetch(request("/api/submission"), ENV);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "awaiting-review");
  assert.ok(
    asked.some((path) => /\/actions\/runs\/12345$/.test(path)),
    "the pinned run was not asked for by id",
  );
  assert.ok(
    !asked.some((path) => path.includes("/actions/workflows/")),
    "a pinned run was still searched for by name",
  );
});

test("a run that nobody can find eventually gives its slot back", async () => {
  // A submission stuck in `verifying` holds one of twelve global slots, one of
  // two for its owner and one of two for its submitter, and nothing else
  // releases it. Two misses rather than one, because a single empty answer is
  // as likely to be GitHub having a moment as a genuinely lost run.
  const { reconcile } = await import("../src/index.js");
  const old = "2026-01-01T00:00:00Z";
  const files = {
    ...(await fixture({ status: "verifying", created_at: old, run: undefined })),
    "index/inflight.json": {
      open: [{ id: "a1b2c3d4e5f6", owner: "example", submitter: "someone", at: old }],
    },
  };
  const { written, store } = stubState(files, []);

  // First pass: noticed, not acted on.
  await reconcile(ENV);
  assert.equal(store.get(statePath("a1b2c3d4e5f6", "state.json")).status, "verifying");
  assert.equal(store.get(statePath("a1b2c3d4e5f6", "state.json")).run_misses, 1);
  assert.deepEqual(store.get("index/inflight.json").open.length, 1);

  // Second pass: released.
  await reconcile(ENV);
  const record = store.get(statePath("a1b2c3d4e5f6", "state.json"));
  assert.equal(record.status, "dispatch-lost");
  assert.deepEqual(store.get("index/inflight.json").open, []);
  // And it says what happened, rather than blaming the proof.
  assert.match(record.events.at(-1).note, /could not find the verification run/);
  assert.ok(written.length > 0);
});

test("a run that is merely queued is left alone however long it waits", async () => {
  // Verification runs for up to six hours. Ageing out anything that is simply
  // slow would fail submissions that were going to succeed.
  const { reconcile } = await import("../src/index.js");
  const old = "2026-01-01T00:00:00Z";
  const queued = {
    id: 999, name: "Verify submission a1b2c3d4e5f6", status: "queued",
    conclusion: null, html_url: "https://example.test/run", run_started_at: old,
  };
  const files = {
    ...(await fixture({ status: "verifying", created_at: old, run: { id: 999 } })),
    "index/inflight.json": {
      open: [{ id: "a1b2c3d4e5f6", owner: "example", submitter: "someone", at: old }],
    },
  };
  const { store } = stubState(files, [queued]);
  await reconcile(ENV);
  await reconcile(ENV);
  assert.equal(store.get(statePath("a1b2c3d4e5f6", "state.json")).status, "verifying");
  assert.equal(store.get("index/inflight.json").open.length, 1);
});

test("a second run carrying the same submission id cannot settle the record", async () => {
  // The submission id is in a public run name, so anyone who can dispatch the
  // workflow can produce a run carrying it. `refresh` has always pinned; the
  // cron path did not, and it is the one that runs with nobody watching.
  const { reconcile } = await import("../src/index.js");
  const impostor = {
    id: 777, name: "Verify submission a1b2c3d4e5f6", status: "completed",
    conclusion: "success", html_url: "https://example.test/other",
    run_started_at: "2026-08-01T00:00:00Z",
  };
  const files = {
    ...(await fixture({ status: "verifying", run: { id: 12345 } })),
    "index/inflight.json": {
      open: [{
        id: "a1b2c3d4e5f6", owner: "example", submitter: "someone",
        at: "2026-08-01T00:00:00Z",
      }],
    },
  };
  const { store } = stubState(files, [impostor]);
  await reconcile(ENV);
  const record = store.get(statePath("a1b2c3d4e5f6", "state.json"));
  assert.equal(record.status, "verifying", "an impostor run settled the record");
  assert.equal(record.run.id, 12345);
});

test("a submission that settles is put where the reviewer will find it", async () => {
  // The reviewer reads `index/open.json` rather than listing every submission.
  // Only admission added to it, and nothing rebuilds it for a single missing
  // id, so a submission that settled here was one the reviewer never saw.
  const { reconcile } = await import("../src/index.js");
  const done = {
    id: 12345, name: "Verify submission a1b2c3d4e5f6", status: "completed",
    conclusion: "success", html_url: "https://example.test/run",
    run_started_at: "2026-08-01T00:00:00Z",
  };
  const files = {
    ...(await fixture({ status: "verifying", run: { id: 12345 } })),
    "index/inflight.json": {
      open: [{
        id: "a1b2c3d4e5f6", owner: "example", submitter: "someone",
        at: "2026-08-01T00:00:00Z",
      }],
    },
    "index/open.json": { schema_version: 1, open: [] },
  };
  const { store } = stubState(files, [done]);
  await reconcile(ENV);
  assert.equal(store.get(statePath("a1b2c3d4e5f6", "state.json")).status, "awaiting-review");
  assert.deepEqual(store.get("index/open.json").open, ["a1b2c3d4e5f6"]);
});

test("one malformed reviewer queue does not retain unrelated terminal slots", async () => {
  const awaitingId = "a1b2c3d4e5f6";
  const terminalId = "b1b2c3d4e5f6";
  const done = {
    id: 12345, name: `Verify submission ${awaitingId}`, status: "completed",
    conclusion: "success", html_url: "https://example.test/run",
    run_started_at: "2026-08-01T00:00:00Z",
  };
  const files = {
    ...(await fixture({ status: "verifying", run: { id: 12345 } })),
    "index/inflight.json": {
      open: [
        { id: awaitingId, owner: "example", submitter: "someone", at: "2026-08-01T00:00:00Z" },
        { id: terminalId, owner: "other", submitter: "elsewhere", at: "2026-08-01T00:00:01Z" },
      ],
    },
    "index/open.json": { schema_version: 1, open: "malformed" },
    [statePath(terminalId, "state.json")]: {
      schema_version: 1, id: terminalId, status: "verification-failed",
    },
  };
  const { store } = stubState(files, [done]);

  await assert.rejects(
    () => worker.scheduled({}, ENV),
    /reconcile.*index\/open\.json is unavailable; successful verification was not queued/,
  );
  assert.equal(
    store.get(statePath(awaitingId, "state.json")).status,
    "verifying",
    "an unqueued successful verification was settled anyway",
  );
  assert.deepEqual(store.get("index/inflight.json").open, [files["index/inflight.json"].open[0]]);
});

test("a run past the first page is still found", async () => {
  // `per_page=40` made this a window rather than a search: forty runs between
  // the dispatch and the next look and the run was never seen again.
  const { findVerificationRun } = await import("../src/github.js");
  const filler = Array.from({ length: 100 }, (_, i) => ({
    id: i, name: `Verify submission other${i}`, status: "completed",
    conclusion: "success", html_url: "", run_started_at: "",
  }));
  const wanted = {
    id: 4242, name: "Verify submission a1b2c3d4e5f6", status: "completed",
    conclusion: "success", html_url: "https://example.test/run",
    run_started_at: "2026-08-01T00:00:00Z",
  };
  const queries = [];
  globalThis.fetch = async (url) => {
    const target = new URL(url);
    queries.push(target.search);
    const page = target.searchParams.get("page");
    return Response.json({ workflow_runs: page === "1" ? filler : [wanted] });
  };
  const found = await findVerificationRun(ENV, "a1b2c3d4e5f6", { since: "2026-08-01T00:00:00Z" });
  assert.equal(found.run.id, 4242);
  assert.equal(found.complete, true);
  // Bounded by when the submission was admitted, and to dispatched runs, so a
  // scheduled or push-triggered run never has to be looked at.
  assert.match(queries[0], /event=workflow_dispatch/);
  assert.match(queries[0], /created=%3E%3D2026-08-01/);
  assert.match(queries[0], /per_page=100/);
});

test("a search that runs out of pages is not the same as a run that is not there", async () => {
  // The difference decides whether a submission may be given up on. Reading a
  // truncated search as absence is how a live run loses its slot.
  const { findVerificationRun } = await import("../src/github.js");
  const full = Array.from({ length: 100 }, (_, i) => ({
    id: i, name: `Verify submission other${i}`, status: "completed",
    conclusion: "success", html_url: "", run_started_at: "",
  }));
  globalThis.fetch = async () => Response.json({ workflow_runs: full });
  const found = await findVerificationRun(ENV, "a1b2c3d4e5f6", { since: "2026-08-01T00:00:00Z" });
  assert.equal(found.run, null);
  assert.equal(found.complete, false, "a truncated search claimed the run is absent");
});

test("a run found again clears a miss recorded before it", async () => {
  // Without this a miss is permanent, and two misses an hour apart with a
  // perfectly healthy run between them read as a run nobody can find.
  const { reconcile } = await import("../src/index.js");
  const queued = {
    id: 999, name: "Verify submission a1b2c3d4e5f6", status: "queued",
    conclusion: null, html_url: "https://example.test/run", run_started_at: "",
  };
  const files = {
    ...(await fixture({
      status: "verifying", created_at: "2026-01-01T00:00:00Z",
      run: undefined, run_misses: 1,
    })),
    "index/inflight.json": {
      open: [{
        id: "a1b2c3d4e5f6", owner: "example", submitter: "someone",
        at: "2026-01-01T00:00:00Z",
      }],
    },
  };
  const { store } = stubState(files, [queued]);
  await reconcile(ENV);
  const record = store.get(statePath("a1b2c3d4e5f6", "state.json"));
  assert.equal(record.status, "verifying");
  assert.equal(record.run_misses, undefined, "the miss survived finding the run");
  assert.equal(record.run.id, 999, "a queued run was not pinned when it was found");
});

test("consent names the review it was given for", async () => {
  // Consent used to be recorded against whatever digest state held at the
  // instant of the click. A redelivery landing between reading and clicking
  // recorded consent for a review nobody had read, and the review's comments go
  // into a registered record.
  stubState(await fixture());
  const delivered = await worker.fetch(request("/api/review"), ENV);
  assert.equal((await delivered.json()).review_sha256, "f".repeat(64));

  // The review the submitter read is not the one the record now holds.
  const { written } = stubState(await fixture({ review_sha256: "e".repeat(64) }));
  const stale = await worker.fetch(
    new Request("https://submit.palomar-registry.org/register", {
      method: "POST",
      headers: {
        "sec-fetch-site": "same-origin",
        cookie: `__Host-palomar_session=${TOKEN}`,
      },
      body: JSON.stringify({ review_sha256: "f".repeat(64) }),
    }),
    ENV,
  );
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /has been replaced/);
  assert.equal(written.length, 0, "consent was recorded for a review nobody read");

  // And a registration that names nothing at all is not consent either.
  const { written: silent } = stubState(await fixture());
  const empty = await worker.fetch(
    new Request("https://submit.palomar-registry.org/register", {
      method: "POST",
      headers: {
        "sec-fetch-site": "same-origin",
        cookie: `__Host-palomar_session=${TOKEN}`,
      },
    }),
    ENV,
  );
  assert.equal(empty.status, 409);
  assert.match((await empty.json()).error, /say which review this registers/);
  assert.equal(silent.length, 0);
});

test("a review whose digest is not recorded yet is not handed over", async () => {
  // The reviewer writes the review and the digest in separate steps. Handing
  // over a review with a null digest would leave the page holding one it can
  // never register, because it stops asking once it has been shown one.
  stubState(await fixture({ review_sha256: undefined }));
  const response = await worker.fetch(request("/api/review"), ENV);
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /no review yet/);

  // And the page keeps asking on anything that is not a 409.
  const script = await readFile(new URL("../public/status.js", import.meta.url), "utf8");
  assert.match(script, /if \(!response\.ok\) return;/);
});

test("the page sends back the digest it was shown", async () => {
  // The server can only compare what the client sends. If the page stopped
  // sending it, every registration would answer 409 and nobody could register.
  const script = await readFile(new URL("../public/status.js", import.meta.url), "utf8");
  assert.match(script, /reviewDigest = review\.review_sha256/);
  assert.match(script, /\{ review_sha256: reviewDigest \}/);
  assert.match(script, /JSON\.stringify\(body\)/);
});

test("an attempt is spent before anything is spent on it", async () => {
  // Counting afterwards bounded nothing: calls arriving together all read the
  // same count, all made their GitHub calls, and all but one then lost the
  // write race, so one attempt was recorded for many rounds of Palomar's token
  // being pointed at a repository the caller named.
  const stub = stubAgent();
  const begun = await agentSubmit();
  stub.state.tag = { exists: false };

  const before = stub.written.length;
  const refused = await agentVerify({ pending_secret: begun.pending_secret, gist_id: "abc123" });
  assert.equal(refused.status, 403);
  const body = await refused.json();
  assert.equal(body.attempts_remaining, 9);

  // The reservation is a write, and it landed before the proof was looked at.
  const reservation = stub.written.slice(before).find((item) => item.path.startsWith("pending/"));
  assert.ok(reservation, "no attempt was reserved");
  assert.equal(reservation.value.attempts, 1);
});

test("a repository that changed identity is refused before the proof is read", async () => {
  // GitHub follows renames and transfers silently. Checking afterwards meant
  // Palomar's token had already made calls against whatever now answers to that
  // name, for a submission it was always going to refuse.
  const stub = stubAgent();
  const begun = await agentSubmit();
  stub.state.repoId = 111111;
  stub.state.tag = { exists: true, sha: "1".repeat(40) };
  stub.state.gist = { exists: true, content: begun.challenge };

  const asked = [];
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    asked.push(new URL(url).pathname);
    return inner(url, init);
  };
  const response = await agentVerify({ pending_secret: begun.pending_secret, gist_id: "abc123" });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /not the one this submission began for/);
  assert.ok(!asked.some((path) => path.includes("/git/ref/tags/")), "the tag was still read");
  assert.ok(!asked.some((path) => path.startsWith("/gists/")), "the gist was still read");
});

test("a gist that anybody could have found is not identity", async () => {
  // The challenge is public by construction: it is a tag name on a public
  // repository. A secret gist has to be handed over deliberately, and one made
  // before the challenge existed cannot have been made for it.
  for (const [gist, reason] of [
    [{ exists: true, public: true }, /public/],
    [{ exists: true, created_at: "2000-01-01T00:00:00Z" }, /predates/],
  ]) {
    const stub = stubAgent();
    const begun = await agentSubmit();
    stub.state.tag = { exists: true, sha: "1".repeat(40) };
    stub.state.gist = { ...gist, content: begun.challenge };
    const response = await agentVerify({
      pending_secret: begun.pending_secret, gist_id: "abc123",
    });
    assert.equal(response.status, 403);
    assert.match((await response.json()).gist, reason);
  }
});
