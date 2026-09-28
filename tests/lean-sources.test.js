import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BROWSER_PREFLIGHT_POLICY as policy } from "../browser/preflight.js";
import { inspectLeanSources, moduleHeader, readLeanSource, validateLeanSource } from "../browser/lean-sources.js";
import { sourcePreflight } from "../src/source-preflight.js";

const entry = (path, size = 7) => ({ path, size, type: "blob", mode: "100644" });

test("shared Python/browser source fixtures agree at the limit and on header syntax", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/lean-source-requirements.json", import.meta.url)));
  for (const item of fixture.cases) {
    assert.deepEqual(validateLeanSource(item.path ?? "Source.lean", item.text, policy).map((d) => d.code),
      item.expected_codes, item.id);
  }
});

test("prefixes produce definite failures only, including truncated comments and UTF-8", async () => {
  for (const text of ["", "/", "-- license", "/- license", "mod", "module/", "module-", "module."]) {
    assert.equal(moduleHeader(text, false), "incomplete", text);
  }
  assert.deepEqual(validateLeanSource("A.lean", "module\n" + "--\n".repeat(9999), policy,
    { complete: false }), []);
  assert.equal(validateLeanSource("A.lean", "module\n" + "--\n".repeat(10000), policy,
    { complete: false })[0].code, "source.file_too_long");
  assert.equal(validateLeanSource("A.lean", "import Mathlib", policy,
    { complete: false })[0].code, "source.module_required");
  const content = await readLeanSource(new Response("module\n😀"), 9, 11);
  assert.equal(content.complete, false);
  assert.equal(content.text, "module\n");
  assert.equal(await readLeanSource(new Response("module\nextra"), 7, 7), null);
  assert.equal((await readLeanSource(new Response("module\n"), 7, 7)).complete, true);
});

test("scan includes nested source/config, rejects symlinks, excludes dependency state and bounds reads", async () => {
  const files = [entry("Good.lean"), entry("nested/Unused.lean"), entry("lakefile.lean"),
    entry("nested/lakefile.lean"), entry(".lake/Bad.lean"), entry(".git/Bad.lean"),
    { ...entry("Link.lean"), mode: "120000" }];
  const read = async (item) => ({ text: item.path === "Good.lean" ? "module\n" : "import Init\n", complete: true });
  const result = await inspectLeanSources(files, read, policy);
  assert.equal(result.files_checked, 5);
  assert.equal(result.status, "fail");
  assert.deepEqual(new Set(result.diagnostics.map((d) => d.path)),
    new Set(["nested/Unused.lean", "Link.lean"]));
  let reads = 0;
  const capped = await inspectLeanSources(Array.from({ length: 33 }, (_, i) => entry(`${i}.lean`)),
    async () => { reads += 1; return { text: "module\n", complete: true }; }, policy);
  assert.equal(reads, 32);
  assert.equal(capped.status, "incomplete");
  assert.equal((await inspectLeanSources([entry("A.lean")], async () => null, policy)).status, "incomplete");
  assert.equal((await inspectLeanSources([entry("A.lean")], async () => ({ text: "module", complete: false }), policy)).status, "incomplete");
});

test("API source scan binds public reads to exact commit and never forwards credentials", async (t) => {
  const commit = "a".repeat(40);
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.startsWith("https://api.github.com/")) {
      assert.match(url, new RegExp(`${commit}\\?recursive=1$`));
      assert.equal(options.headers.authorization, "Bearer secret");
      return Response.json({ tree: [entry("nested/A.lean", 12)] });
    }
    assert.equal(url, `https://raw.githubusercontent.com/owner/repo/${commit}/nested/A.lean`);
    assert.equal(options.headers, undefined);
    return new Response("import Init\n");
  });
  const result = await sourcePreflight("secret", "owner/repo", commit);
  assert.equal(result.status, "fail");
  assert.equal(result.diagnostics[0].code, "source.module_required");
});

test("truncated trees, outages, and tree byte caps cannot establish an API pass", async (t) => {
  for (const response of [Response.json({ tree: [], truncated: true }),
    new Response("unavailable", { status: 503 }), new Response(" ".repeat(2 * 1024 * 1024 + 1))]) {
    t.mock.method(globalThis, "fetch", async () => response);
    assert.equal((await sourcePreflight("secret", "owner/repo", "a".repeat(40))).status, "incomplete");
    t.mock.restoreAll();
  }
});


test("source failures still disclose incomplete scans, and the API deadline aborts reads", async (t) => {
  const files = Array.from({ length: 33 }, (_, i) => entry(`${i}.lean`));
  const scan = await inspectLeanSources(files, async () => ({ text: "import Init\n", complete: true }), policy);
  assert.equal(scan.status, "fail");
  assert.equal(scan.incomplete, true);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }));
  const work = sourcePreflight("secret", "owner/repo", "a".repeat(40));
  t.mock.timers.tick(10_000);
  assert.equal((await work).status, "incomplete");
});


test("declared blob length requires EOF, including separately streamed extra bytes", async () => {
  const encoder = new TextEncoder();
  const streamed = (chunks) => {
    let index = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]));
        else controller.close();
      },
    }));
  };
  assert.equal(await readLeanSource(streamed(["module\n", "extra bytes"]), 7, 7), null);
  assert.deepEqual(await readLeanSource(streamed(["mod", "ule\n"]), 7, 7),
    { text: "module\n", complete: true });
});
