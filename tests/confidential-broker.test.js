/**
 * The confidential intake, OIDC and ticket foundation (contract v2 3.1, 3.2).
 *
 * Every refusal the contract lists is exercised on its own, against an
 * otherwise valid request, so a test passes only because that one check
 * holds.
 */

import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";
import {
  callerTemplateMatches,
  OIDC_AUDIENCE,
  OIDC_ISSUER,
  OidcRefusal,
  resetJwksCache,
  validateBrokerToken,
  verifyJwt,
} from "../src/confidential/oidc.js";
import { issueTicket, MAX_MINTS, presentTicket, poisonTicket } from "../src/confidential/tickets.js";
import {
  canonicalJson,
  kindDigest,
  newRandomId,
  newToken,
  TOKEN_RE,
} from "../src/confidential/tokens.js";
import { mintSourceReadToken } from "../src/confidential/source-app.js";
import {
  authorizationExhausted,
  authorizePrivateRepository,
  MAX_FAILURES_PER_HOUR,
  NOT_AUTHORIZED,
} from "../src/confidential/private-intake.js";
import { digest, statePath } from "../src/submission.js";

const P = "a".repeat(40);
const R = "b".repeat(40);
const RUNS = "PalomarRegistry/PalomarConfidentialRuns";
const ENV = {
  SITE_URL: "https://palomar-registry.org",
  STATE_REPO: "PalomarRegistry/PalomarSubmissionState",
  SUBMISSION_REPO: "PalomarRegistry/PalomarSubmission",
  VERIFY_WORKFLOW: "submission.yml",
  CONFIDENTIAL_RUNS_REPO: RUNS,
  CONFIDENTIAL_VERIFY_WORKFLOW: "verify.yml",
  CONFIDENTIAL_INTAKE: "test-public",
  PALOMAR_ORG_ID: "1000",
  CONFIDENTIAL_RUNS_REPOSITORY_ID: "2000",
  STATE_REPOSITORY_ID: "3000",
  CONFIDENTIAL_PIPELINE_ALLOWLIST: `${P},${"c".repeat(40)}`,
  CONFIDENTIAL_REVIEWER_ALLOWLIST: `${R},${"d".repeat(40)}`,
  GITHUB_TOKEN: "state-token",
  SUBMISSION_TOKEN: "dispatch-token",
  TOKEN_PEPPER: "test-pepper",
  OAUTH_CLIENT_ID: "client-id",
  OAUTH_CLIENT_SECRET: "client-secret",
  INTAKE_LIMITER: { limit: async () => ({ success: true }) },
};

// One RSA key pair for the suite, standing in for GitHub's OIDC signer.
const signer = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256" },
  true, ["sign", "verify"],
);
const publicJwk = { ...(await crypto.subtle.exportKey("jwk", signer.publicKey)), kid: "k1", use: "sig", alg: "RS256" };
let jwksFetches = 0;

function b64url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Buffer.from(bytes).toString("base64url");
}

async function sign(claims, header = { alg: "RS256", typ: "JWT", kid: "k1" }) {
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = new Uint8Array(await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", signer.privateKey, new TextEncoder().encode(unsigned)));
  return `${unsigned}.${b64url(signature)}`;
}

const NOW = Date.parse("2026-11-26T12:00:00Z");
const SECONDS = Math.floor(NOW / 1000);

function runsClaims(overrides = {}) {
  return {
    iss: OIDC_ISSUER,
    aud: OIDC_AUDIENCE,
    iat: SECONDS - 10,
    nbf: SECONDS - 10,
    exp: SECONDS + 290,
    repository_owner_id: "1000",
    repository_visibility: "private",
    ref: "refs/heads/main",
    runner_environment: "github-hosted",
    repository_id: "2000",
    repository: RUNS,
    workflow_ref: `${RUNS}/.github/workflows/verify.yml@refs/heads/main`,
    workflow_sha: "e".repeat(40),
    job_workflow_ref: `PalomarRegistry/PalomarSubmission/.github/workflows/confidential-snapshot.yml@${P}`,
    job_workflow_sha: P,
    event_name: "workflow_dispatch",
    run_id: "555",
    run_attempt: "1",
    ...overrides,
  };
}

function stateClaims(overrides = {}) {
  return runsClaims({
    repository_id: "3000",
    repository: "PalomarRegistry/PalomarSubmissionState",
    workflow_ref: "PalomarRegistry/PalomarSubmissionState/.github/workflows/reviewer.yml@refs/heads/main",
    job_workflow_ref: `PalomarRegistry/PalomarReviewer/.github/workflows/confidential-objects.yml@${R}`,
    job_workflow_sha: R,
    ...overrides,
  });
}

function serveJwks() {
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/.well-known/jwks")) {
      jwksFetches += 1;
      return Response.json({ keys: [publicJwk] });
    }
    throw new Error(`unexpected ${url}`);
  };
}

