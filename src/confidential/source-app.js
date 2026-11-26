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
  const response = await fetch(`${API}/repos/${repositoryName}/installation`, {
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

/**
 * Mint a read-only token for one repository of one installation.
 *
 * `repositoryId` is the contract's form. Intake does not yet know the numeric
 * id when it first mints (only the name the submitter typed), so it may pass
 * `repositoryName` instead; the response must then name exactly one
 * repository with that name, and its id is returned so every later mint uses
 * the id. In both cases anything but exactly one repository and exactly the
 * two read permissions revokes the token and fails.
 */
export async function mintSourceReadToken(env, installationId, { repositoryId = null, repositoryName = null } = {}) {
  if (!Number.isSafeInteger(installationId)) throw new SourceAppError("invalid installation");
  if ((repositoryId === null) === (repositoryName === null)) {
    throw new SourceAppError("name exactly one repository");
  }
  if (repositoryId !== null && !Number.isSafeInteger(repositoryId)) {
    throw new SourceAppError("invalid repository id");
  }
  const scope = repositoryId !== null
    ? { repository_ids: [repositoryId] }
    : { repositories: [String(repositoryName).split("/")[1]] };
  const response = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { ...headers(`Bearer ${await jwt(env)}`), "content-type": "application/json" },
    body: JSON.stringify({ ...scope, permissions: WANTED }),
  });
  if (!response.ok) throw failed(response, "token mint");
  const minted = await response.json();
  const repositories = Array.isArray(minted?.repositories) ? minted.repositories : [];
  const only = repositories.length === 1 ? repositories[0] : null;
  const matches = only !== null && (repositoryId !== null
    ? only.id === repositoryId
    : String(only.full_name ?? "").toLowerCase() === String(repositoryName).toLowerCase());
  if (typeof minted?.token !== "string" || !matches || !exactPermissions(minted.permissions) ||
      minted.repository_selection !== "selected") {
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
    });
  } catch {
    // The token expires within an hour regardless.
  }
}

/** One GET with a source token: the parsed body, null on 404, or an error. */
export async function sourceGet(token, path) {
  const response = await fetch(`${API}${path}`, { headers: headers(`Bearer ${token}`) });
  if (response.status === 404 || response.status === 422) return null;
  if (!response.ok) throw failed(response, "source read");
  return response.json();
}
