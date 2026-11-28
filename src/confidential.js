/**
 * Confidential submissions after intake (contract v3.1, C2 and C5 to C8).
 *
 * Every step is idempotent or a single compare-and-set on the lifecycle, so a
 * request or scheduled pass that dies part-way is finished by the next one.
 */

import { readState, repository as fetchRepository } from "./github.js";
import { isCurrentReview } from "./state-contract.js";
import { recordedAt, statePath } from "./submission.js";
import {
  fetchPlainSource,
  SourceRefusal,
  SourceUnavailable,
  sourceAppConfigured,
  sourceRepository,
  sourceRepositoryAccess,
  withSourceToken,
} from "./confidential-source.js";
import {
  anonymousKey,
  certificateKey,
  confidentialIds,
  createLifecycle,
  ensureTombstone,
  isAnonymousId,
  isConfidentialId,
  LifecycleConflict,
  newLifecycle,
  pendingTombstones,
  presignGet,
  putOnce,
  readJson,
  readLifecycle,
  replaceLifecycle,
  sourceKey,
  tombstoneKey,
} from "./confidential-store.js";
import {
  certificateEvidence,
  certificateKeyConfigured,
  certificatePayloads,
  signCertificate,
  signingKey,
} from "./certificates.js";
import { readTarGz } from "./tar.js";

export { SourceRefusal, SourceUnavailable };

const API = "https://api.github.com";
// 24 hours rather than the contract's one, because Namespace runs can queue
// that long before they download it.
export const SOURCE_URL_SECONDS = 24 * 60 * 60;
// SigV4's maximum, so it outlives the longest job profile (1,440 minutes) plus
// queueing; it reveals only whether a tombstone exists.
export const TOMBSTONE_URL_SECONDS = 7 * 24 * 60 * 60;
const CLEANUP_WORKFLOW = "confidential-cleanup.yml";

/**
 * The repository as an authenticated principal may act on it, at intake.
 *
 * A public repository is read with the principal's own scopeless OAuth token,
 * exactly as for public intake. A repository that token cannot see is read
 * through the Source App, and the principal's permission on it comes from
 * GitHub's collaborator permission for the same numeric account. Null when
 * neither can read it.
 */
export async function confidentialViewer(env, repository, principal, userToken) {
  const visible = await fetchRepository(userToken, repository);
  if (visible && visible.private !== true) return visible;
  if (!sourceAppConfigured(env)) return null;
  const access = await withSourceToken(env, repository, (token) =>
    sourceRepositoryAccess(token, repository, principal));
  if (!access) return null;
  return {
    id: access.repo.id,
    private: access.repo.private === true,
    owner: access.repo.owner,
    permissions: {
      push: ["admin", "write"].includes(access.permission),
      admin: access.permission === "admin",
    },
  };
}

/**
 * C2: read the commit once, check it is a plain Git tree, and store its
 * tarball and a `reviewing` lifecycle. Throws SourceRefusal (the submitter's
 * to fix) or SourceUnavailable (retry). Safe to repeat for the same id.
 */
export async function captureSource(env, { id, repository, commit, repositoryId }) {
  const existing = await readLifecycle(env, id);
  if (existing) return existing.value.source_sha256;
  const publicRepo = await fetchRepository(env.GITHUB_TOKEN, repository).catch(() => null);
  let source;
  if (publicRepo && publicRepo.private !== true) {
    if (publicRepo.id !== repositoryId) throw new SourceRefusal("That repository changed during sign-in.");
    source = await fetchPlainSource(null, repository, commit);
  } else {
    source = await withSourceToken(env, repository, async (token) => {
      const repo = await sourceRepository(token, repository);
      if (repo?.id !== repositoryId) {
        throw new SourceRefusal("That repository changed during sign-in.");
      }
      return fetchPlainSource(token, repository, commit);
    });
    if (!source) {
      throw new SourceRefusal(
        "Install the Palomar Source GitHub App (read-only) on that repository, then submit again.",
      );
    }
  }
  await env.CONFIDENTIAL_SOURCE.put(sourceKey(id), source.bytes, {
    sha256: source.sha256,
    httpMetadata: { contentType: "application/gzip" },
  });
  await createLifecycle(env, newLifecycle({
    id, repository, repositoryId, commit, sourceSha256: source.sha256, at: recordedAt(),
  })).catch((error) => {
    if (!(error instanceof LifecycleConflict)) throw error;
  });
  return source.sha256;
}

/** Remove what captureSource wrote for an id that was never admitted. */
export async function discardSource(env, id) {
  await env.CONFIDENTIAL_SOURCE.delete([sourceKey(id), `conf/${id}/lifecycle.json`]);
}

