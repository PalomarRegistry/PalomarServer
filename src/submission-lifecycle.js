/**
 * Durable submission lifecycle and scheduled maintenance.
 *
 * This module owns validated admission/reviewer index reads, their optimistic
 * writes, verification reconciliation, and abandoned-intake cleanup. Route
 * policy and HTTP presentation stay in the Worker composition root.
 */

import {
  deleteState,
  dispatchReviewer,
  findVerificationRun,
  listState,
  readState,
  writeState,
} from "./github.js";
import { recordedAt, statePath } from "./submission.js";
import {
  INFLIGHT_INDEX_PATH,
  inflightOpen,
  OPEN_INDEX_PATH,
  reviewerOpen,
  StateContractError,
} from "./state-contract.js";

// How old a `verifying` submission must be before a run nobody can find is
// treated as lost. Generous by three orders of magnitude: a dispatched run is
// listed within seconds, and this only ever applies to one that cannot be found
// at all.
const LOST_RUN_MS = 3600_000;

async function readContractIndex(env, path, validate) {
  let index;
  try {
    index = await readState(env, path);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new StateContractError(`${path} must contain valid JSON`);
  }
  return { ...index, open: validate(index.value) };
}

export function readInflightIndex(env) {
  return readContractIndex(env, INFLIGHT_INDEX_PATH, inflightOpen);
}

function readReviewerIndex(env) {
  return readContractIndex(env, OPEN_INDEX_PATH, reviewerOpen);
}

function reportStateContract(error) {
  console.error("state-contract", error.message);
}

export async function assertReviewerContract(env) {
  await readReviewerIndex(env);
}

/**
 * Say that a submission has work outstanding.
 *
 * The reviewer's pass used to find its work by listing `submissions/`, which is
 * an API call per submission per pass however few of them are moving, and which
 * stops working altogether at the thousand names the contents API will list.
 * It reads `index/open.json` instead, so a pass costs the queue rather than the
 * size of the registry.
 *
 * Only the reviewer removes entries, once the record says it is finished with
 * one. Adding has to happen here, because a submission the index never hears
 * about is a submission nothing reviews until the index is next rebuilt from
 * scratch. Written under the sha it was read at, like every other index, so a
 * concurrent change is surfaced instead of overwritten. That compare-and-swap
 * does not make the record, inflight index, and reviewer queue one transaction;
 * a conflict after an earlier write can still leave a partial admission.
 */
export async function openSubmission(env, id) {
  const index = await readReviewerIndex(env);
  const open = index.open;
  if (open.includes(id)) return;
  await writeState(
    env,
    OPEN_INDEX_PATH,
    { ...index.value, open: [...open, id] },
    `Open ${id}`,
    index.sha,
  );
}

export async function assertInflightContract(env) {
  await readInflightIndex(env);
}

export async function release(env, id) {
  const inflight = await readInflightIndex(env);
  const open = inflight.open;
  const changed = open.some((item) => item.id === id);
  if (!changed) return;
  await writeState(env, INFLIGHT_INDEX_PATH,
                   { open: open.filter((item) => item.id !== id) },
                   `Release ${id}`, inflight.sha);
}

/**
 * Free admission slots whose submissions have finished.
 *
 * Slots used to be released only when the submitter's page polled, so closing
 * the tab held one forever and enough abandoned submissions would wedge
 * intake. This runs on a schedule instead, so nothing depends on a browser
 * staying open. It may throw after committing safe partial progress: in
 * particular it releases unrelated terminal reservations, then fails the run
 * if a malformed reviewer queue kept a successful verification from settling.
 */
