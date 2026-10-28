/** Server-owned, retryable cooldown resets, independent of browser polling. */
import { CLOSED } from "../public/statuses.js";
import { RateContractError, resetRateRecord, rateRecord } from "./admission-contract.js";
import { readState, transactState } from "./github.js";
import { principalSubmissions, StateContractError } from "./state-contract.js";
import { digest, pepper, recordedAt, statePath } from "./submission.js";

export const RATE_RESET_INDEX_PATH = "index/rate-resets.json";
const BATCH_SIZE = 25;

export async function ratePath(env, principalId) {
  return `index/rate/${await digest(`${pepper(env)}:${principalId}`)}.json`;
}

/** Absence permits a rolling upgrade; a malformed present queue fails closed. */
export function rateResetQueue(value) {
  if (value === null) return [];
  if (!value || value.schema_version !== 1 || !Array.isArray(value.open) ||
      Object.keys(value).some(key => !["schema_version", "open"].includes(key)) ||
      value.open.some(id => typeof id !== "string" || !/^[0-9a-z]{12}$/.test(id)) ||
      new Set(value.open).size !== value.open.length) {
    throw new StateContractError(`${RATE_RESET_INDEX_PATH} must contain unique submission ids`);
  }
  return value.open;
}

function resettable(record) {
  return ["registered", "changes-required"].includes(record.status);
}

function checkRecord(record, id) {
  if (!record || record.id !== id) {
    throw new StateContractError(`${statePath(id, "state.json")} is missing or has a different id`);
  }
  if (record.events !== undefined && !Array.isArray(record.events)) {
    throw new StateContractError(`${id} has malformed status events`);
  }
  return record;
}

/**
 * One batch, one commit: receipts, deduplicated rate changes and queue cleanup
 * share a snapshot. Corrupt individual files remain queued; transport failures
 * abort the batch rather than continuing to write against a rate-limited API.
 */
async function settleBatch(env, ids, { rotate = false, principalId = null } = {}) {
  const hints = new Map();
  const failures = [];
  const fail = (id, error) => {
    console.error("rate-reset", id, String(error?.stack ?? error));
    failures.push(`${id}: ${error}`);
  };
  for (const id of ids) {
    try {
      const record = checkRecord((await readState(env, statePath(id, "state.json"))).value, id);
      const principal = record.push_proof?.principal?.id;
      hints.set(id, {
        principal,
        rate: resettable(record) && !record.rate_reset_at && Number.isSafeInteger(principal) && principal > 0
          ? await ratePath(env, principal) : null,
      });
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof StateContractError)) throw error;
      fail(id, error);
    }
  }
  const paths = [...new Set([
    RATE_RESET_INDEX_PATH, ...[...hints].flatMap(([id, hint]) => [
      statePath(id, "state.json"), ...(hint.rate ? [hint.rate] : []),
    ]),
  ])];
  const result = await transactState(env, paths, files => {
    const queueFile = files[RATE_RESET_INDEX_PATH];
    if (queueFile.error) throw queueFile.error;
    const queue = rateResetQueue(queueFile.value);
    const changes = new Map();
    const settled = new Set();
    const records = new Map();
    const errors = [];
    const at = recordedAt();
    for (const [id, hint] of hints) {
      try {
        const file = files[statePath(id, "state.json")];
        if (file.error) throw file.error;
        const record = checkRecord(file.value, id);
        records.set(id, record);
        const principal = record.push_proof?.principal?.id;
        if (principalId !== null && principal !== principalId) {
          throw new StateContractError(`${id} does not belong to the authenticated principal`);
        }
        if (!CLOSED.has(record.status)) continue;
        if (resettable(record) && !record.rate_reset_at) {
          if (!Number.isSafeInteger(principal) || principal <= 0) {
            throw new StateContractError(`${id} has no numeric principal for its rate reset`);
          }
          // A record that became registered after the hint read waits for the
          // next pass, since its rate file is not in this exact snapshot yet.
          if (principal !== hint.principal) throw new StateContractError(`${id} changed its principal`);
          if (!hint.rate) continue;
          const rateFile = files[hint.rate];
          if (rateFile.error) throw rateFile.error;
          const current = rateFile.value;
          if (current !== null) rateRecord(current);
          const completedAt = record.events?.findLast(event => event?.status === record.status)?.at;
          if (completedAt !== undefined &&
              (typeof completedAt !== "string" || !Number.isFinite(Date.parse(completedAt)))) {
            throw new StateContractError(`${id} has a malformed completion time`);
          }
          // A delayed historic registration must not erase the cooldown earned
          // by starts made after it completed. A legacy record without an event
          // retains the earlier reset behavior.
          const laterStart = current !== null && completedAt &&
            Date.parse(current.last_start_at) > Date.parse(completedAt);
          const concession = record.status === "registered" || current?.starts <= 2;
          if (current !== null && concession && !laterStart) {
            changes.set(hint.rate, { path: hint.rate, value: resetRateRecord(current, at) });
          }
          const reset = { ...record, rate_reset_at: at };
          const path = statePath(id, "state.json");
          changes.set(path, { path, value: reset });
          records.set(id, reset);
        }
        settled.add(id);
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof StateContractError || error instanceof RateContractError)) throw error;
        errors.push([id, error]);
      }
    }
    const visited = new Set(ids);
    const next = rotate ? [
      ...queue.filter(id => !visited.has(id)),
      ...queue.filter(id => visited.has(id) && !settled.has(id)),
    ] : queue.filter(id => !settled.has(id));
    if (JSON.stringify(queue) !== JSON.stringify(next)) {
      changes.set(RATE_RESET_INDEX_PATH, {
        path: RATE_RESET_INDEX_PATH, value: { schema_version: 1, open: next },
      });
    }
    return {
      changes: [...changes.values()],
      message: "Settle pending admission interval resets",
      result: { settled, records, errors },
    };
  }, { tolerateMalformed: true });
  for (const [id, error] of result.errors) fail(id, error);
  if (failures.length) throw new Error(`rate resets failed: ${failures.join("; ")}`);
  return result;
}

/** Status polling is an optional fast path to the same atomic batch logic. */
export async function settleRateReset(env, id) {
  const result = await settleBatch(env, [id]);
  return { settled: result.settled.has(id), record: result.records.get(id) };
}

/**
 * Scheduled work rotates a bounded batch. A rate-limited returning submitter
 * catches up their newest queued outcomes directly, independent of queue size.
 */
export async function reconcileRateResets(env, { principalId = null } = {}) {
  const queue = rateResetQueue((await readState(env, RATE_RESET_INDEX_PATH)).value);
  let candidates = queue;
  if (principalId !== null) {
    const path = `index/principals/${await digest(`${pepper(env)}:${principalId}`)}.json`;
    const locator = await readState(env, path);
    const own = locator.value === null ? [] : principalSubmissions(locator.value, path);
    const pending = new Set(queue);
    candidates = own.filter(id => pending.has(id)).reverse();
  }
  const batch = candidates.slice(0, BATCH_SIZE);
  if (batch.length) await settleBatch(env, batch, { rotate: principalId === null, principalId });
}
