/**
 * The read-only Palomar Source GitHub App (contract v2 sections 3.1 and 3.2).
 *
 * Deliberately separate from `github-app.js`, whose tokens are cached and
 * installation-wide. A source token here is minted for exactly one
 * repository, with exactly Contents: read and Metadata: read, checked in
 * GitHub's own response; it is never cached and never widened, and the caller
 * revokes it as soon as it is done.
 */

import { appJwt } from "../github-app.js";

const API = "https://api.github.com";
const WANTED = { contents: "read", metadata: "read" };
// Every Source App request is bounded, so a refusal's timing is set by the
// caller's response floor rather than by how far the checks got.
const SOURCE_TIMEOUT_MS = 1_200;

/** A bounded fetch whose timeout or network failure is a transient error. */
async function sourceFetch(url, init = {}) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) });
  } catch {
    throw new SourceAppError("GitHub did not answer", { transient: true });
  }
}

export class SourceAppError extends Error {
  constructor(message, { transient = false } = {}) {
    super(message);
    this.transient = transient;
  }
}

function sourceConfigured(env) {
  return Boolean(env.SOURCE_APP_ID && env.SOURCE_APP_PRIVATE_KEY);
}

function headers(authorization) {
  return {
    authorization,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "palomar-server",
  };
}

async function jwt(env, now = Date.now()) {
  if (!sourceConfigured(env)) throw new SourceAppError("the Source App is not configured");
  return appJwt(env.SOURCE_APP_ID, env.SOURCE_APP_PRIVATE_KEY, now);
}

function failed(response, what) {
  return new SourceAppError(`${what}: ${response.status}`, { transient: response.status >= 500 });
}

/** The Source App installation on one repository, or null when there is none. */
export async function sourceInstallationId(env, repositoryName) {
  const response = await sourceFetch(`${API}/repos/${repositoryName}/installation`, {
    headers: headers(`Bearer ${await jwt(env)}`),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw failed(response, "installation lookup");
  const id = (await response.json())?.id;
  return Number.isSafeInteger(id) ? id : null;
}

function exactPermissions(permissions) {
  const keys = Object.keys(permissions ?? {}).sort();
  return keys.length === 2 && keys[0] === "contents" && keys[1] === "metadata" &&
    permissions.contents === "read" && permissions.metadata === "read";
}

function scopedTo(minted, permissionsOk, matches) {
  const repositories = Array.isArray(minted?.repositories) ? minted.repositories : [];
  const only = repositories.length === 1 ? repositories[0] : null;
  return typeof minted?.token === "string" && only !== null && matches(only) &&
    permissionsOk(minted.permissions) && minted.repository_selection === "selected" ? only : null;
}

async function mint(env, installationId, body) {
  const response = await sourceFetch(`${API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { ...headers(`Bearer ${await jwt(env)}`), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw failed(response, "token mint");
  return response.json();
}

/**
 * The numeric id of the repository a submitter named, before any content can
 * be read.
 *
 * Intake knows only the name. The numeric id is learnt from a token that can
 * read nothing but metadata, scoped to that one name, checked to name exactly
 * that one repository, and revoked at once; every content token is then
 * minted by id (`mintSourceReadToken`). The alternative, listing the
 * installation's repositories, would need an installation-wide token.
 */
export async function resolveRepositoryId(env, installationId, repositoryName) {
  if (!Number.isSafeInteger(installationId)) throw new SourceAppError("invalid installation");
  const name = String(repositoryName).split("/")[1];
  const minted = await mint(env, installationId, { repositories: [name], permissions: { metadata: "read" } });
  const only = scopedTo(minted,
    (permissions) => Object.keys(permissions ?? {}).length === 1 && permissions.metadata === "read",
    (repository) => String(repository.full_name ?? "").toLowerCase() === String(repositoryName).toLowerCase());
  if (typeof minted?.token === "string") await revokeSourceToken(minted.token);
  if (!only || !Number.isSafeInteger(only.id)) {
    throw new SourceAppError("the metadata token was not exactly the one requested");
  }
  return only.id;
}

/**
 * Mint a read-only token for exactly one repository, by numeric id, with
 * exactly Contents: read and Metadata: read. Anything else in GitHub's answer
 * revokes the token and fails. Never cached, never installation-wide.
 */
export async function mintSourceReadToken(env, installationId, repositoryId) {
  if (!Number.isSafeInteger(installationId)) throw new SourceAppError("invalid installation");
  if (!Number.isSafeInteger(repositoryId)) throw new SourceAppError("invalid repository id");
  const minted = await mint(env, installationId, { repository_ids: [repositoryId], permissions: WANTED });
  const only = scopedTo(minted, exactPermissions, (repository) => repository.id === repositoryId);
  if (!only) {
    if (typeof minted?.token === "string") await revokeSourceToken(minted.token);
    throw new SourceAppError("the minted token was not exactly the one requested");
  }
  return {
    token: minted.token,
    expires_at: minted.expires_at ?? null,
    repository_id: only.id,
    full_name: only.full_name,
  };
}

/** Revoke a source token. Never throws: revocation is best effort and repeated later. */
export async function revokeSourceToken(token) {
  try {
    await fetch(`${API}/installation/token`, {
      method: "DELETE",
      headers: headers(`Bearer ${token}`),
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    });
  } catch {
    // The token expires within an hour regardless.
  }
}

/** One GET with a source token: the parsed body, null on 404, or an error. */
export async function sourceGet(token, path) {
  const response = await sourceFetch(`${API}${path}`, { headers: headers(`Bearer ${token}`) });
  if (response.status === 404 || response.status === 422) return null;
  if (!response.ok) throw failed(response, "source read");
  return response.json();
}
