/**
 * Authorization of a private repository for a confidential submission
 * (contract v2 section 3.1).
 *
 * Called only after the principal's identity is established (a finished
 * OAuth sign-in, or later the agent gist proof). Every way this can fail
 * that depends on the repository (no installation, no such repository, a
 * public repository on this route, no write permission, a missing or wrong
 * tag, an unknown commit) gives one identical answer, and every answer other
 * than success is released no earlier than a fixed floor after the attempt
 * began, so neither the body nor the timing is an oracle on another account's
 * private repositories. Only a GitHub outage is told apart, as "temporarily
 * unavailable", and it is not counted.
 *
 * Each attempt reserves one of the principal's ten hourly attempts before it
 * touches the repository, with a conditional State write, so concurrent
 * attempts cannot all pass a check made before any of them is counted. A
 * success or an outage gives the reservation back.
 *
 * Only the submitted repository is ever read with the Source App, and every
 * token is revoked before this returns.
 */

import { GitHubError, readState, writeState } from "../github.js";
import { digest, pepper } from "../submission.js";
import {
  mintSourceReadToken,
  resolveRepositoryId,
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
// The base permission GitHub reports: maintain reads as write, and a custom
// role reports its base. Admin or write may submit.
const WRITE_PERMISSIONS = new Set(["admin", "write"]);

// Longer than the slowest refusal path (six bounded requests and the
// accounting write), so every refusal is released at the same moment.
let floorMs = 9_000;

/** For tests only: shorten the response floor. */
export function setAuthorizationFloorForTests(ms) {
  floorMs = ms;
}

function iso(now) {
  return new Date(now).toISOString().replace(/\.\d+Z$/, "Z");
}

async function attemptsPath(env, principalId) {
  return `index/confidential-authorization/${await digest(`${pepper(env)}:${principalId}`)}.json`;
}

function recent(value, now) {
  const attempts = Array.isArray(value?.attempts) ? value.attempts : [];
  return attempts.filter((item) => {
    const time = Date.parse(item?.at);
    return typeof item?.id === "string" && Number.isFinite(time) && now - time < HOUR_MS;
  });
}

/** Has this principal used up its attempts for the hour? */
export async function authorizationExhausted(env, principalId, now = Date.now()) {
  const stored = await readState(env, await attemptsPath(env, principalId));
  return recent(stored.value, now).length >= MAX_FAILURES_PER_HOUR;
}

/**
 * Reserve one attempt: `{reserved: id}`, `{exhausted: true}` or `{busy: true}`
 * when another attempt by the same principal changed the file first.
 */
async function reserve(env, principalId, now) {
  const path = await attemptsPath(env, principalId);
  const stored = await readState(env, path);
  const attempts = recent(stored.value, now);
  if (attempts.length >= MAX_FAILURES_PER_HOUR) return { exhausted: true };
  const id = crypto.randomUUID();
  try {
    await writeState(env, path, { schema_version: 1, attempts: [...attempts, { id, at: iso(now) }] },
      "Reserve an authorization attempt", stored.sha);
  } catch (error) {
    if (error instanceof GitHubError && [409, 422].includes(error.status)) return { busy: true };
    throw error;
  }
  return { reserved: id };
}

/** Give a reservation back after a success or an outage. Best effort. */
async function giveBack(env, principalId, id, now) {
  try {
    const path = await attemptsPath(env, principalId);
    const stored = await readState(env, path);
    const attempts = recent(stored.value, now).filter((item) => item.id !== id);
    await writeState(env, path, { schema_version: 1, attempts }, "Return an authorization attempt",
      stored.sha);
  } catch (error) {
    console.error("confidential-authorization", "could not return a reservation",
      String(error?.message ?? error));
  }
}

function sleepUntil(deadline) {
  const wait = deadline - Date.now();
  return wait > 0 ? new Promise((resolve) => setTimeout(resolve, wait)) : Promise.resolve();
}

/**
 * Establish that `principal` may submit `repositoryName` confidentially.
 *
 * Answers `{ok: true, repository: {id, full_name, owner_id}, installation_id}`,
 * `{ok: false, transient: false}` (answer `NOT_AUTHORIZED`; the attempt stays
 * counted), `{ok: false, transient: true}` (an outage), `{ok: false,
 * exhausted: true}` or `{ok: false, busy: true}`.
 *
 * `challenge`, when given, requires the agent proof tag
 * `refs/tags/c-<challenge>` to be a lightweight tag at `commit`.
 */
export async function authorizePrivateRepository(env, { repositoryName, principal, commit, challenge = null,
  now = Date.now() }) {
  const started = Date.now();
  const deadline = started + floorMs;
  if (!Number.isSafeInteger(principal?.id) || typeof principal?.login !== "string") {
    await sleepUntil(deadline);
    return { ok: false, transient: false };
  }
  const reservation = await reserve(env, principal.id, now);
  if (!reservation.reserved) {
    await sleepUntil(deadline);
    return { ok: false, ...reservation };
  }
  const tokens = [];
  let outcome;
  try {
    outcome = await check();
  } catch (error) {
    if (!(error instanceof SourceAppError)) throw error;
    outcome = { ok: false, transient: error.transient };
  } finally {
    await Promise.all(tokens.map(revokeSourceToken));
  }
  if (outcome.ok || outcome.transient) await giveBack(env, principal.id, reservation.reserved, now);
  if (!outcome.ok) await sleepUntil(deadline);
  return outcome;

  async function check() {
    const no = { ok: false, transient: false };
    const installationId = await sourceInstallationId(env, repositoryName);
    if (installationId === null) return no;
    let repositoryId;
    try {
      repositoryId = await resolveRepositoryId(env, installationId, repositoryName);
    } catch (error) {
      if (error instanceof SourceAppError && !error.transient) return no;
      throw error;
    }
    const minted = await mintSourceReadToken(env, installationId, repositoryId);
    tokens.push(minted.token);
    const token = minted.token;
    const repo = await sourceGet(token, `/repos/${repositoryName}`);
    if (!repo || repo.id !== repositoryId || repo.private !== true ||
        String(repo.full_name ?? "").toLowerCase() !== String(repositoryName).toLowerCase()) {
      return no;
    }
    const permission = await sourceGet(
      token, `/repos/${repositoryName}/collaborators/${encodeURIComponent(principal.login)}/permission`,
    );
    if (!WRITE_PERMISSIONS.has(permission?.permission) || permission?.user?.id !== principal.id) {
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
