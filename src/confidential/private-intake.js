/**
 * Authorization of a private repository for a confidential submission
 * (contract v2 section 3.1).
 *
 * Called only after the principal's identity is established (a finished
 * OAuth sign-in, or later the agent gist proof). Every way this can fail
 * that depends on the repository (no installation, no such repository, a
 * public repository on this route, no write permission, a missing or wrong
 * tag, an unknown commit) gives one identical answer, so the route is no
 * oracle on another account's private repositories. Only a GitHub outage is
 * told apart, as "temporarily unavailable", and it is not counted.
 *
 * Only the submitted repository is ever read with the Source App, and the
 * token is revoked before this returns.
 */

import { readState, writeState } from "../github.js";
import { digest, pepper } from "../submission.js";
import {
  mintSourceReadToken,
  revokeSourceToken,
  SourceAppError,
  sourceGet,
  sourceInstallationId,
} from "./source-app.js";

export const NOT_AUTHORIZED = Object.freeze({
  error: "not-authorized",
  detail: "Palomar could not confirm that you may submit this repository confidentially. " +
    "Check that the Palomar Source app is installed on it and that your account has write access.",
});

export const MAX_FAILURES_PER_HOUR = 10;
const HOUR_MS = 60 * 60_000;
const WRITE_ROLES = new Set(["admin", "maintain", "write"]);

async function failurePath(env, principalId) {
  return `index/confidential-authorization/${await digest(`${pepper(env)}:${principalId}`)}.json`;
}

function recent(value, now) {
  const failures = Array.isArray(value?.failures) ? value.failures : [];
  return failures.filter((at) => {
    const time = Date.parse(at);
    return Number.isFinite(time) && now - time < HOUR_MS;
  });
}

/** Has this principal used up its failed authorizations for the hour? */
export async function authorizationExhausted(env, principalId, now = Date.now()) {
  const stored = await readState(env, await failurePath(env, principalId));
  return recent(stored.value, now).length >= MAX_FAILURES_PER_HOUR;
}

async function recordFailure(env, principalId, now) {
  const path = await failurePath(env, principalId);
  const stored = await readState(env, path);
  const failures = [...recent(stored.value, now),
    new Date(now).toISOString().replace(/\.\d+Z$/, "Z")];
  await writeState(env, path, { schema_version: 1, failures }, "Record a refused authorization",
    stored.sha);
}

/**
 * Establish that `principal` may submit `repositoryName` confidentially.
 *
 * Answers `{ok: true, repository: {id, full_name, owner_id}, installation_id}`
 * or `{ok: false, transient}`; with `transient` false the caller answers
 * `NOT_AUTHORIZED` and the failure has been counted.
 *
 * `challenge`, when given, requires the agent proof tag
 * `refs/tags/c-<challenge>` to be a lightweight tag at `commit`.
 */
export async function authorizePrivateRepository(env, { repositoryName, principal, commit, challenge = null,
  now = Date.now() }) {
  let token = null;
  let outcome;
  try {
    outcome = await check();
  } catch (error) {
    outcome = error instanceof SourceAppError && error.transient
      ? { ok: false, transient: true }
      : error instanceof SourceAppError ? { ok: false, transient: false } : null;
    if (outcome === null) throw error;
  } finally {
    if (token) await revokeSourceToken(token);
  }
  if (!outcome.ok && !outcome.transient) await recordFailure(env, principal.id, now);
  return outcome;

  async function check() {
    const no = { ok: false, transient: false };
    if (!Number.isSafeInteger(principal?.id) || typeof principal?.login !== "string") return no;
    const installationId = await sourceInstallationId(env, repositoryName);
    if (installationId === null) return no;
    const minted = await mintSourceReadToken(env, installationId, { repositoryName });
    token = minted.token;
    const repo = await sourceGet(token, `/repos/${repositoryName}`);
    if (!repo || repo.id !== minted.repository_id || repo.private !== true) return no;
    const permission = await sourceGet(
      token, `/repos/${repositoryName}/collaborators/${encodeURIComponent(principal.login)}/permission`,
    );
    const role = permission?.role_name ?? permission?.permission;
    if (!WRITE_ROLES.has(role) || (permission?.user?.id !== undefined && permission.user.id !== principal.id)) {
      return no;
    }
    if (challenge !== null) {
      const ref = await sourceGet(token, `/repos/${repositoryName}/git/ref/tags/c-${challenge}`);
      if (ref?.object?.type !== "commit" || ref.object.sha !== commit) return no;
    }
    const resolved = await sourceGet(token, `/repos/${repositoryName}/commits/${commit}`);
    if (resolved?.sha !== commit) return no;
    return {
      ok: true,
      installation_id: installationId,
      repository: { id: repo.id, full_name: repo.full_name, owner_id: repo.owner?.id ?? null },
    };
  }
}
