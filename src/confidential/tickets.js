/**
 * Ticket rules (contract v2 section 3.2), as pure functions over one ticket.
 *
 * A ticket is issued with a dispatch that needs one and is presented by a run
 * whose JWT has already been validated (`oidc.js`), so an invalid JWT never
 * reaches these functions and can never poison a ticket.
 *
 * Operation progression. A `snapshot` ticket is presented first by the
 * snapshot job and then, in the same run, by the validation job under the
 * operation `validate`. The two have separate retry budgets of three mints
 * each, so legitimate snapshot retries cannot exhaust validation, and a
 * repeated `validate` presentation by the same binding mints a fresh
 * validation capability (revoking the previous one) instead of failing, which
 * is what recovers a lost response. Every other ticket operation (`restore`,
 * `evidence`, `publish`) has one budget of three mints. Contract v2.1 is to
 * settle these budgets (review finding 8 of the final v2 review); this module
 * is the one place to change them.
 */

export const TICKET_OPERATIONS = Object.freeze(["snapshot", "restore", "evidence", "publish"]);
export const TICKET_LIFETIME_MS = 6 * 60 * 60_000;
export const MAX_MINTS = 3;

function iso(now) {
  return new Date(now).toISOString().replace(/\.\d+Z$/, "Z");
}

/** A new ticket record. `ticketHash` is the `ticket`-kind digest of the plaintext. */
export function issueTicket({ ticketHash, operation, submissionId, generation, nonce, admitted, now,
  snapshotSha256 = null }) {
  if (!TICKET_OPERATIONS.includes(operation)) throw new TypeError("unknown ticket operation");
  if (!/^[0-9a-f]{64}$/.test(String(ticketHash))) throw new TypeError("invalid ticket hash");
  return {
    ticket_hash: ticketHash,
    operation,
    submission_id: submissionId,
    generation,
    nonce,
    admitted: admitted ?? null,
    snapshot_sha256: snapshotSha256,
    issued_at: iso(now),
    expires_at: iso(now + TICKET_LIFETIME_MS),
    bound: null,
    mints: { [operation]: 0, ...(operation === "snapshot" ? { validate: 0 } : {}) },
    poisoned: null,
  };
}

/**
 * Present a ticket. Answers `{ticket, ok: true, operation, mint}` or
 * `{ticket, ok: false, status, error, poisoned, duplicate}`; the returned
 * ticket is always the one to store, because a refusal may poison it.
 *
 * - `binding` is `{run_id, run_attempt, repository_id}` from the JWT.
 * - `identity` is `{repository_id, workflow}`: the matched row's repository
 *   and the called workflow path without its pin.
 * - `generation` is the actor's current fencing generation.
 */
export function presentTicket(stored, { operation, binding, identity, generation, now }) {
  const ticket = structuredClone(stored);
  const refused = (status, error, extra = {}) => ({ ticket, ok: false, status, error, ...extra });
  const poison = (reason) => {
    if (!ticket.poisoned) ticket.poisoned = { reason, at: iso(now) };
    return refused(409, "ticket-refused", { poisoned: true });
  };
  if (ticket.poisoned) return refused(409, "ticket-refused");
  if (ticket.generation !== generation) return poison("generation");
  if (Date.parse(ticket.expires_at) <= now) return poison("expired");
  const validate = operation === "validate";
  if (operation !== ticket.operation && !(validate && ticket.operation === "snapshot")) {
    return poison("operation");
  }
  if (ticket.bound === null) {
    // The validation job is always second: before a snapshot has bound the
    // ticket there is nothing for it to validate.
    if (validate) return poison("validate-before-snapshot");
    ticket.bound = {
      run_id: binding.run_id,
      run_attempt: binding.run_attempt,
      repository_id: binding.repository_id,
      workflow: identity.workflow,
    };
  } else {
    const sameRun = ticket.bound.run_id === binding.run_id &&
      ticket.bound.run_attempt === binding.run_attempt &&
      ticket.bound.repository_id === binding.repository_id;
    if (!sameRun) {
      // The election rule: the first run to present a ticket keeps it. A run
      // with the same repository and workflow identity but another run id is
      // an outbox retry that dispatched twice; it is refused without
      // poisoning, so the elected run carries on. Anything else is misuse.
      if (!validate && ticket.bound.repository_id === binding.repository_id &&
          ticket.bound.workflow === identity.workflow && ticket.bound.run_id !== binding.run_id) {
        return refused(409, "duplicate-run", { duplicate: { run_id: binding.run_id } });
      }
      return poison("binding");
    }
    if (!validate && ticket.bound.workflow !== identity.workflow) return poison("identity");
  }
  const budget = validate ? "validate" : ticket.operation;
  if (ticket.mints[budget] >= MAX_MINTS) return poison("mints");
  ticket.mints[budget] += 1;
  return { ticket, ok: true, operation: validate ? "validate" : ticket.operation, mint: ticket.mints[budget] };
}

/** Poison a ticket outright (withdrawal, supersession). */
export function poisonTicket(stored, { reason, now }) {
  const ticket = structuredClone(stored);
  if (!ticket.poisoned) ticket.poisoned = { reason, at: iso(now) };
  return ticket;
}
