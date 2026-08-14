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

export function activeSubmissionPhase(record) {
  if (record.status === "preflighting") {
    return {
      mode: "preflight",
      runField: "preflight_run",
      missesField: "preflight_run_misses",
      leaseAtField: "preflight_dispatch_lease_at",
      leaseCountField: "preflight_dispatch_lease_count",
    };
  }
  if (record.status === "verifying") {
    return {
      mode: "full",
      runField: "run",
      missesField: "run_misses",
      leaseAtField: "dispatch_lease_at",
      leaseCountField: "dispatch_lease_count",
    };
  }
  return null;
}

function clearPhaseOutbox(record, phase) {
  delete record[phase.missesField];
  delete record[phase.leaseAtField];
  delete record[phase.leaseCountField];
}

async function failUnrecoverableRun(env, item, record, phase, note) {
  const status = phase.mode === "preflight" ? "preflight-failed" : "dispatch-lost";
  const failed = {
    ...record.value,
    status,
    failure: {
      schema_version: 1,
      mode: phase.mode,
      run: record.value[phase.runField] ?? null,
      diagnostics: [{
        code: "palomar.dispatch_lost",
        stage: "dispatch",
        owner: "palomar",
        summary: "Palomar lost track of the workflow run it started.",
        explanation: note,
        next_action: "Do not change the repository. Retry the same commit later.",
        retryable: true,
        repairable: false,
      }],
    },
    events: [
      ...record.value.events,
      { at: recordedAt(), status, note },
    ],
  };
  clearPhaseOutbox(failed, phase);
  await writeState(
    env,
    statePath(item.id, "state.json"),
    failed,
    `Fail unrecoverable ${phase.mode} ${item.id}`,
    record.sha,
  );
}