const callerOk = async () => true;
// Control's revocation set, as the broker will consult it.
const REVOKED = new Set(["c".repeat(40), "d".repeat(40)]);
const isRevoked = async ({ commit }) => REVOKED.has(commit);

async function refusal(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof OidcRefusal, String(error));
    return error.reason;
  }
  assert.fail("the token was accepted");
}

test("a valid runs-repository token validates and names its binding and pin", async () => {
  resetJwksCache();
  serveJwks();
  const token = await sign(runsClaims());
  const result = await validateBrokerToken(ENV, token, "snapshot", { now: NOW, callerMatches: callerOk, isRevoked });
  assert.deepEqual(result, {
    origin: "runs",
    operation: "snapshot",
    pipeline_commit: P,
    binding: { run_id: "555", run_attempt: "1", repository_id: "2000" },
    identity: {
      repository_id: "2000",
      workflow: "PalomarRegistry/PalomarSubmission/.github/workflows/confidential-snapshot.yml",
    },
  });
});

test("each JWT check refuses on its own", async () => {
  resetJwksCache();
  serveJwks();
  const cases = [
    ["iss", runsClaims({ iss: "https://example.test" })],
    ["aud", runsClaims({ aud: "palomar-source-broker" })],
    ["aud", runsClaims({ aud: [OIDC_AUDIENCE] })],
    ["exp", runsClaims({ exp: SECONDS - 1 })],
    ["iat", runsClaims({ iat: SECONDS + 120, exp: SECONDS + 300 })],
    ["nbf", runsClaims({ nbf: SECONDS + 120 })],
    ["lifetime", runsClaims({ iat: SECONDS - 10, exp: SECONDS + 600 })],
    ["owner", runsClaims({ repository_owner_id: "9999" })],
    ["visibility", runsClaims({ repository_visibility: "public" })],
    ["ref", runsClaims({ ref: "refs/heads/feature" })],
    ["runner", runsClaims({ runner_environment: "self-hosted" })],
    ["identity", runsClaims({ repository_id: "2001" })],
    ["identity", runsClaims({ repository: "PalomarRegistry/Other" })],
    ["identity", runsClaims({ workflow_ref: `${RUNS}/.github/workflows/render.yml@refs/heads/main` })],
    ["identity", runsClaims({
      job_workflow_ref: `PalomarRegistry/PalomarSubmission/.github/workflows/submission.yml@${P}` })],
    ["identity", runsClaims({
      job_workflow_ref: `attacker/PalomarSubmission/.github/workflows/confidential-snapshot.yml@${P}` })],
    ["identity", runsClaims({ event_name: "push" })],
    ["pin", runsClaims({ job_workflow_sha: "f".repeat(40) })],
    ["pin", runsClaims({
      job_workflow_ref: "PalomarRegistry/PalomarSubmission/.github/workflows/confidential-snapshot.yml@main",
      job_workflow_sha: "main" })],
    ["pipeline-not-allowed", runsClaims({
      job_workflow_ref: `PalomarRegistry/PalomarSubmission/.github/workflows/confidential-snapshot.yml@${"9".repeat(40)}`,
      job_workflow_sha: "9".repeat(40) })],
    ["pipeline-revoked", runsClaims({
      job_workflow_ref: `PalomarRegistry/PalomarSubmission/.github/workflows/confidential-snapshot.yml@${"c".repeat(40)}`,
      job_workflow_sha: "c".repeat(40) })],
    ["run_id", runsClaims({ run_id: undefined })],
  ];
  for (const [reason, claims] of cases) {
    assert.equal(
      await refusal(validateBrokerToken(ENV, await sign(claims), "snapshot",
        { now: NOW, callerMatches: callerOk, isRevoked })),
      reason, JSON.stringify(claims),
    );
  }
  // A modified caller file: everything else valid, the template does not match.
  assert.equal(await refusal(validateBrokerToken(ENV, await sign(runsClaims()), "snapshot",
    { now: NOW, callerMatches: async () => false, isRevoked })), "caller");
  // An operation the row does not grant (escalation from snapshot to publish).
  assert.equal(await refusal(validateBrokerToken(ENV, await sign(runsClaims()), "publish",
    { now: NOW, callerMatches: callerOk, isRevoked })), "identity");
  // Revocation is never optional.
  assert.equal(await refusal(validateBrokerToken(ENV, await sign(runsClaims()), "snapshot",
    { now: NOW, callerMatches: callerOk })), "revocation-unchecked");
  assert.equal(await refusal(validateBrokerToken(ENV, await sign(stateClaims()), "evidence",
    { now: NOW })), "revocation-unchecked");
  assert.equal(await refusal(validateBrokerToken(ENV, await sign(runsClaims()), "delete",
    { now: NOW, callerMatches: callerOk, isRevoked })), "operation");
});

