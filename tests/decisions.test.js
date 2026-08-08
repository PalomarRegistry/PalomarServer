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
  assert.equal((await held.json()).passed, true);

  const anonymous = await worker.fetch(request("/api/review", "GET", ""), ENV);
  assert.equal(anonymous.status, 404);

  const wrongToken = await worker.fetch(
    request("/api/review", "GET", `palomar_session=${"b".repeat(64)}`),
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
  const { written } = stubState(await fixture({ status: "review-failed" }));
  const response = await worker.fetch(request("/withdraw", "POST"), ENV);
  assert.equal(response.status, 200);
  const state = written.find((item) => item.path.endsWith("state.json"));
  assert.equal(state.value.status, "withdrawn");
  assert.equal(state.value.events.at(-1).note, "Withdrawn by the submitter");
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
  stubState(await fixture());
  for (const method of ["GET", "HEAD"]) {
    const response = await worker.fetch(request("/healthz", method), ENV);
    assert.equal(response.status, 200, `${method} did not answer`);
  }
  const body = await (await worker.fetch(request("/healthz"), ENV)).json();
  assert.deepEqual(body, { ok: true });
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
        headers: { "content-type": "application/json" },
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
      body: new URLSearchParams({ token: TOKEN }),
    }),
    ENV,
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), new RegExp(`palomar_session=${TOKEN}`));
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
  // there is no point asking about, and `review-failed` is the single status
  // that is the other way round: nothing moves it on its own, so the page stops
  // asking, but the submitter may still withdraw it. Written as one derivation
  // from one list so that nobody can quietly make the two equal, in either
  // direction, without saying so here.
  const { CLOSED, SETTLED } = await import("../public/statuses.js");
  for (const status of CLOSED) {
    assert.ok(SETTLED.has(status), `${status} is closed but the page would keep asking about it`);
  }
  assert.deepEqual([...SETTLED].filter((status) => !CLOSED.has(status)), ["review-failed"]);
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

/**
 * The push check, which had no test at all.
 *
 * `permissions.push` on the repository, read with the submitter's own token,
 * is the entire proof that a submitter may submit a repository. Everything
 * downstream rests on it: the reviewer refuses to register anything whose
 * record does not carry `push_verified`. It was never exercised, so nothing
 * would have noticed it being inverted, skipped, or refactored away.
 */
function stubOAuth({ push, files = {}, login = "someone" }) {
  const written = [];
  const store = new Map(Object.entries(files));
  const deleted = [];
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
    if (target.pathname.includes("/actions/workflows/")) return Response.json({ ok: true });
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
  return { written, deleted, store };
}

const PENDING = {
  schema_version: 1,
  repository: "example/project",
  commit: "1".repeat(40),
  existing_id: null,
  context: null,
  requested_paths: {},
  authorization_relationship: "maintainer",
  authorization_evidence: null,
  created_at: "2026-08-01T00:00:00Z",
};

async function callback(nonce) {
  return worker.fetch(
    new Request(`https://submit.palomar-registry.org/oauth/callback?code=c&state=${nonce}`),
    ENV,
  );
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
  assert.deepEqual(written.map((item) => item.path), []);
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
  const state = { tag: {}, gist: {}, repoId: 987654321, ...config };
  const written = [];
  const store = new Map();
  const deleted = [];
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
    if (target.pathname.includes("/actions/workflows/")) return Response.json({ ok: true });
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
  return { written, deleted, store, state };
}

const AGENT_SUBMISSION = {
  repository: "example/project",
  commit: "1".repeat(40),
  comparator_config_path: "comparator.json",
  authorization_relationship: "maintainer",
};

async function agentSubmit() {
  const response = await worker.fetch(
    new Request("https://submit.palomar-registry.org/api/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(AGENT_SUBMISSION),
    }),
    ENV,
  );
  return response.json();
}

async function agentVerify(body) {
  return worker.fetch(
    new Request("https://submit.palomar-registry.org/api/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    ENV,
  );
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

test("indexing a submission keeps the entries and the rebuild clock beside it", async () => {
  // Written by two writers: this one appends, the reviewer prunes and records
  // when the whole file next needs rebuilding from the records. Dropping what
  // the other end put there would make the index look permanently overdue, and
  // an overdue index is rebuilt by cloning every record there is.
  const stub = stubAgent();
  stub.store.set("index/open.json", {
    schema_version: 1,
    rebuild_after: "2099-01-01T00:00:00Z",
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
  assert.match((await second.json()).error, /rate limit/);

  // Time passing lets it through, and doubles the wait again.
  const file = [...stub.store.keys()].find((path) => path.startsWith("index/rate/"));
  stub.store.set(file, { ...stub.store.get(file), next_allowed_at: "2020-01-01T00:00:00Z" });
  assert.equal((await submit()).status, 200);
  assert.equal(rate().interval_seconds, 120, "a second start did not double the wait");
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
    new Request("https://submit.palomar-registry.org/api/submission", {
      headers: { cookie: `palomar_session=${verified.access_token}` },
    }),
    ENV,
  );
  assert.equal(response.status, 200);
  assert.equal(stub.store.get(file).interval_seconds, 60, "registering did not clear the wait");
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
