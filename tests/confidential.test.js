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
import { fakeR2 } from "./fake-r2.js";
import { githubTarball, githubTree, PLAIN_PROJECT } from "./tarball.js";
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
  CONFIDENTIAL_INTAKE: "test",
  GITHUB_TOKEN: "state-token",
  SUBMISSION_TOKEN: "dispatch-token",
  TOKEN_PEPPER: "test-pepper",
  OAUTH_CLIENT_ID: "client-id",
  OAUTH_CLIENT_SECRET: "client-secret",
  INTAKE_LIMITER: { limit: async () => ({ success: true }) },
  CONFIDENTIAL_SOURCE: fakeR2(),
  CONFIDENTIAL_R2_ACCOUNT_ID: "account",
  CONFIDENTIAL_R2_ACCESS_KEY_ID: "r2-read-key",
  CONFIDENTIAL_R2_SECRET_ACCESS_KEY: "r2-read-secret",
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
    if (path === `/repos/${REPOSITORY}/git/trees/${COMMIT}`) return Response.json(githubTree(PLAIN_PROJECT));
    if (path === `/repos/${REPOSITORY}/tarball/${COMMIT}`) return new Response(githubTarball(PLAIN_PROJECT));
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

function browser(path, form, env = ENV, cookie = "") {
  return worker.fetch(new Request(`https://submit.palomar-registry.org${path}`, {
    method: "POST",
    headers: { "sec-fetch-site": "same-origin", ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(form),
  }), env);
}

test("confidential intake is refused before any GitHub call where it cannot run privately", async () => {
  const { calls } = stubGitHub();
  const env = { ...ENV };
  delete env.CONFIDENTIAL_RUNS_REPO;
  const response = await browser("/submit", SUBMISSION, env);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /open only to invited authors/);
  assert.deepEqual(calls, []);
});

test("the agent route cannot start a confidential submission, in any mode", async () => {
  for (const mode of ["test", "invited"]) {
    const { calls } = stubGitHub();
    const response = await agent("/api/submit", SUBMISSION, { ...ENV, CONFIDENTIAL_INTAKE: mode });
    assert.equal(response.status, 400);
    assert.match(JSON.stringify(await response.json()), /open only to invited authors, through the browser/);
    assert.deepEqual(calls.filter((call) => !call.endsWith("/contents/pending")), []);
  }
});

test("the uniform refusal is the same words for every reason", async () => {
  stubGitHub();
  const machine = await (await agent("/api/submit", SUBMISSION)).json();
  stubGitHub();
  const off = await (await browser("/submit", SUBMISSION, { ...ENV, CONFIDENTIAL_INTAKE: "off" })).text();
  const { CONFIDENTIAL_REFUSAL } = await import("../src/confidential-intake.js");
  for (const line of CONFIDENTIAL_REFUSAL.detail) {
    assert.ok(JSON.stringify(machine).includes(line));
    assert.ok(off.includes(line));
  }
});

test("invited mode adds only the listed ids, and test mode only Technical Maintainers", async () => {
  const { confidentialIntakeAllowed } = await import("../src/confidential-intake.js");
  const list = new Set([4242]);
  const author = { id: 4242, login: "someone" };
  const maintainer = { id: TECHNICAL_MAINTAINER_ID, login: "kim-em" };
  assert.equal(confidentialIntakeAllowed({ ...ENV, CONFIDENTIAL_INTAKE: "invited" }, author, list), true);
  assert.equal(confidentialIntakeAllowed({ ...ENV, CONFIDENTIAL_INTAKE: "invited" }, { id: 1 }, list), false);
  assert.equal(confidentialIntakeAllowed({ ...ENV, CONFIDENTIAL_INTAKE: "test" }, author, list), false);
  assert.equal(confidentialIntakeAllowed({ ...ENV, CONFIDENTIAL_INTAKE: "test" }, maintainer, list), true);
  assert.equal(confidentialIntakeAllowed({ ...ENV, CONFIDENTIAL_INTAKE: "off" }, maintainer, list), false);
  assert.equal(confidentialIntakeAllowed({ ...ENV, CONFIDENTIAL_INTAKE: "invited" }, { login: "no-id" }, list), false);
  // The shipped list parses, and nobody is invited until PalomarPolicy says so.
  assert.equal(confidentialIntakeAllowed({ ...ENV, CONFIDENTIAL_INTAKE: "invited" }, author), false);
});