test("only RS256 with a known key and a valid signature is accepted", async () => {
  resetJwksCache();
  serveJwks();
  const claims = runsClaims();
  const body = `${b64url(JSON.stringify({ alg: "none", kid: "k1" }))}.${b64url(JSON.stringify(claims))}.`;
  assert.equal(await refusal(verifyJwt(body, { now: NOW })), "alg");
  const hmac = (await sign(claims)).split(".");
  hmac[0] = b64url(JSON.stringify({ alg: "HS256", kid: "k1" }));
  assert.equal(await refusal(verifyJwt(hmac.join("."), { now: NOW })), "alg");
  const tampered = (await sign(claims)).split(".");
  tampered[1] = b64url(JSON.stringify({ ...claims, repository_id: "2001" }));
  assert.equal(await refusal(verifyJwt(tampered.join("."), { now: NOW })), "signature");
  jwksFetches = 0;
  assert.equal(await refusal(verifyJwt(await sign(claims, { alg: "RS256", kid: "k2" }), { now: NOW + 1 })),
    "unknown-kid");
  // An unknown kid refetches once, and only once.
  assert.equal(jwksFetches, 1);
  assert.equal(await refusal(verifyJwt("a.b", { now: NOW })), "malformed");
});

test("State reviewer tokens validate only through the pinned reusable workflow", async () => {
  resetJwksCache();
  serveJwks();
  for (const event of ["workflow_dispatch", "schedule"]) {
    for (const operation of ["restore", "evidence", "publish"]) {
      const result = await validateBrokerToken(ENV, await sign(stateClaims({ event_name: event })),
        operation, { now: NOW, isRevoked });
      assert.equal(result.origin, "state");
      assert.equal(result.reviewer_commit, R);
    }
  }
  // State may not snapshot or validate.
  assert.equal(await refusal(validateBrokerToken(ENV, await sign(stateClaims()), "snapshot",
    { now: NOW, callerMatches: callerOk, isRevoked })), "identity");
  // A direct State job has no reusable workflow identity.
  assert.equal(await refusal(validateBrokerToken(ENV, await sign(stateClaims({
    job_workflow_ref: "PalomarRegistry/PalomarSubmissionState/.github/workflows/reviewer.yml@refs/heads/main",
  })), "evidence", { now: NOW, isRevoked })), "identity");
  assert.equal(await refusal(validateBrokerToken(ENV, await sign(stateClaims({
    job_workflow_ref: `PalomarRegistry/PalomarReviewer/.github/workflows/confidential-objects.yml@${"d".repeat(40)}`,
    job_workflow_sha: "d".repeat(40),
  })), "evidence", { now: NOW, isRevoked })), "reviewer-revoked");
  assert.equal(await refusal(validateBrokerToken(ENV, await sign(stateClaims({
    job_workflow_ref: `PalomarRegistry/PalomarReviewer/.github/workflows/confidential-objects.yml@${"8".repeat(40)}`,
    job_workflow_sha: "8".repeat(40),
  })), "evidence", { now: NOW, isRevoked })), "reviewer-not-allowed");
});