/** The three inputs every confidential job receives (part 11.4). */
export async function confidentialRunInputs(env, record) {
  const sha = record.confidential?.source_sha256;
  if (!/^[0-9a-f]{64}$/.test(sha ?? "")) throw new Error(`${record.id}: no confidential source digest`);
  return {
    source_url: await presignGet(env, sourceKey(record.id), SOURCE_URL_SECONDS),
    source_sha256: sha,
    tombstone_url: await presignGet(env, tombstoneKey(record.id), TOMBSTONE_URL_SECONDS),
  };
}

/** Part 11.2: what "review passed" means for a confidential State record. */
async function reviewPassed(env, record) {
  if (record?.visibility !== "confidential" || record.status !== "review-ready" ||
      !/^[0-9a-f]{64}$/.test(record.review_sha256 ?? "")) return false;
  const review = await readState(env, statePath(record.id, "review.json"));
  return isCurrentReview(review.value, record.id) && review.value.outcome === "neutral";
}

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Make the certificate pair, once. Both documents are create-only, so a retry
 * after a crash reads back the pair that was made rather than making another.
 */
async function ensureCertificates(env, lifecycle, record, origin) {
  const existing = await readJson(env, certificateKey(lifecycle.id, "anonymous"));
  let anonymousId = existing ? JSON.parse(existing.payload).certificate_id : null;
  if (!existing || !(await env.CONFIDENTIAL_SOURCE.head(certificateKey(lifecycle.id, "full")))) {
    const tarball = await env.CONFIDENTIAL_SOURCE.get(sourceKey(lifecycle.id));
    if (!tarball) throw new Error(`${lifecycle.id}: source tarball is missing`);
    const evidence = certificateEvidence(
      await readTarGz(new Uint8Array(await tarball.arrayBuffer())), record.requested_paths,
    );
    anonymousId ??= randomHex(16);
    const signer = await signingKey(env.CERTIFICATE_SIGNING_KEY);
    const payloads = await certificatePayloads({
      lifecycle, evidence, anonymousId, issuedOn: recordedAt().slice(0, 10), origin,
    });
    const anonymous = await putOnce(env, certificateKey(lifecycle.id, "anonymous"),
      JSON.stringify(await signCertificate(signer, payloads.anonymous)));
    anonymousId = JSON.parse(JSON.parse(anonymous).payload).certificate_id;
    await putOnce(env, certificateKey(lifecycle.id, "full"),
      JSON.stringify(await signCertificate(signer, payloads.full)));
  }
  await putOnce(env, anonymousKey(anonymousId), JSON.stringify({ id: lifecycle.id }));
  return anonymousId;
}

/**
 * C5 `reviewing` to `held`, when the review has passed. Returns the lifecycle
 * as it now stands (null when there is none).
 */
export async function promoteHeld(env, id, origin, { record = null } = {}) {
  const current = await readLifecycle(env, id);
  if (!current || current.value.state !== "reviewing") return current?.value ?? null;
  if (!certificateKeyConfigured(env)) return current.value;
  if (await env.CONFIDENTIAL_SOURCE.head(tombstoneKey(id))) return current.value;
  const state = record ?? (await readState(env, statePath(id, "state.json"))).value;
  if (!(await reviewPassed(env, state))) return current.value;
  const anonymousId = await ensureCertificates(env, current.value, state, origin);
  try {
    return (await replaceLifecycle(env, current, {
      ...current.value,
      state: "held",
      held_at: recordedAt(),
      review_sha256: state.review_sha256,
      anonymous_id: anonymousId,
    })).value;
  } catch (error) {
    if (!(error instanceof LifecycleConflict)) throw error;
    const now = (await readLifecycle(env, id))?.value ?? null;
    // Withdrawn while the certificates were being made: take back the
    // mapping this request just wrote.
    if (now?.state !== "held") await dropAnonymousMapping(env, id, now);
    return now;
  }
}

/** `valid` only while held; everything else, including unknown, is `withdrawn`. */
export async function certificateStatus(env, presented) {
  let id = presented;
  if (isAnonymousId(presented)) {
    id = (await readJson(env, anonymousKey(presented)))?.id ?? null;
  } else if (!isConfidentialId(presented)) {
    return "withdrawn";
  }
  const lifecycle = id ? await readLifecycle(env, id) : null;
  if (lifecycle?.value.state !== "held") return "withdrawn";
  if (isAnonymousId(presented) && lifecycle.value.anonymous_id !== presented) return "withdrawn";
  return "valid";
}

export async function certificatePair(env, id) {
  const lifecycle = await readLifecycle(env, id);
  if (lifecycle?.value.state !== "held") return null;
  const [full, anonymous] = await Promise.all([
    readJson(env, certificateKey(id, "full")),
    readJson(env, certificateKey(id, "anonymous")),
  ]);
  return full && anonymous ? { full, anonymous } : null;
}

/**
 * The Server's own idempotent withdrawal steps after the tombstone: drop the
 * anonymous mapping, then move C5 to `withdrawn`. A missing lifecycle is
 * already as withdrawn as it can be.
 */