test("confidential intake answers nothing about the source before the proof", async () => {
  const { calls, messages, store } = stubGitHub({
    repo: { id: 77, private: false, owner: { login: "owner", id: 5 } },
  });
  const response = await browser("/submit", SUBMISSION);
  assert.equal(response.status, 303);
  // Nothing about the repository is read before sign-in: not the repository,
  // not the commit, and no preflight. It may be private.
  assert.ok(!calls.some((call) => call.includes(`/repos/${REPOSITORY}`)), calls.join("\n"));
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
  assert.equal(body.visibility, undefined);
  assert.deepEqual(messages, [`Begin submission for ${REPOSITORY}`]);
  assert.equal(calls.length > 0, true);
});

const TECHNICAL_MAINTAINER_ID = 477956;
const BINDING = "9".repeat(64);

/** Finish a browser sign-in for a confidential pending intake. */
async function signIn({ id = TECHNICAL_MAINTAINER_ID, login = "maintainer", push = true,
  relationship = "maintainer" } = {}) {
  const { digest } = await import("../src/submission.js");
  const nonce = "8".repeat(64);
  const pendingPath = `pending/${await digest(nonce)}.json`;
  const stub = stubGitHub({
    files: {
      "index/inflight.json": { open: [] },
      "index/open.json": { schema_version: 1, open: [] },
      [pendingPath]: {
        schema_version: 2,
        binding_sha256: await digest(BINDING),
        method: "oauth",
        challenge: "7".repeat(64),
        repository_id: 77,
        attempts: 0,
        repository: REPOSITORY,
        commit: COMMIT,
        existing_id: null,
        context: null,
        requested_paths: { project_path: null, comparator_config_path: "comparator.json",
          formalization_metadata_path: null },
        authorization_relationship: relationship,
        authorization_evidence: null,
        visibility: "confidential",
        created_at: new Date().toISOString(),
      },
    },
    repo: { id: 77, private: false, owner: { login: "owner", id: 5 }, permissions: { push } },
  });
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(url);
    if (target.hostname === "github.com" && target.pathname.endsWith("/access_token")) {
      return Response.json({ access_token: "oauth-token" });
    }
    if (target.pathname === "/user") return Response.json({ login, id });
    return inner(url, init);
  };
  const name = `__Host-palomar_intake_${(await digest(nonce)).slice(0, 16)}`;
  const response = await worker.fetch(new Request(
    `https://submit.palomar-registry.org/oauth/callback?code=c&state=${nonce}`,
    { headers: { cookie: `${name}=${BINDING}` } },
  ), ENV);
  return { ...stub, response };
}

test("a Technical Maintainer's confidential submission is admitted and runs privately", async () => {
  const { response, store, dispatches, messages } = await signIn();
  assert.equal(response.status, 303);
  const [path, record] = [...store.entries()].find(([key]) => key.endsWith("/state.json"));
  assert.ok(path);
  assert.equal(record.visibility, "confidential");
  assert.equal(record.authorization.relationship, "maintainer");
  assert.match(record.confidential.source_sha256, /^[0-9a-f]{64}$/);
  assert.equal(Object.keys(record.confidential).length, 1);
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].repository, RUNS);
  assert.equal(dispatches[0].workflow, "verify.yml");
  assert.equal(dispatches[0].body.inputs.request_id, record.id);
  // No State commit made for this submission names its source.
  assert.ok(messages.length > 0);
  for (const message of messages) assert.doesNotMatch(message, /owner|project/, message);
});