test("the caller file must be the canonical template with exactly pin P", async () => {
  const template = `jobs:\n  snapshot:\n    uses: PalomarRegistry/PalomarSubmission/.github/workflows/confidential-snapshot.yml@<pipeline-commit>\n    with:\n      pipeline_commit: <pipeline-commit>\n`;
  const env = { ...ENV, CONFIDENTIAL_CALLER_TEMPLATE_SHA256: JSON.stringify({ "verify.yml": await digest(template) }) };
  const files = {
    ["1".repeat(40)]: template.replaceAll("<pipeline-commit>", P),
    ["2".repeat(40)]: template.replaceAll("<pipeline-commit>", P) + "  extra:\n    runs-on: self-hosted\n",
    ["3".repeat(40)]: template,
  };
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), auth: init.headers.authorization });
    const ref = new URL(url).searchParams.get("ref");
    return files[ref] ? new Response(files[ref]) : new Response("", { status: 404 });
  };
  const ask = (sha, file = "verify.yml", pin = P) =>
    callerTemplateMatches(env, { workflowFile: file, workflowSha: sha, pipelineCommit: pin });
  assert.equal(await ask("1".repeat(40)), true);
  assert.equal(await ask("2".repeat(40)), false);
  assert.equal(await ask("3".repeat(40)), false);
  assert.equal(await ask("1".repeat(40), "verify.yml", "c".repeat(40)), false);
  assert.equal(await ask("1".repeat(40), "render.yml"), false);
  assert.equal(await ask("4".repeat(40)), false);
  assert.ok(requests.every((item) => item.auth === "Bearer dispatch-token" &&
    item.url.startsWith(`https://api.github.com/repos/${RUNS}/contents/.github/workflows/`)));
  // Cached by commit: asking again does not read GitHub again.
  const before = requests.length;
  assert.equal(await ask("1".repeat(40)), true);
  assert.equal(requests.length, before);
});

const BINDING = { run_id: "555", run_attempt: "1", repository_id: "2000" };
const SNAPSHOT = { repository_id: "2000", workflow: "PalomarRegistry/PalomarSubmission/.github/workflows/confidential-snapshot.yml" };
const VALIDATE = { repository_id: "2000", workflow: "PalomarRegistry/PalomarSubmission/.github/workflows/confidential-validate.yml" };

function snapshotTicket(overrides = {}) {
  return issueTicket({
    ticketHash: "f".repeat(64), operation: "snapshot", submissionId: "a1b2c3d4e5f6",
    generation: 0, nonce: "0".repeat(32), admitted: { commit: "1".repeat(40) }, now: NOW, ...overrides,
  });
}

function present(ticket, operation, overrides = {}) {
  return presentTicket(ticket, {
    operation, binding: BINDING, identity: operation === "validate" ? VALIDATE : SNAPSHOT,
    generation: 0, now: NOW + 1000, ...overrides,
  });
}

test("first use binds a ticket; the same binding retries within its budget", () => {
  let ticket = snapshotTicket();
  for (let mint = 1; mint <= MAX_MINTS; mint += 1) {
    const outcome = present(ticket, "snapshot");
    assert.equal(outcome.ok, true);
    assert.equal(outcome.mint, mint);
    ticket = outcome.ticket;
  }
  assert.deepEqual(ticket.bound, { ...BINDING, workflow: SNAPSHOT.workflow });
  const fourth = present(ticket, "snapshot");
  assert.equal(fourth.ok, false);
  assert.equal(fourth.poisoned, true);
  assert.equal(present(fourth.ticket, "snapshot").ok, false);
});

test("validation has its own budget after the snapshot binds, in the same run only", () => {
  let ticket = snapshotTicket();
  assert.equal(present(ticket, "validate").poisoned, true, "validate before snapshot");
  for (let mint = 0; mint < MAX_MINTS; mint += 1) ticket = present(ticket, "snapshot").ticket;
  for (let mint = 1; mint <= MAX_MINTS; mint += 1) {
    const outcome = present(ticket, "validate");
    assert.equal(outcome.ok, true, `validate ${mint}`);
    assert.equal(outcome.operation, "validate");
    ticket = outcome.ticket;
  }
  assert.equal(present(ticket, "validate").poisoned, true);
  const fresh = present(snapshotTicket(), "snapshot").ticket;
  assert.equal(present(fresh, "validate", { binding: { ...BINDING, run_id: "556" } }).poisoned, true);
});

