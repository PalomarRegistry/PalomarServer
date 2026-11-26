/**
 * Confidential intake: where the run goes, and what is said before the proof.
 *
 * A confidential submission must never reach the public verification
 * repository, must never name its source in a State commit, and must not
 * answer anything about the source before the submitter has proved who they
 * are. GitHub is stubbed at the fetch boundary.
 */

import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";
import { validateIntake } from "../src/intake-contract.js";
import { tokenDigest, statePath } from "../src/submission.js";
import {
  dispatchSubmissionVerification,
  reconcile,
  verificationOrigin,
} from "../src/submission-lifecycle.js";

const RUNS = "PalomarRegistry/PalomarConfidentialRuns";
const ENV = {
  SITE_URL: "https://palomar-registry.org",
  STATE_REPO: "PalomarRegistry/PalomarSubmissionState",
  SUBMISSION_REPO: "PalomarRegistry/PalomarSubmission",
  VERIFY_WORKFLOW: "submission.yml",
  CONFIDENTIAL_RUNS_REPO: RUNS,
  CONFIDENTIAL_VERIFY_WORKFLOW: "verify.yml",
  GITHUB_TOKEN: "state-token",
  SUBMISSION_TOKEN: "dispatch-token",
  TOKEN_PEPPER: "test-pepper",
  OAUTH_CLIENT_ID: "client-id",
  OAUTH_CLIENT_SECRET: "client-secret",
  INTAKE_LIMITER: { limit: async () => ({ success: true }) },
};
const REPOSITORY = "owner/project";
const COMMIT = "c".repeat(40);
const SUBMISSION = {
  repository: REPOSITORY,
  commit: COMMIT,
  comparator_config_path: "comparator.json",
  authorization_relationship: "maintainer",
  visibility: "confidential",
};

function encode(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf-8").toString("base64");
}

function fields(values) {
  return new Map(Object.entries(values));
}

/**
 * A GitHub that holds State in memory and records every other call.
 *
 * `messages` collects every State commit message, `dispatches` every
 * workflow_dispatch, and `calls` every request, so a test can say both what
 * happened and what did not.
 */
function stubGitHub({ files = {}, repo = { id: 77, private: false, owner: { login: "owner" } },
  tags = {}, gist = null, runs = [], jobs = [], annotations = {} } = {}) {
  const store = new Map(Object.entries(files));
  const messages = [];
  const dispatches = [];
  const calls = [];
  let staged = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(url);
    const method = init.method ?? "GET";
    const path = target.pathname;
    calls.push(`${method} ${target.origin}${path}`);
    const state = `/repos/${ENV.STATE_REPO}`;
    if (path === `${state}/git/ref/heads/main`) {
      return Response.json({ object: { type: "commit", sha: "a".repeat(40) } });
    }
    if (path === `${state}/git/commits/${"a".repeat(40)}`) {
      return Response.json({ tree: { sha: "b".repeat(40) } });
    }
    if (path === `${state}/git/trees` && method === "POST") {
      staged = JSON.parse(init.body).tree;
      return Response.json({ sha: "c".repeat(40) });
    }
    if (path === `${state}/git/commits` && method === "POST") {
      messages.push(JSON.parse(init.body).message);
      return Response.json({ sha: "d".repeat(40) });
    }
    if (path === `${state}/git/refs/heads/main` && method === "PATCH") {
      for (const change of staged) {
        if (change.sha === null) store.delete(change.path);
        else store.set(change.path, JSON.parse(change.content));
      }
      return Response.json({ object: { sha: "d".repeat(40) } });
    }
    if (path.startsWith(`${state}/contents/`)) {
      const name = decodeURI(path.slice(`${state}/contents/`.length));
      if (method === "GET") {
        if (name === "pending") return Response.json([]);
        if (!store.has(name)) return new Response("", { status: 404 });
        return Response.json({ content: encode(store.get(name)), sha: `sha-${name}` });
      }
      if (method === "DELETE") {
        messages.push(JSON.parse(init.body).message);
        store.delete(name);
        return Response.json({});
      }
      const body = JSON.parse(init.body);
      messages.push(body.message);
      store.set(name, JSON.parse(Buffer.from(body.content, "base64").toString("utf-8")));
      return Response.json({ content: {} });
    }
    if (path === `/repos/${REPOSITORY}`) return repo ? Response.json(repo) : new Response("", { status: 404 });
    if (path === `/repos/${REPOSITORY}/commits/${COMMIT}`) return Response.json({ sha: COMMIT });
    const tag = /^\/repos\/owner\/project\/git\/ref\/tags\/(.+)$/.exec(path);
    if (tag) {
      return tags[tag[1]]
        ? Response.json({ object: { type: "commit", sha: tags[tag[1]] } })
        : new Response("", { status: 404 });
    }
    if (path.startsWith("/gists/")) return gist ? Response.json(gist) : new Response("", { status: 404 });
    const dispatch = /^\/repos\/(.+)\/actions\/workflows\/([^/]+)\/dispatches$/.exec(path);
    if (dispatch && method === "POST") {
      dispatches.push({ repository: dispatch[1], workflow: dispatch[2], body: JSON.parse(init.body) });
      return new Response(null, { status: 204 });
    }
    if (/\/actions\/workflows\/[^/]+\/runs$/.test(path)) {
      return Response.json({ workflow_runs: runs });
    }
    const byId = /\/actions\/runs\/(\d+)$/.exec(path);
    if (byId) {
      const run = runs.find((item) => String(item.id) === byId[1]);
      return run ? Response.json(run) : new Response("", { status: 404 });
    }
    if (/\/actions\/runs\/\d+\/jobs$/.test(path)) return Response.json({ jobs });
    const annotated = /\/check-runs\/(\d+)\/annotations$/.exec(path);
    if (annotated) return Response.json(annotations[annotated[1]] ?? []);
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { store, messages, dispatches, calls };
}

