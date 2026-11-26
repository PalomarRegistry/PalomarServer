/**
 * Ticket rules (contract v2.1 section 3.2), as pure functions over one ticket.
 *
 * A ticket is issued with a dispatch that needs one and is presented by a run
 * whose JWT has already been validated (`oidc.js`), so an invalid JWT never
 * reaches these functions and can never poison a ticket.
 *
 * `operations` is the ticket's permitted progression:
 *
 *   ["snapshot", "validate"]   a verification dispatch
 *   ["restore"]                a render or re-run
 *   ["evidence"]               State review work (with `evidence_revision`)
 *   ["restore", "evidence"]    State review work that restores first
 *   ["publish"]                a release (with `release_attempt`)
 *
 * A later operation may be used only after the earlier one's capability
 * exists, and `validate` only once every snapshot key is complete. Each
 * operation has its own budget of three mints; a retry by the same binding
 * mints a fresh capability for that operation, which is how a lost response
 * is recovered.
 *
 * The elected run is fixed by the first presentation. Its binding is the run
 * (id, attempt, repository) and its caller: the dispatched workflow in the
 * calling repository, which is the same for every job of that run whatever
 * reusable workflow each job calls. A second run with the same repository and
 * caller is a doubled dispatch and is refused as a duplicate without changing
 * the ticket, whichever operation it presents. Anything else outside the
 * rules poisons the ticket.
 */

export const PROGRESSIONS = Object.freeze([
  ["snapshot", "validate"],
  ["restore"],
  ["evidence"],
  ["restore", "evidence"],
  ["publish"],
]);
export const TICKET_LIFETIME_MS = 6 * 60 * 60_000;
export const MAX_MINTS = 3;

function iso(now) {
  return new Date(now).toISOString().replace(/\.\d+Z$/, "Z");
}

function sameList(a, b) {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** A new ticket record. `ticketHash` is the `ticket`-kind digest of the plaintext. */
export function issueTicket({ ticketHash, operations, submissionId, generation, nonce, admitted, now,
  snapshotSha256 = null, evidenceRevision = null, releaseAttempt = null }) {
  if (!Array.isArray(operations) || !PROGRESSIONS.some((item) => sameList(item, operations))) {
    throw new TypeError("unknown ticket progression");
  }
  if (!/^[0-9a-f]{64}$/.test(String(ticketHash))) throw new TypeError("invalid ticket hash");
  if (operations.includes("evidence") && !Number.isSafeInteger(evidenceRevision)) {
    throw new TypeError("an evidence ticket names its base evidence revision");
  }
  if (operations.includes("publish") && typeof releaseAttempt !== "string") {
    throw new TypeError("a publish ticket names its release attempt");
  }
  if (operations[0] === "snapshot" && !/^[0-9a-f]{40}$/.test(String(admitted?.pipeline_commit ?? ""))) {
    throw new TypeError("a snapshot ticket names its admitted pipeline commit");
  }
  return {
    ticket_hash: ticketHash,
    operations: [...operations],
    submission_id: submissionId,
    generation,
    nonce,
    admitted: admitted ?? null,
    snapshot_sha256: snapshotSha256,
    evidence_revision: evidenceRevision,
    release_attempt: releaseAttempt,
    issued_at: iso(now),
    expires_at: iso(now + TICKET_LIFETIME_MS),
    bound: null,
    mints: Object.fromEntries(operations.map((operation) => [operation, 0])),
    poisoned: null,
  };
}

/**
 * Present a ticket. Answers `{ticket, ok: true, operation, mint}` or
 * `{ticket, ok: false, status, error, poisoned?, duplicate?}`; the returned
 * ticket is always the one to store, because a refusal may poison it.
 *
 * - `binding` is `{run_id, run_attempt, repository_id}` from the JWT.
 * - `identity` is `{repository_id, workflow, caller}`: the called workflow
 *   path without its pin, and the caller `workflow_ref`.
 * - `pipelineCommit` is the validated P of a runs-repository token, null for
 *   State; it must equal the admitted pin of a snapshot ticket.
 * - `fences` are the actor's current `{generation, evidence_revision,
 *   release_attempt}`; `snapshotComplete` says every snapshot key is complete.
 */
export function presentTicket(stored, {
  operation, binding, identity, pipelineCommit = null, fences, snapshotComplete = false, now,
}) {
  const ticket = structuredClone(stored);
  const refused = (status, error, extra = {}) => ({ ticket, ok: false, status, error, ...extra });
  const poison = (reason) => {
    if (!ticket.poisoned) ticket.poisoned = { reason, at: iso(now) };
    return refused(409, "ticket-refused", { poisoned: true });
  };
  if (ticket.poisoned) return refused(409, "ticket-refused");

  // The election comes first: a doubled dispatch must never be able to
  // poison the ticket of the run that was elected, whatever it presents.
  if (ticket.bound !== null) {
    const sameRun = ticket.bound.run_id === binding.run_id &&
      ticket.bound.run_attempt === binding.run_attempt &&
      ticket.bound.repository_id === binding.repository_id;
    if (!sameRun) {
      if (ticket.bound.repository_id === binding.repository_id &&
          ticket.bound.caller === identity.caller && ticket.bound.run_id !== binding.run_id) {
        return refused(409, "duplicate-run", { duplicate: { run_id: binding.run_id } });
      }
      return poison("binding");
    }
    if (ticket.bound.caller !== identity.caller) return poison("caller");
  }

  if (ticket.generation !== fences.generation) return poison("generation");
  if (ticket.evidence_revision !== null && ticket.evidence_revision !== fences.evidence_revision) {
    return poison("evidence-revision");
  }
  if (ticket.release_attempt !== null && ticket.release_attempt !== fences.release_attempt) {
    return poison("release-attempt");
  }
  if (Date.parse(ticket.expires_at) <= now) return poison("expired");
  const position = ticket.operations.indexOf(operation);
  if (position < 0) return poison("operation");
  if (position > 0 && ticket.mints[ticket.operations[position - 1]] < 1) return poison("progression");
  if (operation === "validate" && !snapshotComplete) return refused(409, "snapshot-incomplete");
  if (ticket.operations[0] === "snapshot" && pipelineCommit !== ticket.admitted.pipeline_commit) {
    return poison("pipeline-commit");
  }

  if (ticket.bound === null) {
    ticket.bound = {
      run_id: binding.run_id,
      run_attempt: binding.run_attempt,
      repository_id: binding.repository_id,
      caller: identity.caller,
    };
  }
  if (ticket.mints[operation] >= MAX_MINTS) return poison("mints");
  ticket.mints[operation] += 1;
  return { ticket, ok: true, operation, mint: ticket.mints[operation] };
}

/** Poison a ticket outright (withdrawal, supersession). */
export function poisonTicket(stored, { reason, now }) {
  const ticket = structuredClone(stored);
  if (!ticket.poisoned) ticket.poisoned = { reason, at: iso(now) };
  return ticket;
}