test("a duplicate run is refused without poisoning; any other misuse poisons", () => {
  const bound = present(snapshotTicket(), "snapshot").ticket;
  const duplicate = present(bound, "snapshot", { binding: { ...BINDING, run_id: "556" } });
  assert.equal(duplicate.error, "duplicate-run");
  assert.equal(duplicate.poisoned, undefined);
  assert.deepEqual(duplicate.duplicate, { run_id: "556" });
  // The elected run carries on.
  assert.equal(present(duplicate.ticket, "snapshot").ok, true);
  for (const overrides of [
    { binding: { ...BINDING, repository_id: "3000" } },
    { identity: { ...SNAPSHOT, workflow: "PalomarRegistry/PalomarSubmission/.github/workflows/confidential-restore.yml" } },
    { binding: { ...BINDING, run_attempt: "2" } },
    { generation: 1 },
    { now: NOW + 7 * 60 * 60_000 },
  ]) {
    const outcome = present(bound, "snapshot", overrides);
    assert.equal(outcome.poisoned, true, JSON.stringify(overrides));
  }
  assert.equal(present(bound, "publish").poisoned, true);
  assert.equal(presentTicket(poisonTicket(bound, { reason: "withdrawn", now: NOW }), {
    operation: "snapshot", binding: BINDING, identity: SNAPSHOT, generation: 0, now: NOW,
  }).ok, false);
});

test("token kinds hash into separate namespaces", async () => {
  const token = newToken();
  assert.match(token, TOKEN_RE);
  const kinds = await Promise.all(["status", "release", "link", "capability", "ticket"]
    .map((kind) => kindDigest(ENV, kind, token)));
  assert.equal(new Set(kinds).size, 5);
  await assert.rejects(kindDigest(ENV, "other", token));
  const ids = new Set(Array.from({ length: 64 }, newRandomId));
  assert.equal(ids.size, 64);
  for (const id of ids) assert.match(id, /^[a-z2-7]{26}$/);
  assert.equal(canonicalJson({ b: [1, { d: "é", c: null }], a: true }), '{"a":true,"b":[1,{"c":null,"d":"é"}]}');
  assert.throws(() => canonicalJson({ a: 1.5 }));
});

