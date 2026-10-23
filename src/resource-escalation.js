/** Operator-owned access to bounded, authenticated resource retries. */
import policy from "./resource-escalation-policy.json" with { type: "json" };
import { admissionDecision } from "./admission-contract.js";
import { commitStateSnapshot, readStateSnapshot } from "./github.js";
import { digest, recordedAt, statePath } from "./submission.js";
import { inflightOpen, reviewerOpen, StateContractError } from "./state-contract.js";

export const DEFAULT_PROFILE = "palomar-namespace-16x32-v1";
export const LARGER_PROFILE = "palomar-namespace-32x64-v1";
export const RESOURCE_CONTACT = "Contact Kim Morrison (@kim-em on GitHub) with the workflow URL to request " +
  "access to larger runners. Automatic resource retries require an allowlisted GitHub account; " +
  "repeatedly submitting the same commit will not grant access.";
export const LARGER_CONTACT = "The larger-runner attempt also reached a resource limit. " +
  "Contact Kim Morrison (@kim-em on GitHub) with the workflow URL for help. " +
  "Automatic escalation stops after one retry.";

export function validatePolicy(value) {
  if (!value || Object.keys(value).sort().join() !== "schema_version,users" ||
      value.schema_version !== 1 || !Array.isArray(value.users) || value.users.length > 1000) {
    throw new StateContractError("resource escalation policy is malformed");
  }
  const ids = new Set();
  for (const user of value.users) {
    if (!user || Object.keys(user).sort().join() !== "id,login" ||
        !Number.isSafeInteger(user.id) || user.id < 1 || ids.has(user.id) ||
        typeof user.login !== "string" || !/^[A-Za-z0-9_-]{1,39}$/.test(user.login)) {
      throw new StateContractError("resource escalation allowlist entry is malformed");
    }
    ids.add(user.id);
  }
  return ids;
}

export function resourceFailure(state) {
  const failure = state?.failure;
  const resource = failure?.resource_failure;
  return state?.status === "verification-error" && !state.registry_correction &&
    failure?.mode === "full" && failure.phase === "verification" &&
    resource && Object.keys(resource).sort().join() === "kind,profile,run_id" &&
    ["oom", "timeout"].includes(resource.kind) &&
    [DEFAULT_PROFILE, LARGER_PROFILE].includes(resource.profile) &&
    Number.isSafeInteger(resource.run_id) && resource.run_id > 0 &&
    resource.run_id === failure.run?.id && resource.run_id === state.run?.id &&
    state.run?.status === "completed" && ["failure", "timed_out"].includes(state.run.conclusion) &&
    Array.isArray(failure.diagnostics) && failure.diagnostics.length > 0 &&
    failure.diagnostics.every(item => item?.owner === "provider" &&
      ["provider.resource_exhausted", "provider.workflow_timeout"].includes(item.code))
    ? resource : null;
}

export function escalationDecision(state, selectedPolicy = policy) {
  const ids = validatePolicy(selectedPolicy);
  const resource = resourceFailure(state);
  const principal = state?.push_proof?.principal;
  if (!resource || state.push_verified !== true || !state.authorization || !state.submitter ||
      !/^[0-9a-f]{40}$/.test(state.commit) ||
      !Number.isSafeInteger(principal?.id) || !ids.has(principal.id) ||
      principal.login !== state.submitter) return null;
  if (resource.profile !== DEFAULT_PROFILE ||
      (state.execution_history?.length ?? 0) >= 50 || (state.operator_alerts?.items?.length ?? 0) >= 50 ||
      (state.execution?.profile && state.execution.profile !== resource.profile) ||
      state.execution?.automatic || (state.execution_history ?? []).some(row => row.execution?.automatic)) return null;
  return { profile: LARGER_PROFILE, principal_id: principal.id, resource };
}