function agent(path, body, env = ENV) {
  return worker.fetch(new Request(`https://submit.palomar-registry.org${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), env);
}

test("the intake validation matrix for visibility", () => {
  const base = {
    repository: REPOSITORY, commit: COMMIT, comparator_config_path: "comparator.json",
    authorization_relationship: "maintainer",
  };
  // Absent and explicit public are the same, unchanged projection.
  for (const extra of [{}, { visibility: "public" }]) {
    const result = validateIntake(fields({ ...base, ...extra }));
    assert.deepEqual(result.problems, []);
    assert.equal("visibility" in result.submission, false);
  }
  const confidential = validateIntake(fields({ ...base, visibility: "confidential" }));
  assert.deepEqual(confidential.problems, []);
  assert.equal(confidential.submission.visibility, "confidential");
  // A marked test may be confidential, for end-to-end testing.
  assert.deepEqual(validateIntake(fields({
    ...base, visibility: "confidential", authorization_relationship: "technical-test",
  })).problems, []);
  for (const [extra, pattern] of [
    [{ visibility: "secret" }, /Visibility must be public or confidential/],
    [{ visibility: "confidential", existing_id: "PALOMAR-2026-07-29-000123" }, /new result/],
    [{ visibility: "confidential", authorization_relationship: "palomar-maintainer" }, /registry correction cannot be confidential/],
    [{ visibility: "confidential", registry_correction: "{}" }, /registry correction cannot be confidential/],
    [{ visibility: "confidential", preflight_repair: "{}" }, /repair pull request/],
  ]) {
    const result = validateIntake(fields({ ...base, ...extra }));
    assert.equal(result.submission, null);
    assert.ok(result.problems.some((problem) => pattern.test(problem)), JSON.stringify(result.problems));
  }
});

test("confidential intake is refused before any GitHub call where it cannot run privately", async () => {
  const { calls } = stubGitHub();
  const env = { ...ENV };
  delete env.CONFIDENTIAL_RUNS_REPO;
  const response = await agent("/api/submit", SUBMISSION, env);
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /not available/);
  assert.deepEqual(calls, []);
});

test("a private repository is still refused for a confidential submission", async () => {
  const { messages } = stubGitHub({ repo: { id: 77, private: true, owner: { login: "owner" } } });
  const response = await agent("/api/submit", SUBMISSION);
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /cannot read private repositories yet/);
  assert.deepEqual(messages, []);
});

test("confidential intake answers nothing about the source before the proof", async () => {
  const { calls, messages, store } = stubGitHub();
  const response = await agent("/api/submit", SUBMISSION);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.source_preflight, undefined);
  assert.equal(body.visibility, "confidential");
  // No tree or file read: the preflight is skipped, not merely hidden.
  assert.ok(!calls.some((call) => /git\/trees|raw\.githubusercontent/.test(call)), calls.join("\n"));
  // The neutral tag, which does not say Palomar in a public event feed.
  assert.match(body.instructions, new RegExp(`refs/tags/c-${body.challenge}`));
  assert.doesNotMatch(body.instructions, /palomar-verify-/);
  assert.deepEqual(messages, ["Begin submission"]);
  const pending = [...store.entries()].find(([path]) => path.startsWith("pending/"))[1];
  assert.equal(pending.visibility, "confidential");
});

test("a public intake keeps its preflight and its commit message", async () => {
  const { calls, messages } = stubGitHub();
  globalThis.fetch = ((inner) => async (url, init) => {
    if (/git\/trees/.test(String(url))) return Response.json({ tree: [] });
    return inner(url, init);
  })(globalThis.fetch);
  const publicSubmission = { ...SUBMISSION };
  delete publicSubmission.visibility;
  const body = await (await agent("/api/submit", publicSubmission)).json();
  assert.ok(body.source_preflight);
  assert.match(body.instructions, /palomar-verify-/);
  assert.deepEqual(messages, [`Begin submission for ${REPOSITORY}`]);
  assert.equal(calls.length > 0, true);
});

async function admitConfidential({ tagPrefix = "c-" } = {}) {
  const stub = stubGitHub({
    files: {
      "index/inflight.json": { open: [] },
      "index/open.json": { schema_version: 1, open: [] },
    },
  });
  const begun = await (await agent("/api/submit", SUBMISSION)).json();
  stub.messages.length = 0;
  const tags = { [`${tagPrefix}${begun.challenge}`]: COMMIT };
  const gist = {
    public: false,
    created_at: new Date().toISOString(),
    owner: { type: "User", login: "someone", id: 4242 },
    files: { "palomar.txt": { content: begun.challenge } },
  };
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const tag = /^\/repos\/owner\/project\/git\/ref\/tags\/(.+)$/.exec(path);
    if (tag) {
      return tags[tag[1]]
        ? Response.json({ object: { type: "commit", sha: tags[tag[1]] } })
        : new Response("", { status: 404 });
    }
    if (path.startsWith("/gists/")) return Response.json(gist);
    return inner(url, init);
  };
  const response = await agent("/api/verify", { pending_secret: begun.pending_secret, gist_id: "abc123" });
  return { ...stub, response, begun };
}

test("an admitted confidential submission dispatches only to the private caller", async () => {
  const { response, store, dispatches, messages, begun } = await admitConfidential();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(body.next, new RegExp(`refs/tags/c-${begun.challenge}`));
  const record = store.get(statePath(body.submission_id, "state.json"));
  assert.equal(record.visibility, "confidential");
  assert.deepEqual(record.confidential, { run_repository: RUNS });
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].repository, RUNS);
  assert.equal(dispatches[0].workflow, "verify.yml");
  assert.equal(dispatches[0].body.inputs.request_id, body.submission_id);
  // No State commit made for this submission names its source.
  assert.ok(messages.length > 0);
  for (const message of messages) {
    assert.doesNotMatch(message, /owner|project/, message);
  }
});

test("a confidential proof still accepts the older tag prefix", async () => {
  const { response, begun } = await admitConfidential({ tagPrefix: "palomar-verify-" });
  assert.equal(response.status, 200);
  assert.match((await response.json()).next, new RegExp(`palomar-verify-${begun.challenge}`));
});

function confidentialRecord(overrides = {}) {
  return {
    schema_version: 1,
    id: "a1b2c3d4e5f6",
    visibility: "confidential",
    confidential: { run_repository: RUNS },
    status: "verifying",
    repository: REPOSITORY,
    commit: COMMIT,
    owner: "owner",
    submitter: "someone",
    authorization: { relationship: "maintainer" },
    requested_paths: { comparator_config_path: "comparator.json" },
    created_at: "2026-11-26T00:00:00Z",
    events: [],
    ...overrides,
  };
}

test("the dispatch target is derived from the record's visibility and fails closed", async () => {
  assert.deepEqual(verificationOrigin(ENV, { id: "x" }), {
    repository: ENV.SUBMISSION_REPO, workflow: "submission.yml", private: false,
  });
  assert.deepEqual(verificationOrigin(ENV, confidentialRecord()), {
    repository: RUNS, workflow: "verify.yml", private: true,
  });
  for (const record of [
    confidentialRecord({ confidential: { run_repository: "PalomarRegistry/PalomarSubmission" } }),
    confidentialRecord({ confidential: undefined }),
    confidentialRecord({ visibility: "unlisted" }),
    { id: "x", confidential: { run_repository: RUNS } },
  ]) {
    assert.throws(() => verificationOrigin(ENV, record));
  }
  const env = { ...ENV };
  delete env.CONFIDENTIAL_VERIFY_WORKFLOW;
  assert.throws(() => verificationOrigin(env, confidentialRecord()));
  // And a refused origin dispatches nothing at all.
  const { dispatches } = stubGitHub();
  await assert.rejects(dispatchSubmissionVerification(env, confidentialRecord()));
  assert.deepEqual(dispatches, []);
});

test("the scheduled pass finds a confidential run in the private caller by its name", async () => {
  const record = confidentialRecord();
  const { store, calls } = stubGitHub({
    files: {
      "index/inflight.json": { open: [{ id: record.id, owner: "owner", submitter: "someone", at: record.created_at }] },
      "index/open.json": { schema_version: 1, open: [] },
      [statePath(record.id, "state.json")]: record,
    },
    runs: [
      // A public run carrying the same id must not be taken for it.
      { id: 1, name: `Verify submission ${record.id}`, status: "in_progress" },
      { id: 2, name: `Verify ${record.id}`, status: "in_progress", html_url: `https://github.com/${RUNS}/actions/runs/2` },
    ],
  });
  await reconcile(ENV);
  assert.equal(store.get(statePath(record.id, "state.json")).run.id, 2);
  assert.ok(calls.some((call) => call.includes(`/repos/${RUNS}/actions/workflows/verify.yml/runs`)));
  assert.ok(!calls.some((call) => call.includes("/repos/PalomarRegistry/PalomarSubmission/")));
});