export async function finishWithdrawal(env, id) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await readLifecycle(env, id);
    if (!current) return;
    await dropAnonymousMapping(env, id, current.value);
    if (current.value.state === "withdrawn") return;
    try {
      await replaceLifecycle(env, current, {
        ...current.value, state: "withdrawn", withdrawn_at: recordedAt(),
      });
      return;
    } catch (error) {
      if (!(error instanceof LifecycleConflict)) throw error;
    }
  }
  throw new LifecycleConflict(`${id}: lifecycle kept changing during withdrawal`);
}

/**
 * Delete `conf-anon/<anonymous_id>`, finding the id in the lifecycle or, if a
 * hold was interrupted by the withdrawal, in the anonymous certificate.
 */
async function dropAnonymousMapping(env, id, lifecycle) {
  const anonymous = await readJson(env, certificateKey(id, "anonymous"));
  let fromCertificate = null;
  try {
    fromCertificate = anonymous ? JSON.parse(anonymous.payload).certificate_id : null;
  } catch {
    // A damaged certificate names nothing to delete.
  }
  for (const anonymousId of new Set([lifecycle?.anonymous_id, fromCertificate])) {
    if (isAnonymousId(anonymousId)) await env.CONFIDENTIAL_SOURCE.delete(anonymousKey(anonymousId));
  }
}

/** C8, the Server half: tombstone first, then C5. */
export async function withdrawConfidential(env, id) {
  await ensureTombstone(env, id, recordedAt());
  await finishWithdrawal(env, id);
}

/** Part 11.5. Without an id, the job processes every pending tombstone. */
export async function dispatchCleanup(env, id = null) {
  const response = await fetch(
    `${API}/repos/${env.STATE_REPO}/actions/workflows/${CLEANUP_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "palomar-server",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ref: "main", ...(id ? { inputs: { submission: id } } : {}) }),
    },
  );
  if (!response.ok) console.warn("confidential cleanup dispatch rejected", response.status);
  return response.ok;
}

/**
 * The daily pass: finish the Server's withdrawal steps for every tombstone
 * still pending and dispatch cleanup once if there is any, then hold every
 * reviewing submission whose review has passed.
 */
export async function dailyConfidentialPass(env, origin) {
  const pending = await pendingTombstones(env);
  for (const id of pending) {
    try {
      await finishWithdrawal(env, id);
    } catch (error) {
      console.error("confidential-withdrawal", id, String(error?.message ?? error));
    }
  }
  if (pending.length) await dispatchCleanup(env);
  for (const id of await confidentialIds(env)) {
    if (pending.includes(id)) continue;
    try {
      await promoteHeld(env, id, origin);
    } catch (error) {
      console.error("confidential-hold", id, String(error?.message ?? error));
    }
  }
  return { pending };
}

/**
 * The public submission's id for a confidential one: derived from the
 * confidential id with the pepper, so a second press finds the first one's
 * submission and nothing public names the confidential id.
 */
export async function publicSubmissionId(env, id) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(String(env.TOKEN_PEPPER)), { name: "HMAC", hash: "SHA-256" },
    false, ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(`confidential-public:${id}`),
  ));
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  return [...mac.subarray(0, 12)].map((byte) => alphabet[byte % 36]).join("");
}

/**
 * C7's checks, at click time. Returns null when the repository may be
 * submitted publicly, or the reason it may not, as text for the author.
 */
export async function submitPubliclyRefusal(env, lifecycle, principal) {
  if (lifecycle?.state !== "held") return "Only a held confidential submission can be submitted publicly.";
  const repo = await fetchRepository(env.GITHUB_TOKEN, lifecycle.repository).catch(() => null);
  if (!repo || repo.private === true || repo.id !== lifecycle.repository_id) {
    return "Make the repository public first; Palomar checks it is the same repository.";
  }
  const reachable = await commitOnDefaultBranch(env, lifecycle.repository, repo.default_branch, lifecycle.commit);
  if (!reachable) return "The submitted commit must be on the repository's default branch.";
  if (!sourceAppConfigured(env)) return "Palomar cannot check repository administrators just now.";
  const access = await withSourceToken(env, lifecycle.repository, (token) =>
    sourceRepositoryAccess(token, lifecycle.repository, principal));
  if (!access) {
    return "Palomar checks you administer the repository through the Palomar Source App; keep it installed until you submit publicly.";
  }
  if (access.permission !== "admin") return "Only an administrator of the repository can submit it publicly.";
  return null;
}

async function commitOnDefaultBranch(env, repository, branch, commit) {
  if (!branch) return false;
  const response = await fetch(
    `${API}/repos/${repository}/compare/${encodeURIComponent(branch)}...${commit}`,
    { headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "palomar-server",
    } },
  );
  if (!response.ok) return false;
  const comparison = await response.json();
  return ["identical", "behind"].includes(comparison?.status);
}
