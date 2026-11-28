/**
 * The confidential objects in R2 (contract v3.1, C5 and C8; part 11.3).
 *
 * `conf/<id>/lifecycle.json` is the one record of a confidential submission's
 * state, `reviewing`, `held` or `withdrawn`. Only this Worker writes it, and
 * every write is conditional on the ETag it read (or is create-only), so two
 * requests can never both move it. It is never cached: a missing lifecycle
 * reads as withdrawn.
 */

export const LIFECYCLE_SCHEMA = "palomar-confidential-lifecycle/1";
export const TOMBSTONE_SCHEMA = "palomar-confidential-tombstone/1";
export const STATES = new Set(["reviewing", "held", "withdrawn"]);
const ID_RE = /^[0-9a-z]{12}$/;
const ANONYMOUS_RE = /^[0-9a-f]{32}$/;

export const sourceKey = (id) => `conf/${id}/source.tar.gz`;
export const lifecycleKey = (id) => `conf/${id}/lifecycle.json`;
export const certificateKey = (id, kind) => `conf/${id}/certificate-${kind}.json`;
export const anonymousKey = (anonymousId) => `conf-anon/${anonymousId}`;
export const tombstoneKey = (id) => `conf-tombstones/${id}`;
export const isConfidentialId = (value) => typeof value === "string" && ID_RE.test(value);
export const isAnonymousId = (value) => typeof value === "string" && ANONYMOUS_RE.test(value);

/** Another request moved the lifecycle first. */
export class LifecycleConflict extends Error {}

export function newLifecycle({ id, repository, repositoryId, commit, sourceSha256, at }) {
  return {
    schema: LIFECYCLE_SCHEMA,
    id,
    state: "reviewing",
    repository,
    repository_id: repositoryId,
    commit,
    source_sha256: sourceSha256,
    created_at: at,
    held_at: null,
    review_sha256: null,
    anonymous_id: null,
    withdrawn_at: null,
  };
}

function validLifecycle(value, id) {
  return value?.schema === LIFECYCLE_SCHEMA && value.id === id && STATES.has(value.state) &&
    /^[0-9a-f]{64}$/.test(value.source_sha256 ?? "");
}

/**
 * `{ value, etag }`, or null when absent. A malformed object is treated as
 * absent too, which every reader turns into `withdrawn`.
 */
export async function readLifecycle(env, id) {
  if (!isConfidentialId(id)) return null;
  const object = await env.CONFIDENTIAL_SOURCE.get(lifecycleKey(id));
  if (!object) return null;
  let value;
  try {
    value = await object.json();
  } catch {
    return null;
  }
  return validLifecycle(value, id) ? { value, etag: object.etag } : null;
}

const JSON_TYPE = { httpMetadata: { contentType: "application/json" } };

export async function createLifecycle(env, lifecycle) {
  const written = await env.CONFIDENTIAL_SOURCE.put(
    lifecycleKey(lifecycle.id), JSON.stringify(lifecycle),
    { ...JSON_TYPE, onlyIf: { etagDoesNotMatch: "*" } },
  );
  if (!written) throw new LifecycleConflict(`${lifecycle.id}: lifecycle already exists`);
  return { value: lifecycle, etag: written.etag };
}

/** Write `next` only if the object still has the ETag `current` was read at. */
export async function replaceLifecycle(env, current, next) {
  const written = await env.CONFIDENTIAL_SOURCE.put(
    lifecycleKey(next.id), JSON.stringify(next),
    { ...JSON_TYPE, onlyIf: { etagMatches: current.etag } },
  );
  if (!written) throw new LifecycleConflict(`${next.id}: lifecycle changed`);
  return { value: next, etag: written.etag };
}

