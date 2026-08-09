/**
 * Durable submission lifecycle and scheduled maintenance.
 *
 * This module owns validated admission/reviewer index reads, their optimistic
 * writes, verification reconciliation, and abandoned-intake cleanup. Route
 * policy and HTTP presentation stay in the Worker composition root.
 */

import {
  deleteState,
  dispatchVerification,
  dispatchReviewer,
  findVerificationRun,
  GitHubError,
  listState,
  readState,
  writeState,
} from "./github.js";
import { authorizationRelationshipLabel } from "./intake-contract.js";
import { recordedAt, statePath } from "./submission.js";
import {
  INFLIGHT_INDEX_PATH,
  inflightOpen,
  OPEN_INDEX_PATH,
  reviewerOpen,
  StateContractError,
} from "./state-contract.js";

// GitHub normally lists a dispatched run within seconds. Waiting five minutes
// before retrying makes a successful-but-ambiguous dispatch overwhelmingly
// likely to be found first, while the ten-minute scheduled pass still repairs
// a crash before dispatch or a rejected dispatch without operator action.
const DISPATCH_RETRY_MS = 5 * 60_000;
const MAX_DISPATCH_ATTEMPTS = 3;

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

/** Dispatch the verification described entirely by one durable State record. */
export function dispatchSubmissionVerification(env, record) {
  return dispatchVerification(env, {
    repositoryName: record.repository,
    commit: record.commit,
    requestId: record.id,
    options: {
      authorization_relationship: authorizationRelationshipLabel(
        record.authorization.relationship,
      ),
      ...Object.fromEntries(
        Object.entries(record.requested_paths ?? {}).filter(([, value]) => value),
      ),
      ...(record.authorization.evidence
        ? { authorization_evidence: record.authorization.evidence }
        : {}),
      ...(record.existing_id ? { existing_id: record.existing_id } : {}),
      ...(record.context ? { context: record.context } : {}),
    },
  });
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
 * Admission adds its first queue entry inside the atomic admission commit.
 * This helper repairs or reopens the queue later, after verification or a
 * submitter retry. It remains an optimistic single-file update because the
 * surrounding record transition is deliberately ordered and retryable.
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
  const dispatchFailures = [];
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
      delete seen.dispatch_lease_at;
      delete seen.dispatch_lease_count;
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
      delete done.dispatch_lease_at;
      delete done.dispatch_lease_count;
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

    // A `verifying` record with no pinned run is the durable dispatch outbox.
    // Search before dispatching: workflow_dispatch returns no run id, so a
    // crash after GitHub accepted it is indistinguishable from a crash before
    // the request unless the run is recovered by name. Only a complete search
    // may authorize a retry; a truncated search leaves the item pending.
    if (!run && complete && pinned) {
      dispatchFailures.push(`${item.id}: its pinned verification run is unavailable`);
    }
    if (!run && complete && !pinned) {
      const now = Date.now();
      const leaseAt = Date.parse(record.value.dispatch_lease_at ?? record.value.created_at);
      const age = Number.isFinite(leaseAt) && leaseAt <= now ? now - leaseAt : Infinity;
      if (age >= DISPATCH_RETRY_MS) {
        const attempts = Number(record.value.dispatch_lease_count ?? 0);
        if (!Number.isSafeInteger(attempts) || attempts < 0 || attempts >= MAX_DISPATCH_ATTEMPTS) {
          dispatchFailures.push(
            `${item.id}: verification dispatch was not discoverable after ${attempts} attempts`,
          );
          still.push(item);
          continue;
        }
        const claimed = {
          ...record.value,
          dispatch_lease_at: recordedAt(),
          dispatch_lease_count: attempts + 1,
        };
        try {
          await writeState(
            env,
            statePath(item.id, "state.json"),
            claimed,
            `Claim verification dispatch for ${item.id}`,
            record.sha,
          );
        } catch (error) {
          // Another lifecycle pass claimed this exact outbox item. It will
          // dispatch, or its lease will expire and a later pass will retry.
          if (error instanceof GitHubError && [409, 422].includes(error.status)) {
            still.push(item);
            continue;
          }
          throw error;
        }
        try {
          await dispatchSubmissionVerification(env, claimed);
        } catch (error) {
          console.error("verification-dispatch", item.id, error?.stack ?? String(error));
          dispatchFailures.push(`${item.id}: ${error}`);
        }
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
  if (dispatchFailures.length) {
    throw new Error(`verification dispatch retry failed: ${dispatchFailures.join("; ")}`);
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
