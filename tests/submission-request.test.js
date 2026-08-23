import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  submissionRequest,
  validSubmissionToken,
} from "../public/submission-request.js";

const FIRST = "a".repeat(64);
const SECOND = "b".repeat(64);

test("simultaneous status tabs keep their own submission capability", async () => {
  const previous = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (path, init) => {
    requests.push({ path, init });
    return Response.json({ ok: true });
  };
  try {
    await Promise.all([
      submissionRequest(FIRST, "/api/submission"),
      submissionRequest(SECOND, "/api/submission"),
    ]);
  } finally {
    globalThis.fetch = previous;
  }

  assert.deepEqual(requests.map(({ path }) => path), [
    "/api/submission",
    "/api/submission",
  ]);
  assert.deepEqual(requests.map(({ init }) => init.headers.get("authorization")), [
    `Bearer ${FIRST}`,
    `Bearer ${SECOND}`,
  ]);
  assert.deepEqual(requests.map(({ init }) => init.credentials), ["omit", "omit"]);
});

test("private requests preserve their body headers but never a supplied credential", async () => {
  const previous = globalThis.fetch;
  let sent;
  globalThis.fetch = async (path, init) => {
    sent = { path, init };
    return new Response(null, { status: 204 });
  };
  try {
    await submissionRequest(FIRST, "/api/repair", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECOND}`,
        "content-type": "application/json",
      },
      body: "{}",
      credentials: "include",
      redirect: "follow",
    });
  } finally {
    globalThis.fetch = previous;
  }

  assert.equal(sent.path, "/api/repair");
  assert.equal(sent.init.method, "POST");
  assert.equal(sent.init.body, "{}");
  assert.equal(sent.init.headers.get("content-type"), "application/json");
  assert.equal(sent.init.headers.get("authorization"), `Bearer ${FIRST}`);
  assert.equal(sent.init.credentials, "omit");
  assert.equal(sent.init.redirect, "error");
});

test("submission capabilities are complete and stay on the Palomar origin", async () => {
  assert.equal(validSubmissionToken(FIRST), true);
  for (const token of ["", "a".repeat(63), "A".repeat(64), `${FIRST}0`]) {
    assert.equal(validSubmissionToken(token), false);
    assert.throws(() => submissionRequest(token, "/api/submission"), /invalid submission token/);
  }
  for (const path of [
    "https://example.test/api/submission",
    "//example.test/api/submission",
    "/\\example.test/api/submission",
  ]) {
    assert.throws(() => submissionRequest(FIRST, path), /stay on this origin/);
  }
});

test("every private status-page operation uses the tab-local request helper", async () => {
  const script = await readFile(new URL("../public/status.js", import.meta.url), "utf8");
  for (const path of ["/api/submission", "/api/review", "/api/repair"]) {
    assert.match(script, new RegExp(`submissionRequest\\(token, "${path}"`), path);
    assert.doesNotMatch(script, new RegExp(`fetch\\("${path}"`), path);
  }
  assert.match(script, /submissionRequest\(token, path,/);
  assert.doesNotMatch(script, /establishSession|fetch\("\/session"/);
  assert.equal(script.match(/\bfetch\(/g)?.length, 3, "an unexpected bare fetch bypasses the helper");
  assert.match(script, /if \(!validToken\) return;[\s\S]*visibilityState/);
  assert.match(script, /async function poll\(\) \{\s*if \(!validToken\) return;/);
  assert.match(script, /predates the Cloudflare account migration/);
  assert.match(script, /recovery\.href = "\/submissions"/);
  const githubReads = script.slice(
    script.indexOf("async function showVerificationFailure"),
    script.indexOf("let pollTimer"),
  );
  assert.doesNotMatch(githubReads, /authorization|submissionRequest/);
});