// A private-key stand-in: the Source App's JWT is signed, so the tests need a
// real PKCS#8 RSA key.
const appKey = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256" },
  true, ["sign", "verify"],
);
const APP_PEM = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(
  await crypto.subtle.exportKey("pkcs8", appKey.privateKey)).toString("base64")}\n-----END PRIVATE KEY-----`;
const SOURCE_ENV = { ...ENV, SOURCE_APP_ID: "42", SOURCE_APP_PRIVATE_KEY: APP_PEM };

/**
 * GitHub as the Source App sees it. `scenario` decides what exists; every
 * request is recorded, and every minted token's revocation is noted.
 */
function stubSource(scenario = {}) {
  const {
    installed = true, exists = true, isPrivate = true, role = "write", tag = true, commitKnown = true,
    mintResponse = null, outage = false, store = new Map(), userId = 4242,
  } = scenario;
  const requests = [];
  const revoked = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(url);
    const method = init.method ?? "GET";
    requests.push({ method, path: target.pathname, body: init.body ? JSON.parse(init.body) : null,
      auth: init.headers?.authorization });
    const state = `/repos/${ENV.STATE_REPO}/contents/`;
    if (target.pathname.startsWith(state)) {
      const path = decodeURI(target.pathname.slice(state.length));
      if (method === "GET") {
        return store.has(path)
          ? Response.json({ content: Buffer.from(JSON.stringify(store.get(path))).toString("base64"), sha: "s" })
          : new Response("", { status: 404 });
      }
      store.set(path, JSON.parse(Buffer.from(JSON.parse(init.body).content, "base64").toString()));
      return Response.json({});
    }
    if (outage) return new Response("", { status: 502 });
    if (target.pathname === "/repos/owner/secret/installation") {
      return installed ? Response.json({ id: 99 }) : new Response("", { status: 404 });
    }
    if (target.pathname === "/app/installations/99/access_tokens" && method === "POST") {
      return Response.json(mintResponse ?? {
        token: "ghs_source", expires_at: "2026-11-26T13:00:00Z", repository_selection: "selected",
        permissions: { contents: "read", metadata: "read" },
        repositories: [{ id: 777, full_name: "owner/secret" }],
      }, { status: 201 });
    }
    if (target.pathname === "/installation/token" && method === "DELETE") {
      revoked.push(init.headers.authorization);
      return new Response(null, { status: 204 });
    }
    if (target.pathname === "/repos/owner/secret") {
      return exists
        ? Response.json({ id: 777, full_name: "owner/secret", private: isPrivate, owner: { id: 5 } })
        : new Response("", { status: 404 });
    }
    if (target.pathname.startsWith("/repos/owner/secret/collaborators/")) {
      return Response.json({ permission: role === "maintain" ? "write" : role, role_name: role,
        user: { id: userId } });
    }
    if (target.pathname.startsWith("/repos/owner/secret/git/ref/tags/c-")) {
      return tag
        ? Response.json({ object: { type: "commit", sha: "1".repeat(40) } })
        : new Response("", { status: 404 });
    }
    if (target.pathname === `/repos/owner/secret/commits/${"1".repeat(40)}`) {
      return commitKnown ? Response.json({ sha: "1".repeat(40) }) : new Response("", { status: 422 });
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { requests, revoked, store };
}

test("a source token is minted for exactly one repository with exactly read permissions", async () => {
  const { requests, revoked } = stubSource();
  const minted = await mintSourceReadToken(SOURCE_ENV, 99, { repositoryId: 777 });
  assert.equal(minted.token, "ghs_source");
  const mint = requests.find((item) => item.path.endsWith("/access_tokens"));
  assert.deepEqual(mint.body, { repository_ids: [777], permissions: { contents: "read", metadata: "read" } });
  assert.match(mint.auth, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
  assert.deepEqual(revoked, []);
  for (const mintResponse of [
    { token: "t", repository_selection: "selected", permissions: { contents: "read", metadata: "read" },
      repositories: [{ id: 777 }, { id: 778 }] },
    { token: "t", repository_selection: "selected", permissions: { contents: "write", metadata: "read" },
      repositories: [{ id: 777 }] },
    { token: "t", repository_selection: "selected",
      permissions: { contents: "read", metadata: "read", actions: "read" }, repositories: [{ id: 777 }] },
    { token: "t", repository_selection: "all", permissions: { contents: "read", metadata: "read" },
      repositories: [{ id: 777 }] },
    { token: "t", repository_selection: "selected", permissions: { contents: "read", metadata: "read" },
      repositories: [{ id: 778 }] },
  ]) {
    const stub = stubSource({ mintResponse });
    await assert.rejects(mintSourceReadToken(SOURCE_ENV, 99, { repositoryId: 777 }));
    assert.deepEqual(stub.revoked, ["Bearer t"], JSON.stringify(mintResponse));
  }
  await assert.rejects(mintSourceReadToken(SOURCE_ENV, 99, {}));
  await assert.rejects(mintSourceReadToken(SOURCE_ENV, 99, { repositoryId: 777, repositoryName: "owner/secret" }));
});

const PRINCIPAL = { id: 4242, login: "someone" };

function authorize(extra = {}) {
  return authorizePrivateRepository(SOURCE_ENV, {
    repositoryName: "owner/secret", principal: PRINCIPAL, commit: "1".repeat(40), now: NOW, ...extra,
  });
}

test("private repository authorization succeeds only with every proof, and revokes its token", async () => {
  for (const role of ["write", "maintain", "admin"]) {
    const { revoked, requests } = stubSource({ role });
    const result = await authorize({ challenge: "9".repeat(64) });
    assert.deepEqual(result, {
      ok: true, installation_id: 99,
      repository: { id: 777, full_name: "owner/secret", owner_id: 5 },
    });
    assert.deepEqual(revoked, ["Bearer ghs_source"]);
    // Never an installation-wide token: every mint names one repository.
    for (const item of requests.filter((entry) => entry.path.endsWith("/access_tokens"))) {
      assert.deepEqual(Object.keys(item.body).sort(), ["permissions", "repositories"]);
      assert.deepEqual(item.body.repositories, ["secret"]);
    }
  }
});

test("every repository-dependent failure gives one identical answer and is counted", async () => {
  const outcomes = [];
  for (const scenario of [
    { installed: false },
    { exists: false },
    { isPrivate: false },
    { role: "read" },
    { role: "triage" },
    { tag: false, challenge: true },
    { commitKnown: false },
  ]) {
    const { revoked, store } = stubSource(scenario);
    const result = await authorize(scenario.challenge ? { challenge: "9".repeat(64) } : {});
    outcomes.push(JSON.stringify(result));
    if (scenario.installed !== false) assert.deepEqual(revoked, ["Bearer ghs_source"], JSON.stringify(scenario));
    assert.equal([...store.values()][0].failures.length, 1);
  }
  assert.deepEqual(new Set(outcomes), new Set([JSON.stringify({ ok: false, transient: false })]));
  // An outage is told apart and not counted.
  const { store } = stubSource({ outage: true });
  assert.deepEqual(await authorize(), { ok: false, transient: true });
  assert.equal(store.size, 0);
});

test("ten refused authorizations in an hour exhaust the principal", async () => {
  const store = new Map();
  for (let index = 0; index < MAX_FAILURES_PER_HOUR; index += 1) {
    stubSource({ installed: false, store });
    assert.equal(await authorizationExhausted(SOURCE_ENV, PRINCIPAL.id, NOW), false);
    await authorize();
  }
  stubSource({ store });
  assert.equal(await authorizationExhausted(SOURCE_ENV, PRINCIPAL.id, NOW), true);
  // An hour later the window has moved on.
  assert.equal(await authorizationExhausted(SOURCE_ENV, PRINCIPAL.id, NOW + 61 * 60_000), false);
});

const TECHNICAL_MAINTAINER = { id: 477956, login: "maintainer" };
const BINDING_COOKIE = "9".repeat(64);

async function privateSignIn({ env, principal = TECHNICAL_MAINTAINER, scenario = {} }) {
  const nonce = "8".repeat(64);
  const pendingPath = `pending/${await digest(nonce)}.json`;
  const store = new Map(Object.entries({
    "index/inflight.json": { open: [] },
    "index/open.json": { schema_version: 1, open: [] },
    [pendingPath]: {
      schema_version: 2, binding_sha256: await digest(BINDING_COOKIE), method: "oauth",
      challenge: "7".repeat(64), repository_id: null, attempts: 0, repository: "owner/secret",
      commit: "1".repeat(40), existing_id: null, context: null,
      requested_paths: { project_path: null, comparator_config_path: "comparator.json",
        formalization_metadata_path: null },
      authorization_relationship: "maintainer", authorization_evidence: null,
      visibility: "confidential", source_route: "source-app", repository_owner_id: null,
      created_at: new Date().toISOString(),
    },
  }));
  const stub = stubSource({ userId: principal.id, ...scenario, store });
  const source = globalThis.fetch;
  const dispatches = [];
  let staged = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(url);
    const method = init.method ?? "GET";
    if (target.hostname === "github.com" && target.pathname.endsWith("/access_token")) {
      return Response.json({ access_token: "oauth-token" });
    }
    if (target.pathname === "/user") return Response.json(principal);
    const state = `/repos/${ENV.STATE_REPO}`;
    if (target.pathname === `${state}/git/ref/heads/main`) {
      return Response.json({ object: { type: "commit", sha: "a".repeat(40) } });
    }
    if (target.pathname === `${state}/git/commits/${"a".repeat(40)}`) {
      return Response.json({ tree: { sha: "b".repeat(40) } });
    }
    if (target.pathname === `${state}/git/trees`) {
      staged = JSON.parse(init.body).tree;
      return Response.json({ sha: "c".repeat(40) });
    }
    if (target.pathname === `${state}/git/commits`) return Response.json({ sha: "d".repeat(40) });
    if (target.pathname === `${state}/git/refs/heads/main`) {
      for (const change of staged) {
        if (change.sha === null) store.delete(change.path);
        else store.set(change.path, JSON.parse(change.content));
      }
      return Response.json({});
    }
    if (target.pathname.startsWith(`${state}/contents/`) && method === "DELETE") {
      store.delete(decodeURI(target.pathname.slice(`${state}/contents/`.length)));
      return Response.json({});
    }
    if (/\/dispatches$/.test(target.pathname)) {
      dispatches.push(target.pathname);
      return new Response(null, { status: 204 });
    }
    return source(url, init);
  };
  const name = `__Host-palomar_intake_${(await digest(nonce)).slice(0, 16)}`;
  const response = await worker.fetch(new Request(
    `https://submit.palomar-registry.org/oauth/callback?code=c&state=${nonce}`,
    { headers: { cookie: `${name}=${BINDING_COOKIE}` } },
  ), env);
  return { ...stub, store, response, dispatches, pendingPath };
}

