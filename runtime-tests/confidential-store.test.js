// The lifecycle's compare-and-set and create-only writes, against workerd's
// own R2, so the in-memory bucket the Node tests use is checked against it.
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  createLifecycle,
  LifecycleConflict,
  newLifecycle,
  putOnce,
  readLifecycle,
  replaceLifecycle,
} from "../src/confidential-store.js";

test("lifecycle writes are compare-and-set in R2", async () => {
  const created = await createLifecycle(env, newLifecycle({
    id: "a1b2c3d4e5f6", repository: "owner/project", repositoryId: 77, commit: "c".repeat(40),
    sourceSha256: "f".repeat(64), at: "2026-11-28T00:00:00Z",
  }));
  await expect(createLifecycle(env, created.value)).rejects.toBeInstanceOf(LifecycleConflict);
  const held = await replaceLifecycle(env, created, { ...created.value, state: "held" });
  await expect(replaceLifecycle(env, created, { ...created.value, state: "withdrawn" }))
    .rejects.toBeInstanceOf(LifecycleConflict);
  expect((await readLifecycle(env, "a1b2c3d4e5f6")).value.state).toBe("held");
  await replaceLifecycle(env, held, { ...held.value, state: "withdrawn" });
  expect((await readLifecycle(env, "a1b2c3d4e5f6")).value.state).toBe("withdrawn");
});

test("create-only writes keep the first value", async () => {
  expect(await putOnce(env, "conf-tombstones/a1b2c3d4e5f6", "first")).toBe("first");
  expect(await putOnce(env, "conf-tombstones/a1b2c3d4e5f6", "second")).toBe("first");
});