const TOKEN = "e".repeat(64);

async function submissionFiles(record) {
  return {
    "index/inflight.json": { open: [] },
    "index/open.json": { schema_version: 1, open: [] },
    [`index/tokens/${await tokenDigest(ENV, TOKEN)}.json`]: { id: record.id },
    [statePath(record.id, "state.json")]: record,
  };
}

function bearer(path) {
  return worker.fetch(new Request(`https://submit.palomar-registry.org${path}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  }), ENV);
}

test("the status API marks a private run and withholds its URL", async () => {
  const run = { id: 9, status: "completed", conclusion: "failure",
    url: `https://github.com/${RUNS}/actions/runs/9`, started_at: "2026-11-26T00:01:00Z" };
  stubGitHub({ files: await submissionFiles(confidentialRecord({ status: "verification-failed", run })) });
  const body = await (await bearer("/api/submission")).json();
  assert.equal(body.visibility, "confidential");
  assert.deepEqual(body.run, {
    id: 9, status: "completed", conclusion: "failure",
    started_at: "2026-11-26T00:01:00Z", visibility: "private",
  });
  assert.doesNotMatch(JSON.stringify(body), /PalomarConfidentialRuns/);
});

test("the diagnostics proxy returns only the token holder's own pinned run", async () => {
  const run = { id: 9, status: "completed", conclusion: "failure" };
  const { calls } = stubGitHub({
    files: await submissionFiles(confidentialRecord({ id: "z9y8x7w6v5u4", status: "verification-failed", run })),
    jobs: [{ id: 31, name: "verify", status: "completed", conclusion: "failure",
      steps: [{ name: "Build", conclusion: "failure" }] }],
    annotations: { 31: [{ annotation_level: "failure", title: "", message: "Challenge.lean:3: unknown identifier" }] },
  });
  const response = await bearer("/api/submission/diagnostics?run=1");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.run.id, 9);
  assert.equal(body.run.url, undefined);
  assert.equal(body.annotations[0].message, "Challenge.lean:3: unknown identifier");
  assert.deepEqual(body.jobs[0].steps, [{ name: "Build", conclusion: "failure" }]);
  // Read from the record's run repository and run, never from the query.
  assert.ok(calls.some((call) => call.endsWith(`/repos/${RUNS}/actions/runs/9/jobs`)));
  assert.ok(!calls.some((call) => /runs\/1\b/.test(call)));
});

