import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { rekeyPepperIndexes } from "../tools/rekey-pepper-indexes.js";

async function fixture(records) {
  const root = await mkdtemp(path.join(tmpdir(), "palomar-rekey-"));
  for (const directory of ["index/principals", "index/rate", "index/tokens"]) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  await writeFile(path.join(root, "index/principals", `${"a".repeat(64)}.json`), "{}\n");
  await writeFile(path.join(root, "index/rate", `${"b".repeat(64)}.json`), "{}\n");
  await writeFile(path.join(root, "index/tokens", `${"c".repeat(64)}.json`), "{}\n");
  for (const record of records) {
    const directory = path.join(root, "submissions", record.id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "state.json"), `${JSON.stringify(record)}\n`);
  }
  return root;
}

test("rekey groups principals, resets rate history, and preserves token pointers", async () => {
  const root = await fixture([
    { id: "one", status: "verifying", push_proof: { principal: { id: 42 } } },
    { id: "two", status: "registered", push_proof: { principal: { id: 42 } } },
    { id: "three", status: "withdrawn" },
  ]);
  const dry = await rekeyPepperIndexes({ root, pepper: "new-pepper" });
  assert.equal(dry.mode, "dry-run");
  assert.equal((await readdir(path.join(root, "index/principals"))).length, 1);

  const report = await rekeyPepperIndexes({ root, pepper: "new-pepper", write: true });
  assert.deepEqual(report, {
    mode: "write",
    records: 3,
    recoverable_records: 2,
    principal_documents_before: 1,
    principal_documents_after: 1,
    rate_documents_removed: 1,
    token_documents_preserved: 1,
  });
  const principalFiles = await readdir(path.join(root, "index/principals"));
  assert.equal(principalFiles.length, 1);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "index/principals", principalFiles[0]))), {
    schema_version: 1,
    submissions: ["one", "two"],
  });
  assert.deepEqual(await readdir(path.join(root, "index/rate")), []);
  assert.equal((await readdir(path.join(root, "index/tokens"))).length, 1);
});

test("rekey refuses a nonclosed record that OAuth recovery could not find", async () => {
  const root = await fixture([{ id: "one", status: "reviewing" }]);
  await assert.rejects(
    rekeyPepperIndexes({ root, pepper: "new-pepper", write: true }),
    /nonclosed submission has no numeric GitHub principal/,
  );
});
