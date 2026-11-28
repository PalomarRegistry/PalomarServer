/**
 * The one-shot source fetch, the lifecycle object and the certificates
 * (contract v3.1, C2, C5 and C6), each against a stubbed GitHub and an
 * in-memory R2 bucket.
 */

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  SourceRefusal,
  withSourceToken,
} from "../src/confidential-source.js";
import {
  createLifecycle,
  LifecycleConflict,
  newLifecycle,
  readLifecycle,
  replaceLifecycle,
  sigv4PresignGet,
} from "../src/confidential-store.js";
import {
  certificateEvidence,
  certificatePayloads,
  signCertificate,
  signingKey,
  verifyCertificate,
} from "../src/certificates.js";
import { captureSource, certificateStatus } from "../src/confidential.js";
import { readTarGz } from "../src/tar.js";
import { fakeR2 } from "./fake-r2.js";
import { githubTarball, githubTree, PLAIN_PROJECT } from "./tarball.js";

const REPOSITORY = "owner/project";
const COMMIT = "c".repeat(40);
const SOURCE_TOKEN = "ghs_SOURCEAPPTOKENNEVERSHOWN0123456789";
const APP_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" });
export const CERT_KEY = generateKeyPairSync("ed25519")
  .privateKey.export({ type: "pkcs8", format: "pem" });

/**
 * A GitHub with one repository. `files` is the commit's content; `tree` and
 * `tarball` default to the honest ones. Every request is recorded with its
 * authorization header, so a test can say which token reached which call.
 */