export async function reconcile(env) {
  const inflight = await readInflightIndex(env);
  const open = inflight.open;
  const still = [];
  let reviewerQueueUnavailable = false;
  for (const item of open) {
    const record = await readState(env, statePath(item.id, "state.json"));
    if (!record.value) continue;               // vanished: do not hold its slot
    if (record.value.status !== "verifying") continue;
    const pinned = record.value.run?.id ?? null;
    const { run, complete } = await findVerificationRun(env, item.id, {
      pinnedRunId: pinned,
      since: record.value.created_at,
    });

    // The same pinning that `refresh` in `src/index.js` documents, and for the
    // same reason: the submission id is in a public run name, so a second run
    // carrying it must not settle this record. Missing here before, and this is
    // the path that runs with nobody watching.
    if (pinned && run && run.id !== pinned) {
      still.push(item);
      continue;
    }

    // Pin a run that is not finished yet, and forget any miss recorded before it
    // was found. Waiting for a run to complete before writing it down meant
    // every pass searched by name again, and meant a miss recorded an hour ago
    // still counted against a run that has been answering ever since.
    //
    // Only for a run still going: a completed one is written by the settle
    // below, in the same commit as the status it produced, and writing it twice
    // here would leave the second write holding a sha the first one replaced.
    if (run && run.status !== "completed" && (!pinned || record.value.run_misses)) {
      const seen = { ...record.value, run };
      delete seen.run_misses;
      await writeState(env, statePath(item.id, "state.json"), seen,
                       `Pin the run for ${item.id}`, record.sha);
      still.push(item);
      continue;
    }

    if (run?.status === "completed") {
      const settled =
        run.conclusion === "success" ? "awaiting-review" : "verification-failed";
      // Before the record stops saying `verifying`, and not caught. A failure
      // here has to leave something that will be tried again, and the only
      // thing that gets retried is a submission still in flight. The reviewer's
      // weekly sweep would rebuild the whole index eventually, but a week is
      // not a repair for a submitter waiting on a review.
      if (settled === "awaiting-review") {
        if (reviewerQueueUnavailable) {
          still.push(item);
          continue;
        }
        try {
          await openSubmission(env, item.id);
        } catch (error) {
          if (!(error instanceof StateContractError)) throw error;
          reportStateContract(error);
          reviewerQueueUnavailable = true;
          still.push(item);
          continue;
        }
      }
      const done = {
        ...record.value,
        run,
        status: settled,
        events: [...record.value.events,
                 { at: recordedAt(), status: settled, note: `Verification ${run.conclusion}` }],
      };
      delete done.run_misses;
      await writeState(env, statePath(item.id, "state.json"), done,
                       `Reconcile ${item.id}`, record.sha);
      if (settled === "awaiting-review") {
        // Idempotent and cheap. A submission that settles without an entry here
        // is one the reviewer's pass never looks at. The reviewer can rebuild
        // the derived queue on its maintenance path, but this server never
        // treats a missing id or malformed queue as an empty one.
        await dispatchReviewer(env).catch(() => false);
      }
      continue;
    }

    // A run nothing can find is not a run this record is waiting for. With the
    // search bounded by time rather than by count this should not happen, which
    // is exactly why it needs a floor: a submission stuck in `verifying` holds
    // three separate quotas and nothing else releases it, so a bug here used to
    // mean a registry that quietly stopped accepting submissions and an
    // operator editing private state by hand.
    //
    // Two misses rather than one, because a single empty answer is as likely to
    // be GitHub having a moment as a genuinely lost run, and this ends a
    // submission somebody is waiting on. Finding the run clears the count, so
    // the two have to be consecutive. A run that is merely queued is found, and
    // is left alone however long it waits.
    //
    // Only when the search actually established that there is no such run. A
    // search that ran out of pages says where it stopped looking and nothing
    // more, and reading that as absence is how a live run loses its slot.
    if (!run && complete) {
      const missed = (record.value.run_misses ?? 0) + 1;
      const age = Date.now() - (Date.parse(record.value.created_at) || Date.now());
      if (missed >= 2 && age > LOST_RUN_MS) {
        await writeState(env, statePath(item.id, "state.json"), {
          ...record.value,
          status: "dispatch-lost",
          run_misses: missed,
          events: [...record.value.events, {
            at: recordedAt(), status: "dispatch-lost",
            note: "Palomar could not find the verification run it started, and released the slot",
          }],
        }, `Release ${item.id}: its run was never found`, record.sha);
        continue;                              // dropped from `still`: slot back
      }
      if (missed !== (record.value.run_misses ?? 0)) {
        await writeState(env, statePath(item.id, "state.json"),
                         { ...record.value, run_misses: missed },
                         `Note a missing run for ${item.id}`, record.sha).catch(() => {});
      }
    }
    still.push(item);
  }
  if (still.length !== open.length) {
    await writeState(env, INFLIGHT_INDEX_PATH, { open: still },
                     "Reconcile admissions", inflight.sha);
  }
  if (reviewerQueueUnavailable) {
    throw new StateContractError(
      `${OPEN_INDEX_PATH} is unavailable; successful verification was not queued`,
    );
  }
  return { released: open.length - still.length, open: still.length };
}

/**
 * Discard intake records nobody came back for.
 *
 * A pending record is written before the submitter is sent to GitHub. Most are
 * consumed seconds later; the ones from an abandoned sign-in are never
 * consumed at all, and without this they accumulate for the life of the
 * registry. They hold what somebody typed, so they are not kept indefinitely
 * for no reason.
 */
export async function sweepPending(env, now = Date.now()) {
  let removed = 0;
  for (const item of await listState(env, "pending")) {
    if (item.type !== "file" || !item.name.endsWith(".json")) continue;
    const record = await readState(env, `pending/${item.name}`);
    const created = Date.parse(record.value?.created_at ?? "");
    // An hour is far longer than a sign-in takes and short enough that an
    // abandoned one does not linger.
    if (Number.isFinite(created) && now - created < 3600_000) continue;
    if (await deleteState(env, `pending/${item.name}`, item.sha, "Discard an abandoned intake")) {
      removed += 1;
    }
  }
  return removed;
}

/**
 * Run both independent maintenance tasks and surface every failed task.
 *
 * One failure must not prevent the other task from making safe progress. The
 * aggregate throw happens only after both attempts, so the platform records a
 * failed cron invocation without abandoning cleanup that still works.
 */
export async function scheduledMaintenance(env) {
  const failures = [];
  for (const [what, task] of [["reconcile", reconcile], ["sweepPending", sweepPending]]) {
    try {
      await task(env);
    } catch (error) {
      console.error("scheduled", what, String(error?.stack ?? error));
      failures.push(`${what}: ${error}`);
    }
  }
  if (failures.length) throw new Error(`the scheduled pass failed: ${failures.join("; ")}`);
}