const ACTIVE = { ...SOURCE_ENV, CONFIDENTIAL_INTAKE: "test-private" };

test("an activated private route admits a Technical Maintainer test after authorization", async () => {
  const { response, store, revoked, pendingPath } = await privateSignIn({ env: ACTIVE });
  assert.equal(response.status, 303);
  const record = [...store.entries()].find(([key]) => key.endsWith("/state.json"))[1];
  assert.equal(record.test_submission, true);
  assert.deepEqual(record.confidential.source,
    { route: "source-app", repository_id: 777, owner_id: 5, installation_id: 99 });
  assert.equal(record.push_proof.source_route, "source-app");
  assert.equal(store.has(pendingPath), false);
  assert.deepEqual(revoked, ["Bearer ghs_source"]);
  assert.ok(store.has(statePath(record.id, "state.json")));
});

test("the private route refuses identically, and stays shut until activated", async () => {
  const bodies = [];
  for (const scenario of [{ installed: false }, { role: "read" }, { exists: false }, { isPrivate: false }]) {
    const { response, store } = await privateSignIn({ env: ACTIVE, scenario });
    assert.equal(response.status, 403);
    bodies.push(await response.text());
    assert.ok(![...store.keys()].some((key) => key.endsWith("/state.json")));
  }
  assert.equal(new Set(bodies).size, 1);
  assert.ok(bodies[0].includes("Palomar could not confirm that you may submit this repository confidentially."));
  assert.ok(NOT_AUTHORIZED.detail.length > 0);
  // Not activated: no Source App call at all.
  const { response, requests } = await privateSignIn({ env: SOURCE_ENV });
  assert.equal(response.status, 403);
  assert.match(await response.text(), /not open yet/);
  assert.ok(!requests.some((item) => /installation|access_tokens/.test(item.path)));
  // Authorized, but not a Technical Maintainer: refused until invitations exist.
  const other = await privateSignIn({ env: ACTIVE, principal: PRINCIPAL });
  assert.equal(other.response.status, 403);
  assert.match(await other.response.text(), /not open yet/);
});