function stubSource({ files = PLAIN_PROJECT, tree = githubTree(files), tarball = githubTarball(files),
  repo = { id: 77, private: true, owner: { login: "owner", id: 5 } }, installed = true,
  tarballStatus = 200 } = {}) {
  const calls = [];
  const minted = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(url);
    const method = init.method ?? "GET";
    const auth = new Headers(init.headers).get("authorization");
    calls.push({ method, path: target.pathname, auth });
    const path = target.pathname;
    if (path === `/repos/${REPOSITORY}/installation`) {
      return installed ? Response.json({ id: 9 }) : new Response("", { status: 404 });
    }
    if (path === "/app/installations/9/access_tokens" && method === "POST") {
      minted.push(JSON.parse(init.body));
      return Response.json({ token: SOURCE_TOKEN, expires_at: "2099-01-01T00:00:00Z" });
    }
    if (path === `/repos/${REPOSITORY}`) {
      // Only the Source App token can see a private repository.
      if (repo.private && auth !== `Bearer ${SOURCE_TOKEN}`) return new Response("", { status: 404 });
      return Response.json(repo);
    }
    if (path === `/repos/${REPOSITORY}/git/trees/${COMMIT}`) return Response.json(tree);
    if (path === `/repos/${REPOSITORY}/tarball/${COMMIT}`) {
      if (tarballStatus !== 200) {
        return new Response(`failed https://codeload.github.com/x?token=${SOURCE_TOKEN}`, { status: tarballStatus });
      }
      return new Response(tarball, { headers: { "content-type": "application/x-gzip" } });
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { calls, minted };
}

const ENV = {
  GITHUB_TOKEN: "state-token",
  SOURCE_APP_ID: "5960814",
  SOURCE_APP_PRIVATE_KEY: APP_KEY,
};

test("a plain Git tree is fetched once and stored with its SHA-256", async () => {
  const { calls, minted } = stubSource();
  const env = { ...ENV, CONFIDENTIAL_SOURCE: fakeR2() };
  const sha = await captureSource(env, { id: "a1b2c3d4e5f6", repository: REPOSITORY, commit: COMMIT, repositoryId: 77 });
  assert.match(sha, /^[0-9a-f]{64}$/);
  const stored = env.CONFIDENTIAL_SOURCE.objects.get("conf/a1b2c3d4e5f6/source.tar.gz").bytes;
  const digest = Buffer.from(await crypto.subtle.digest("SHA-256", stored)).toString("hex");
  assert.equal(digest, sha);
  const lifecycle = (await readLifecycle(env, "a1b2c3d4e5f6")).value;
  assert.equal(lifecycle.state, "reviewing");
  assert.equal(lifecycle.source_sha256, sha);
  // One token, for this one repository, read-only.
  assert.deepEqual(minted, [{ repositories: ["project"], permissions: { contents: "read", metadata: "read" } }]);
  const tokenUses = calls.filter((call) => call.auth === `Bearer ${SOURCE_TOKEN}`).map((call) => call.path);
  assert.deepEqual(tokenUses, [
    `/repos/${REPOSITORY}`, `/repos/${REPOSITORY}/git/trees/${COMMIT}`, `/repos/${REPOSITORY}/tarball/${COMMIT}`,
  ]);
  // A second capture for the same id reads nothing.
  const before = calls.length;
  assert.equal(await captureSource(env, { id: "a1b2c3d4e5f6", repository: REPOSITORY, commit: COMMIT, repositoryId: 77 }), sha);
  assert.equal(calls.length, before);
});

test("a public repository is fetched without any token", async () => {
  const { calls, minted } = stubSource({ repo: { id: 77, private: false, owner: { login: "owner" } } });
  const env = { ...ENV, CONFIDENTIAL_SOURCE: fakeR2() };
  await captureSource(env, { id: "a1b2c3d4e5f6", repository: REPOSITORY, commit: COMMIT, repositoryId: 77 });
  assert.deepEqual(minted, []);
  assert.ok(calls.filter((call) => call.path.includes("/tarball/")).every((call) => call.auth === null));
});

for (const [name, setup, pattern] of [
  ["a submodule", () => ({ tree: githubTree(PLAIN_PROJECT, [{ path: "vendor/lib", mode: "160000", type: "commit" }]) }), /submodules \(vendor\/lib\)/],
  ["a .gitattributes filter rule", () => {
    const files = { ...PLAIN_PROJECT, ".gitattributes": "*.olean filter=lfs diff=lfs merge=lfs -text\n" };
    return { files };
  }, /filter or export rules/],
  ["a nested .gitattributes export rule", () => {
    const files = { ...PLAIN_PROJECT, "docs/.gitattributes": "drafts/ export-ignore\n" };
    return { files };
  }, /filter or export rules \(docs\/.gitattributes\)/],
  ["an export-subst rule", () => ({ files: { ...PLAIN_PROJECT, ".gitattributes": "VERSION export-subst\n" } }), /filter or export rules/],
  ["a Git LFS pointer", () => ({
    files: { ...PLAIN_PROJECT, "data.bin": `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 12\n` },
  }), /LFS pointers \(data.bin\)/],
  ["an archive that differs from the tree (LFS content substituted)", () => ({
    tree: githubTree({ ...PLAIN_PROJECT, "data.bin": "x".repeat(130) }),
    tarball: githubTarball({ ...PLAIN_PROJECT, "data.bin": "y".repeat(5000) }),
  }), /differs from its Git tree \(data.bin\)/],
  ["an archive that leaves a file out", () => ({
    tree: githubTree({ ...PLAIN_PROJECT, "notes.md": "x" }),
  }), /leaves out notes.md/],
  ["a truncated tree", () => ({ tree: { ...githubTree(PLAIN_PROJECT), truncated: true } }), /too many files/],
]) {
  test(`intake refuses ${name}, and stores nothing`, async () => {
    stubSource(setup());
    const env = { ...ENV, CONFIDENTIAL_SOURCE: fakeR2() };
    await assert.rejects(
      captureSource(env, { id: "a1b2c3d4e5f6", repository: REPOSITORY, commit: COMMIT, repositoryId: 77 }),
      (error) => error instanceof SourceRefusal && pattern.test(error.message),
    );
    assert.equal(env.CONFIDENTIAL_SOURCE.objects.size, 0);
  });
}

test("intake refuses a repository whose id changed since sign-in, or without the App", async () => {
  stubSource();
  await assert.rejects(
    captureSource({ ...ENV, CONFIDENTIAL_SOURCE: fakeR2() },
      { id: "a1b2c3d4e5f6", repository: REPOSITORY, commit: COMMIT, repositoryId: 78 }),
    /changed during sign-in/,
  );
  stubSource({ installed: false });
  await assert.rejects(
    captureSource({ ...ENV, CONFIDENTIAL_SOURCE: fakeR2() },
      { id: "a1b2c3d4e5f6", repository: REPOSITORY, commit: COMMIT, repositoryId: 77 }),
    /Install the Palomar Source GitHub App/,
  );
});

test("the Source App token is never in an error, a log line or a stored object", async () => {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const name of Object.keys(saved)) console[name] = (...args) => lines.push(args.map(String).join(" "));
  try {
    const env = { ...ENV, CONFIDENTIAL_SOURCE: fakeR2() };
    stubSource({ tarballStatus: 502 });
    const failure = await captureSource(env, { id: "a1b2c3d4e5f6", repository: REPOSITORY, commit: COMMIT, repositoryId: 77 })
      .catch((error) => error);
    assert.match(failure.message, /502/);
    assert.ok(!String(failure.message).includes(SOURCE_TOKEN));
    assert.ok(!String(failure.stack).includes(SOURCE_TOKEN));
    stubSource();
    await captureSource(env, { id: "b1b2c3d4e5f6", repository: REPOSITORY, commit: COMMIT, repositoryId: 77 });
    for (const { bytes } of env.CONFIDENTIAL_SOURCE.objects.values()) {
      assert.ok(!Buffer.from(bytes).includes(SOURCE_TOKEN));
    }
    // And the token is handed to `use` only, and is gone after it returns.
    let seen;
    assert.equal(await withSourceToken(ENV, REPOSITORY, async (token) => { seen = token; return "done"; }), "done");
    assert.equal(seen, SOURCE_TOKEN);
  } finally {
    Object.assign(console, saved);
  }
  assert.ok(lines.every((line) => !line.includes(SOURCE_TOKEN)), lines.join("\n"));
});