/** Create-only; returns the object that is there afterwards, either way. */
export async function putOnce(env, key, text) {
  const written = await env.CONFIDENTIAL_SOURCE.put(
    key, text, { ...JSON_TYPE, onlyIf: { etagDoesNotMatch: "*" } },
  );
  if (written) return text;
  const existing = await env.CONFIDENTIAL_SOURCE.get(key);
  return existing ? existing.text() : null;
}

export async function readJson(env, key) {
  const object = await env.CONFIDENTIAL_SOURCE.get(key);
  if (!object) return null;
  try {
    return await object.json();
  } catch {
    return null;
  }
}

/** Write the tombstone if there is none; an existing one is kept as it is. */
export async function ensureTombstone(env, id, at) {
  await putOnce(env, tombstoneKey(id), JSON.stringify({
    schema: TOMBSTONE_SCHEMA, id, withdrawn_at: at, cleanup: "pending",
  }));
}

/** Ids of every tombstone whose cleanup is not yet done. */
export async function pendingTombstones(env) {
  const pending = [];
  let cursor;
  do {
    const page = await env.CONFIDENTIAL_SOURCE.list({ prefix: "conf-tombstones/", cursor });
    for (const object of page.objects) {
      const id = object.key.slice("conf-tombstones/".length);
      if (!isConfidentialId(id)) continue;
      const value = await readJson(env, object.key);
      if (value?.cleanup !== "done") pending.push(id);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return pending;
}

/** Ids of every confidential submission that still has a lifecycle. */
export async function confidentialIds(env) {
  const ids = [];
  let cursor;
  do {
    const page = await env.CONFIDENTIAL_SOURCE.list({ prefix: "conf/", delimiter: "/", cursor });
    for (const prefix of page.delimitedPrefixes ?? []) {
      const id = prefix.slice("conf/".length, -1);
      if (isConfidentialId(id)) ids.push(id);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return ids;
}

export function confidentialStoreConfigured(env) {
  return Boolean(env.CONFIDENTIAL_SOURCE && env.CONFIDENTIAL_R2_ACCESS_KEY_ID &&
    env.CONFIDENTIAL_R2_SECRET_ACCESS_KEY && env.CONFIDENTIAL_R2_ACCOUNT_ID);
}

const BUCKET = "palomar-confidential-source";

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(key, text) {
  const imported = await crypto.subtle.importKey(
    "raw", typeof key === "string" ? new TextEncoder().encode(key) : key,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(text));
}

const encodeKey = (key) => key.split("/").map(encodeURIComponent).join("/");

/**
 * A presigned GET for one object (S3 SigV4 query signing, part 11.4).
 *
 * Signed with the Worker's read-only R2 token, which itself never leaves the
 * Worker; the URL grants one read of one key until it expires.
 */
export function presignGet(env, key, seconds, now = Date.now()) {
  return sigv4PresignGet({
    host: `${env.CONFIDENTIAL_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    path: `/${BUCKET}/${encodeKey(key)}`,
    region: "auto",
    accessKeyId: env.CONFIDENTIAL_R2_ACCESS_KEY_ID,
    secretAccessKey: env.CONFIDENTIAL_R2_SECRET_ACCESS_KEY,
    seconds,
    now,
  });
}

export async function sigv4PresignGet({ host, path, region, accessKeyId, secretAccessKey, seconds, now }) {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const day = stamp.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const query = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${accessKeyId}/${scope}`,
    "X-Amz-Date": stamp,
    "X-Amz-Expires": String(seconds),
    "X-Amz-SignedHeaders": "host",
  });
  query.sort();
  const canonicalQuery = query.toString().replace(/\+/g, "%20");
  const canonical = ["GET", path, canonicalQuery, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = [
    "AWS4-HMAC-SHA256", stamp, scope,
    hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))),
  ].join("\n");
  let signingKey = await hmac(`AWS4${secretAccessKey}`, day);
  for (const part of [region, "s3", "aws4_request"]) signingKey = await hmac(signingKey, part);
  const signature = hex(await hmac(signingKey, toSign));
  return `https://${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