test("before sign-in a missing and a private repository get the same answer", async () => {
  const form = {
    repository: "owner/secret", commit: "1".repeat(40), comparator_config_path: "comparator.json",
    authorization_relationship: "maintainer", visibility: "confidential",
  };
  for (const env of [ENV, ACTIVE]) {
    const answers = [];
    for (const repo of [null, { id: 777, private: true, owner: { login: "owner", id: 5 } }]) {
      globalThis.fetch = async (url) => {
        const path = new URL(url).pathname;
        if (path.endsWith("/contents/pending")) return Response.json([]);
        if (path === "/repos/owner/secret") {
          return repo ? Response.json(repo) : new Response("", { status: 404 });
        }
        if (path.includes("/contents/pending/")) return Response.json({ content: {} });
        throw new Error(`unexpected ${url}`);
      };
      const response = await worker.fetch(new Request("https://submit.palomar-registry.org/submit", {
        method: "POST", headers: { "sec-fetch-site": "same-origin" }, body: new URLSearchParams(form),
      }), env);
      const location = response.headers.get("location");
      answers.push(`${response.status} ${location ? new URL(location).pathname : (await response.text()).replace(/value="[^"]*"/g, "")}`);
    }
    assert.equal(answers[0], answers[1], env === ACTIVE ? "activated" : "inactive");
  }
});