test("the tar reader follows pax long paths and links", async () => {
  const long = `${"deep/".repeat(30)}File.lean`;
  const entries = await readTarGz(githubTarball({ [long]: "x", "link": { link: "File.lean" } }));
  assert.deepEqual(entries.map((entry) => [entry.path, entry.type]), [[long, "file"], ["link", "symlink"]]);
});

test("lifecycle writes are compare-and-set on the ETag", async () => {
  const env = { CONFIDENTIAL_SOURCE: fakeR2() };
  const created = await createLifecycle(env, newLifecycle({
    id: "a1b2c3d4e5f6", repository: REPOSITORY, repositoryId: 77, commit: COMMIT,
    sourceSha256: "f".repeat(64), at: "2026-11-28T00:00:00Z",
  }));
  // A second create loses.
  await assert.rejects(createLifecycle(env, created.value), LifecycleConflict);
  const held = await replaceLifecycle(env, created, { ...created.value, state: "held" });
  // A writer still holding the first read cannot overwrite the hold.
  await assert.rejects(replaceLifecycle(env, created, { ...created.value, state: "withdrawn" }), LifecycleConflict);
  assert.equal((await readLifecycle(env, "a1b2c3d4e5f6")).value.state, "held");
  await replaceLifecycle(env, held, { ...held.value, state: "withdrawn" });
  assert.equal((await readLifecycle(env, "a1b2c3d4e5f6")).value.state, "withdrawn");
});

