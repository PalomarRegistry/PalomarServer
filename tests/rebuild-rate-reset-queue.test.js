import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { rebuildRateResetQueue } from "../tools/rebuild-rate-reset-queue.js";

test("recovery is dry-run by default and seeds missed resets without changing submissions", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "palomar-rate-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statuses = ["registered", "awaiting-review", "changes-required", "withdrawn",
    "verification-failed", "registered", "registered", "registered"];
  const records = statuses.map((status, i) => ({
    id: String(i).padStart(12, "0"), status, push_proof: { principal: { id: 4242 } },
    ...(i === 5 ? { rate_reset_at: "2026-10-05T18:52:53Z" } : {}),
    ...(i === 6 ? { push_proof: { technical_maintainer: true, principal: { id: 477956 } } } : {}),
    ...(i === 7 ? { push_proof: {} } : {}),
  }));
  for (const record of records) {
    const directory = path.join(root, "submissions", record.id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "state.json"), JSON.stringify(record));
  }
  const report = await rebuildRateResetQueue({ root });
  assert.deepEqual(report, { mode: "dry-run", before: 0, added: 3, queued: 3 });
  const queuePath = path.join(root, "index/rate-resets.json");
  await assert.rejects(readFile(queuePath), { code: "ENOENT" });

  await rebuildRateResetQueue({ root, write: true });
  const expected = [records[0].id, records[2].id, records[1].id];
  assert.deepEqual(JSON.parse(await readFile(queuePath, "utf8")), {
    schema_version: 1, open: expected,
  });
  const other = "a1b2c3d4e5f6";
  await writeFile(queuePath, JSON.stringify({ schema_version: 1, open: [other, records[0].id] }));
  await rebuildRateResetQueue({ root, write: true });
  assert.deepEqual(JSON.parse(await readFile(queuePath, "utf8")).open, [other, ...expected]);
  assert.equal((await rebuildRateResetQueue({ root, write: true })).added, 0);
  for (const record of records) {
    assert.deepEqual(JSON.parse(await readFile(path.join(root, "submissions", record.id, "state.json"), "utf8")), record);
  }
});

test("recovery rejects malformed input before writing any queue", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "palomar-rate-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "submissions", "a1b2c3d4e5f6");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "state.json"), JSON.stringify({ id: "different" }));
  await assert.rejects(rebuildRateResetQueue({ root, write: true }), /does not match/);
  await assert.rejects(readFile(path.join(root, "index/rate-resets.json")), { code: "ENOENT" });
});
