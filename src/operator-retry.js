/** Audited recovery of an admitted submission; never a new admission. */
import { admissionDecision } from "./admission-contract.js";
import { isTechnicalMaintainer } from "./technical-maintainers.js";
import { inflightOpen, reviewerOpen } from "./state-contract.js";
import { readStateSnapshot, commitStateSnapshot } from "./github.js";

export const EXECUTION_PROFILES = new Set(["palomar-standard-v1", "palomar-namespace-16x32-v1"]);

export function retryTransition(state, inflight, queue, { principal, reason, profile, attempt, at,
  namespaceEnabled = false }) {
  if (!isTechnicalMaintainer(principal)) throw new Error("Technical Maintainer identity required");
  if (!EXECUTION_PROFILES.has(profile)) throw new Error("unapproved execution profile");
  if (profile !== "palomar-standard-v1" && !namespaceEnabled) {
    throw new Error("Namespace is disabled pending confinement qualification");
  }
  if (!/^[0-9a-f]{32}$/.test(attempt)) throw new Error("invalid attempt identifier");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(at) || !Number.isFinite(Date.parse(at))) {
    throw new Error("invalid recovery timestamp");
  }
  if (state?.execution?.attempt === attempt || (state?.execution_history ?? []).some(item => item.execution?.attempt === attempt)) {
    throw new Error("execution attempt identifier has already been used");
  }
  if ((state?.operator_alerts?.items?.length ?? 0) >= 50) {
    throw new Error("operator alert history requires archival before another retry");
  }
  if (typeof reason !== "string" || !reason.trim() || reason.length > 2000) {
    throw new Error("a bounded operator reason is required");
  }
  if (!state || !["verification-error", "verification-failed", "dispatch-lost"].includes(state.status)) {
    throw new Error("only an admitted, failed full verification can be retried");
  }
  if (state.registry_correction) throw new Error("registry corrections require their own recovery path");
  if (!state.authorization || !state.submitter || !/^[0-9a-f]{40}$/.test(state.commit)) {
    throw new Error("admitted source and authorization are required");
  }
  const open = inflightOpen(inflight);
  const review = reviewerOpen(queue);
  if (open.some(item => item.id === state.id)) throw new Error("submission already holds an active slot");
  const decision = admissionDecision(open, state);
  if (decision.refused) throw new Error(decision.title);
  const next = structuredClone(state);
  // Freeze old alert origins before replacing mutable failure/run fields.
  if (next.operator_alerts?.schema_version === 1) {
    if (!state.failure || !Array.isArray(state.failure.diagnostics)) throw new Error("legacy alerts have no bound failure");
    next.operator_alerts = {
      schema_version: 2,
      items: next.operator_alerts.items.map(item => ({ ...item, origin: {
        id: state.id, repository: state.repository, commit: state.commit,
        test_submission: state.test_submission === true, failure: structuredClone(state.failure),
      } })),
    };
  }
  const history = next.execution_history ?? [];
  if (history.length >= 50) throw new Error("execution history requires operator archival");
  history.push({ execution: state.execution ?? null, run: state.run ?? null,
    failure: state.failure ?? null, status: state.status, archived_at: at });
  next.execution_history = history;
  next.execution = { attempt, profile, started_at: at,
    operator: { id: principal.id, login: principal.login }, reason: reason.trim() };
  for (const key of ["run", "failure", "run_misses", "dispatch_lease_at", "dispatch_lease_count"]) delete next[key];
  // A fresh execution gets a fresh rendering budget. Keep any retry deadline:
  // operator recovery must not shorten backoff or refund admission cooldowns.
  for (const key of ["renderability_attempts", "renderability_started_at", "renderability_error"]) delete next[key];
  next.status = "verifying";
  next.events = [...(next.events ?? []), { at, status: "verifying", note: "Technical Maintainer queued verification recovery" }];
  return {
    state: next,
    inflight: { open: [...open, { id: state.id, owner: state.owner, submitter: state.submitter, at }] },
    queue: { ...queue, open: review.includes(state.id) ? review : [...review, state.id] },
  };
}

export async function retryVerification(env, id, options, { apply = false } = {}) {
  if (!/^[0-9a-z]{12}$/.test(id)) throw new Error("invalid submission id");
  const path = `submissions/${id}/state.json`;
  const snapshot = await readStateSnapshot(env, [path, "index/inflight.json", "index/open.json"]);
  const result = retryTransition(snapshot.files[path].value,
    snapshot.files["index/inflight.json"].value, snapshot.files["index/open.json"].value, options);
  if (apply && !await commitStateSnapshot(env, snapshot, [
    { path, value: result.state }, { path: "index/inflight.json", value: result.inflight },
    { path: "index/open.json", value: result.queue },
  ], `Operator recovery ${id} attempt ${options.attempt}`)) {
    throw new Error("State changed; no retry committed. Reread and retry the command.");
  }
  // The normal durable dispatcher sends it after the atomic reservation. Do
  // not dispatch from this command: an ambiguous write must never create work.
  return { id, attempt: options.attempt, profile: options.profile, applied: apply };
}


/** Bind the operator identity and admission clock to the same GitHub response. */
export function authenticatedOperator(response) {
  const boundary = /\r?\n\r?\n/.exec(response);
  if (!boundary) throw new Error("GitHub did not return authenticated response headers");
  const header = response.slice(0, boundary.index);
  const date = /^date:\s*(.+)$/im.exec(header)?.[1];
  const instant = Date.parse(date);
  if (!Number.isFinite(instant)) throw new Error("GitHub did not provide its current time");
  const principal = JSON.parse(response.slice(boundary.index + boundary[0].length));
  return { principal, at: new Date(instant).toISOString().replace(/\.\d+Z$/, "Z") };
}