test("a missing or malformed lifecycle reads as withdrawn", async () => {
  const env = { CONFIDENTIAL_SOURCE: fakeR2() };
  assert.equal(await certificateStatus(env, "a1b2c3d4e5f6"), "withdrawn");
  await env.CONFIDENTIAL_SOURCE.put("conf/a1b2c3d4e5f6/lifecycle.json", "{not json");
  assert.equal(await readLifecycle(env, "a1b2c3d4e5f6"), null);
  assert.equal(await certificateStatus(env, "a1b2c3d4e5f6"), "withdrawn");
  await env.CONFIDENTIAL_SOURCE.put("conf/a1b2c3d4e5f6/lifecycle.json", JSON.stringify({ state: "held" }));
  assert.equal(await certificateStatus(env, "a1b2c3d4e5f6"), "withdrawn");
  // An anonymous id whose submission is gone, and anything malformed.
  await env.CONFIDENTIAL_SOURCE.put(`conf-anon/${"a".repeat(32)}`, JSON.stringify({ id: "zzzzzzzzzzzz" }));
  assert.equal(await certificateStatus(env, "a".repeat(32)), "withdrawn");
  for (const value of ["", "..", "A1B2C3D4E5F6", "x".repeat(200)]) {
    assert.equal(await certificateStatus(env, value), "withdrawn");
  }
});

test("the certificate pair carries exactly the contract's fields and verifies", async () => {
  const entries = await readTarGz(githubTarball(PLAIN_PROJECT));
  const evidence = certificateEvidence(entries, { comparator_config_path: "comparator.json" });
  assert.equal(evidence.toolchain, "leanprover/lean4:v4.35.0");
  assert.equal(evidence.challengeText, PLAIN_PROJECT["Project/Challenge.lean"]);
  const lifecycle = newLifecycle({ id: "a1b2c3d4e5f6", repository: REPOSITORY, repositoryId: 77, commit: COMMIT,
    sourceSha256: "f".repeat(64), at: "2026-11-28T00:00:00Z" });
  const payloads = await certificatePayloads({
    lifecycle, evidence, anonymousId: "a".repeat(32), issuedOn: "2026-11-28", origin: "https://submit.palomar-registry.org",
  });
  assert.deepEqual(Object.keys(payloads.full).sort(), [
    "challenge_sha256", "commit", "issued_on", "kind", "palomar_id", "repository", "source_sha256",
    "status_url", "toolchain", "verdict",
  ]);
  assert.deepEqual(Object.keys(payloads.anonymous).sort(), [
    "certificate_id", "challenge", "kind", "status_url", "toolchain", "verdict",
  ]);
  // Nothing in the anonymous certificate names the author, the repository or the submission.
  assert.doesNotMatch(JSON.stringify(payloads.anonymous), /owner|project|a1b2c3d4e5f6|ccccccc/);
  const signer = await signingKey(CERT_KEY);
  for (const payload of Object.values(payloads)) {
    const document = await signCertificate(signer, payload);
    assert.equal(document.key_id, signer.keyId);
    assert.equal(await verifyCertificate(document, signer.publicKey), true);
    const forged = { ...document, payload: document.payload.replace("passed", "failed") };
    assert.equal(await verifyCertificate(forged, signer.publicKey), false);
  }
});

test("presigned URLs follow S3 SigV4 (the AWS reference example)", async () => {
  const url = await sigv4PresignGet({
    host: "examplebucket.s3.amazonaws.com", path: "/test.txt", region: "us-east-1",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    seconds: 86400, now: Date.parse("2013-05-24T00:00:00Z"),
  });
  assert.ok(url.endsWith("X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"));
});

test("the published certificate key list is well formed", async () => {
  const { readFile } = await import("node:fs/promises");
  const keys = JSON.parse(await readFile(new URL("../public/certificate-keys.json", import.meta.url), "utf8"));
  assert.equal(keys.schema, "palomar-certificate-keys/1");
  for (const key of keys.keys) {
    assert.deepEqual(Object.keys(key).sort(), ["alg", "key_id", "not_before", "public_key", "revoked_at"]);
    assert.equal(key.alg, "Ed25519");
    const raw = Buffer.from(key.public_key, "base64");
    assert.equal(raw.length, 32);
    assert.equal(Buffer.from(await crypto.subtle.digest("SHA-256", raw)).toString("hex").slice(0, 16), key.key_id);
  }
});