test("the diagnostics proxy refuses public and unfinished runs", async () => {
  stubGitHub({ files: await submissionFiles(confidentialRecord({
    id: "q1q1q1q1q1q1", run: { id: 5, status: "in_progress" } })) });
  assert.equal((await bearer("/api/submission/diagnostics")).status, 409);
  const publicRecord = confidentialRecord({ id: "p1p1p1p1p1p1", status: "verification-failed",
    run: { id: 5, status: "completed", conclusion: "failure" } });
  delete publicRecord.visibility;
  delete publicRecord.confidential;
  stubGitHub({ files: await submissionFiles(publicRecord) });
  assert.equal((await bearer("/api/submission/diagnostics")).status, 409);
  stubGitHub();
  const anonymous = await worker.fetch(new Request(
    "https://submit.palomar-registry.org/api/submission/diagnostics",
    { headers: { authorization: `Bearer ${"0".repeat(64)}` } },
  ), ENV);
  assert.equal(anonymous.status, 404);
});

test("the status page reads a private run's diagnostics only through Palomar", async () => {
  const { readFile } = await import("node:fs/promises");
  const script = await readFile(new URL("../public/status.js", import.meta.url), "utf8");
  assert.match(script, /submissionRequest\(token, "\/api\/submission\/diagnostics"\)/);
  const { privateVerificationRun } = await import("../public/statuses.js");
  assert.deepEqual(privateVerificationRun({ id: 9, status: "completed", conclusion: "failure",
    visibility: "private" }), { runId: 9, private: true });
  assert.equal(privateVerificationRun({ id: 9, status: "completed", conclusion: "success",
    visibility: "private" }), null);
  assert.equal(privateVerificationRun({ id: 9, status: "completed", conclusion: "failure" }), null);
});