export function retryProjection(state, inflight, queue, decision, { attempt, at, policyHash }) {
  if (decision?.profile !== LARGER_PROFILE || decision.resource !== resourceFailure(state) ||
      decision.resource?.profile !== DEFAULT_PROFILE ||
      decision.principal_id !== state.push_proof?.principal?.id ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(at) || !Number.isFinite(Date.parse(at))) {
    throw new StateContractError("invalid resource retry decision");
  }
  const open = inflightOpen(inflight);
  const review = reviewerOpen(queue);
  const history = state.execution_history ?? [];
  if (history.length >= 50 || (state.operator_alerts?.items?.length ?? 0) >= 50) {
    throw new StateContractError("resource retry history requires operator archival");
  }
  if (!/^[0-9a-f]{32}$/.test(attempt) || !/^[0-9a-f]{64}$/.test(policyHash) ||
      state.execution?.attempt === attempt || history.some(row => row.execution?.attempt === attempt)) {
    throw new StateContractError("invalid or reused resource retry identity");
  }
  const held = open.find(item => item.id === state.id);
  if (held && (held.owner !== state.owner || held.submitter !== state.submitter)) {
    throw new StateContractError("resource retry reservation does not match its submission");
  }
  if (admissionDecision(open.filter(item => item.id !== state.id), state).refused) return null;
  const next = structuredClone(state);
  if (next.operator_alerts?.schema_version === 1) {
    next.operator_alerts = { schema_version: 2, items: next.operator_alerts.items.map(item => ({
      ...item, origin: { id: state.id, repository: state.repository, commit: state.commit,
        test_submission: state.test_submission === true, failure: structuredClone(state.failure) },
    })) };
  }
  next.execution_history = [...history, { execution: state.execution ?? null, run: state.run,
    failure: state.failure, status: state.status, archived_at: at }];
  next.execution = { attempt, profile: decision.profile, started_at: at,
    automatic: { schema_version: 1, policy_sha256: policyHash, principal_id: decision.principal_id,
      from_profile: decision.resource.profile, run_id: decision.resource.run_id },
    reason: "Allowlisted account: automatic retry after an authenticated worker resource limit" };
  for (const key of ["run", "failure", "run_misses", "dispatch_lease_at", "dispatch_lease_count",
    "renderability_attempts", "renderability_started_at", "renderability_error", "renderability_request"]) delete next[key];
  next.status = "verifying";
  next.events = [...(next.events ?? []), { at, status: "verifying",
    note: "Resource verification retry queued on a larger runner" }];
  return { state: next, inflight: held ? inflight : { open: [...open,
    { id: state.id, owner: state.owner, submitter: state.submitter, at }] },
  queue: { ...queue, open: review.includes(state.id) ? review : [...review, state.id] }, held: Boolean(held) };
}

/** Reserve before dispatch. The ordinary durable dispatcher handles crashes and ambiguity. */
export async function maybeEscalate(env, record, selectedPolicy = policy) {
  if (!escalationDecision(record, selectedPolicy)) return null;
  const path = statePath(record.id, "state.json");
  const snapshot = await readStateSnapshot(env, [path, "index/inflight.json", "index/open.json"]);
  const state = snapshot.files[path].value;
  const decision = escalationDecision(state, selectedPolicy);
  if (!decision) return null;
  const attempt = crypto.randomUUID().replaceAll("-", "");
  const result = retryProjection(state, snapshot.files["index/inflight.json"].value,
    snapshot.files["index/open.json"].value, decision, {
      attempt, at: recordedAt(), policyHash: await digest(JSON.stringify(selectedPolicy)),
    });
  if (!result) return null;
  const updates = [{ path, value: result.state }, { path: "index/open.json", value: result.queue }];
  // A held reservation stays byte-identical so reconciliation may still
  // conditionally release unrelated terminal slots using its original SHA.
  if (!result.held) updates.push({ path: "index/inflight.json", value: result.inflight });
  if (!await commitStateSnapshot(env, snapshot, updates, `Queue resource retry ${state.id} ${attempt}`)) return null;
  return result.state;
}

/** Expose actionable advice without adding allowlist details to the API. */
export function publicFailure(record) {
  const resource = resourceFailure(record);
  if (!resource) return record.failure ?? null;
  return { ...record.failure, diagnostics: record.failure.diagnostics.map(item => ({
    ...item, retryable: false,
    next_action: resource.profile === LARGER_PROFILE ? LARGER_CONTACT : RESOURCE_CONTACT,
  })) };
}