/** Dispatch the verification described entirely by one durable State record. */
export function dispatchSubmissionVerification(env, record, mode = "full") {
  return dispatchVerification(env, {
    repositoryName: record.repository,
    commit: record.commit,
    requestId: record.id,
    mode,
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
      // The submitter's notes are deliberately absent. Dispatch inputs are
      // world-readable on the public submission repository's run page, the
      // form promises the notes never reach that workflow, and the workflow
      // never reads them: the AI review takes them from the private State
      // record.
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
    const phase = activeSubmissionPhase(record.value);
    if (!phase) continue;
    const pinned = record.value[phase.runField]?.id ?? null;
    const { run, complete } = await findVerificationRun(env, item.id, {
      pinnedRunId: pinned,
      since: record.value.created_at,
      mode: phase.mode,
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
    if (run && run.status !== "completed" && (!pinned || record.value[phase.missesField])) {
      const seen = { ...record.value, [phase.runField]: run };
      clearPhaseOutbox(seen, phase);
      await writeState(env, statePath(item.id, "state.json"), seen,
                       `Pin the ${phase.mode} run for ${item.id}`, record.sha);
      still.push(item);
      continue;
    }

    if (run?.status === "completed") {
      if (phase.mode === "preflight" && run.conclusion === "success") {
        const queuedAt = recordedAt();
        const verifying = {
          ...record.value,
          [phase.runField]: run,
          status: "verifying",
          dispatch_lease_at: queuedAt,
          dispatch_lease_count: 1,
          events: [
            ...record.value.events,
            { at: queuedAt, status: "verifying", note: "Preflight passed; verification queued" },
          ],
        };
        clearPhaseOutbox(verifying, phase);
        await writeState(
          env,
          statePath(item.id, "state.json"),
          verifying,
          `Queue full verification for ${item.id}`,
          record.sha,
        );
        try {
          await dispatchSubmissionVerification(env, verifying, "full");
        } catch (error) {
          console.error("verification-dispatch", item.id, error?.stack ?? String(error));
          dispatchFailures.push(`${item.id}: ${error}`);
        }
        still.push(item);
        continue;
      }
      const settled = phase.mode === "preflight"
        ? "preflight-reporting"
        : run.conclusion === "success" ? "awaiting-review" : "verification-reporting";
      // Before the record stops saying `verifying`, and not caught. A failure
      // here has to leave something that will be tried again, and the only
      // thing that gets retried is a submission still in flight. The reviewer's
      // weekly sweep would rebuild the whole index eventually, but a week is
      // not a repair for a submitter waiting on a review.
      if (["awaiting-review", "preflight-reporting", "verification-reporting"].includes(settled)) {
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
        [phase.runField]: run,
        status: settled,
        events: [...record.value.events,
                 {
                   at: recordedAt(),
                   status: settled,
                   note: `${phase.mode === "preflight" ? "Preflight" : "Verification"} ${run.conclusion}`,
                 }],
      };
      clearPhaseOutbox(done, phase);
      await writeState(env, statePath(item.id, "state.json"), done,
                       `Reconcile ${item.id}`, record.sha);
      if (["awaiting-review", "preflight-reporting", "verification-reporting"].includes(settled)) {
        // Idempotent and cheap. A submission that settles without an entry here
        // is one the reviewer's pass never looks at. The reviewer can rebuild
        // the derived queue on its maintenance path, but this server never
        // treats a missing id or malformed queue as an empty one.
        await dispatchReviewer(env).catch(() => false);
      }
      continue;
    }

    // An active record with no pinned run is its mode-specific durable outbox.
    // Search before dispatching: workflow_dispatch returns no run id, so a
    // crash after GitHub accepted it is indistinguishable from a crash before
    // the request unless the run is recovered by name. Only a complete search
    // may authorize a retry; a truncated search leaves the item pending.
    if (!run && complete && pinned) {
      await failUnrecoverableRun(
        env,
        item,
        record,
        phase,
        "The pinned verification run no longer exists",
      );
      continue;
    }
    if (!run && complete && !pinned) {
      const now = Date.now();
      const leaseAt = Date.parse(record.value[phase.leaseAtField] ?? record.value.created_at);
      const age = Number.isFinite(leaseAt) && leaseAt <= now ? now - leaseAt : Infinity;
      if (age >= DISPATCH_RETRY_MS) {
        const attempts = Number(record.value[phase.leaseCountField] ?? 0);
        if (!Number.isSafeInteger(attempts) || attempts < 0) {
          dispatchFailures.push(`${item.id}: ${phase.mode} dispatch attempt state is invalid`);
          still.push(item);
          continue;
        }
        if (attempts >= MAX_DISPATCH_ATTEMPTS) {
          await failUnrecoverableRun(
            env,
            item,
            record,
            phase,
            `Verification dispatch was not discoverable after ${attempts} attempts`,
          );
          continue;
        }
        const claimed = {
          ...record.value,
          [phase.leaseAtField]: recordedAt(),
          [phase.leaseCountField]: attempts + 1,
        };
        try {
          await writeState(
            env,
            statePath(item.id, "state.json"),
            claimed,
            `Claim ${phase.mode} dispatch for ${item.id}`,
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
          await dispatchSubmissionVerification(env, claimed, phase.mode);
        } catch (error) {
          console.error(`${phase.mode}-dispatch`, item.id, error?.stack ?? String(error));
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
 * How long an unconsumed intake record is kept.
 *
 * A quarter of an hour, because this is what decides how much of the ceiling
 * on concurrent intake one address can hold at once. Nothing authenticates a
 * submitter before the record is written, and the address throttle allows five
 * intakes a minute, so the allowance multiplied by that rate is the share of
 * the ceiling a single unauthenticated host can occupy: an hour was more than
 * the whole of it, and a quarter of an hour is about a third. The ceiling stays
 * where it is as the backstop; this is what stops one host reaching it.
 *
 * It is still far longer than the round trip it exists for. A browser sign-in
 * is a redirect to GitHub and back, and the agent path is two API calls, both
 * of them minutes at the outside.
 */
export const PENDING_TTL_MS = 15 * 60_000;

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
    if (Number.isFinite(created) && now - created < PENDING_TTL_MS) continue;
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