test("anyone else's confidential submission is refused in test mode", async () => {
  const { response, store, dispatches } = await signIn({ id: 4242, login: "someone" });
  assert.equal(response.status, 403);
  assert.match(await response.text(), /open only to invited authors/);
  assert.ok(![...store.keys()].some((key) => key.endsWith("/state.json")));
  assert.deepEqual(dispatches, []);
});

function confidentialRecord(overrides = {}) {
  return {
    schema_version: 1,
    id: "a1b2c3d4e5f6",
    visibility: "confidential",
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
    confidentialRecord({ visibility: "unlisted" }),
    { id: "x", confidential: {} },
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

test("the activation switch admits nothing when off, unknown or absent", async () => {
  for (const mode of ["off", "", "on", "Test", "test-public", undefined]) {
    const env = { ...ENV, CONFIDENTIAL_INTAKE: mode };
    if (mode === undefined) delete env.CONFIDENTIAL_INTAKE;
    const { calls } = stubGitHub();
    const response = await browser("/submit", SUBMISSION, env);
    assert.equal(response.status, 400, String(mode));
    assert.match(await response.text(), /open only to invited authors/);
    assert.deepEqual(calls.filter((call) => !call.endsWith("/contents/pending")), []);
  }
});

test("admission rechecks the switch, so turning it off stops a begun intake", async () => {
  const saved = ENV.CONFIDENTIAL_INTAKE;
  ENV.CONFIDENTIAL_INTAKE = "off";
  try {
    const { response, store, dispatches } = await signIn();
    assert.equal(response.status, 403);
    assert.ok(![...store.keys()].some((key) => key.endsWith("/state.json")));
    assert.deepEqual(dispatches, []);
  } finally {
    ENV.CONFIDENTIAL_INTAKE = saved;
  }
});

test("public intake is unaffected by every switch value", async () => {
  for (const mode of ["off", "test", "invited", "garbage"]) {
    const { messages } = stubGitHub();
    globalThis.fetch = ((inner) => async (url, init) => {
      if (/git\/trees/.test(String(url))) return Response.json({ tree: [] });
      return inner(url, init);
    })(globalThis.fetch);
    const publicSubmission = { ...SUBMISSION };
    delete publicSubmission.visibility;
    const response = await agent("/api/submit", publicSubmission, { ...ENV, CONFIDENTIAL_INTAKE: mode });
    assert.equal(response.status, 200, mode);
    assert.deepEqual(messages, [`Begin submission for ${REPOSITORY}`]);
  }
});

test("claiming the test relationship does not admit a confidential submission", async () => {
  const { response, store, dispatches } = await signIn({ id: 4242, login: "someone", relationship: "technical-test" });
  assert.equal(response.status, 403);
  assert.ok(![...store.keys()].some((key) => key.endsWith("/state.json")));
  assert.deepEqual(dispatches, []);
});

test("a confidential record is never registered and never opens a repair", async () => {
  stubGitHub({ files: await submissionFiles(confidentialRecord({ status: "review-ready", review_sha256: "f".repeat(64) })) });
  const register = await worker.fetch(new Request("https://submit.palomar-registry.org/register", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ review_sha256: "f".repeat(64) }),
  }), ENV);
  assert.equal(register.status, 409);
  assert.match((await register.json()).error, /held, not registered/);
  const repair = await worker.fetch(new Request("https://submit.palomar-registry.org/api/repair", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ edits: [] }),
  }), ENV);
  assert.equal(repair.status, 409);
});

test("the form offers confidential visibility only while intake is open", async () => {
  const { intakeForm } = await import("../src/html.js");
  assert.match(intakeForm(ENV, {}), /visibility-choice/);
  assert.doesNotMatch(intakeForm({ ...ENV, CONFIDENTIAL_INTAKE: "off" }, {}), /visibility-choice/);
});
