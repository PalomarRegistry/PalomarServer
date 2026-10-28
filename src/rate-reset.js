/** Server-owned, retryable cooldown resets, independent of browser polling. */
import { CLOSED } from "../public/statuses.js";
import { RateContractError, resetRateRecord, rateRecord } from "./admission-contract.js";
import { readState, transactState } from "./github.js";
import { StateContractError } from "./state-contract.js";
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

/**
 * Apply the reset and its receipt in one commit. A failed/ambiguous write never
 * leaves a receipt claiming a reset that did not land; concurrent admissions
 * and status polls re-evaluate the same fresh snapshot on ref contention.
 */
export async function settleRateReset(env, id) {
  const path = statePath(id, "state.json");
  const entry = await readState(env, path);
  if (!entry.value || entry.value.id !== id) {
    throw new StateContractError(`${path} is missing or has a different id`);
  }
  if (!CLOSED.has(entry.value.status)) return { settled: false, record: entry.value };
  if (!["registered", "changes-required"].includes(entry.value.status) || entry.value.rate_reset_at) {
    return { settled: true, record: entry.value };
  }
  const principalId = entry.value.push_proof?.principal?.id;
  if (!Number.isSafeInteger(principalId) || principalId <= 0) {
    throw new StateContractError(`${path} has no numeric principal for its rate reset`);
  }
  const rate = await ratePath(env, principalId);
  try {
    return await transactState(env, [path, rate], files => {
      const record = files[path].value;
      if (!record || record.id !== id || record.push_proof?.principal?.id !== principalId) {
        throw new StateContractError(`${path} changed its rate-reset identity`);
      }
      if (!["registered", "changes-required"].includes(record.status) || record.rate_reset_at) {
        return { changes: [], result: { settled: CLOSED.has(record.status), record } };
      }
      const current = files[rate].value;
      if (current !== null) rateRecord(current);
      const at = recordedAt();
      const reset = { ...record, rate_reset_at: at };
      const concession = record.status === "registered" || current?.starts <= 2;
      return {
        changes: [
          ...(current !== null && concession
            ? [{ path: rate, value: resetRateRecord(current, at) }] : []),
          { path, value: reset },
        ],
        message: `Settle admission interval after ${record.status} (${id})`,
        result: { settled: true, record: reset },
      };
    });
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof RateContractError) {
      throw new RateContractError(`${rate}: ${error.message}`);
    }
    throw error;
  }
}

/** Rotate a bounded batch so active or broken records cannot starve the rest. */
export async function reconcileRateResets(env) {
  const queue = rateResetQueue((await readState(env, RATE_RESET_INDEX_PATH)).value);
  const batch = queue.slice(0, BATCH_SIZE);
  if (!batch.length) return;
  const settled = new Set();
  const failures = [];
  for (const id of batch) {
    try {
      if ((await settleRateReset(env, id)).settled) settled.add(id);
    } catch (error) {
      console.error("rate-reset", id, String(error?.stack ?? error));
      failures.push(`${id}: ${error}`);
    }
  }
  await transactState(env, [
    RATE_RESET_INDEX_PATH, ...[...settled].map(id => statePath(id, "state.json")),
  ], files => {
    const current = rateResetQueue(files[RATE_RESET_INDEX_PATH].value);
    const visited = new Set(batch);
    // Operator recovery can reopen and requeue the same id after the first
    // read. Do not erase that renewed obligation with a stale cleanup result.
    const removable = new Set([...settled].filter(id =>
      CLOSED.has(files[statePath(id, "state.json")].value?.status),
    ));
    const next = [
      ...current.filter(id => !visited.has(id)),
      ...current.filter(id => visited.has(id) && !removable.has(id)),
    ];
    return {
      changes: JSON.stringify(current) === JSON.stringify(next) ? [] : [{
        path: RATE_RESET_INDEX_PATH, value: { schema_version: 1, open: next },
      }],
      message: "Advance pending admission interval resets",
    };
  });
  if (failures.length) throw new Error(`rate resets failed: ${failures.join("; ")}`);
}
