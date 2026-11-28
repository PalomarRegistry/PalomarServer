/**
 * The one-shot source fetch for a confidential submission (contract v3.1, C2).
 *
 * Palomar reads a confidential submission's source exactly once, here, inside
 * the Worker. For a private repository it mints a read-only installation token
 * of the Palomar Source App limited to that one repository, uses it for the
 * tree and the tarball of the exact commit, and drops it. The token is never
 * cached, logged, returned, stored or passed to a workflow, and every error
 * raised here is built from fixed text and status codes only, never from a
 * response URL or body (a private tarball redirect carries a token in its URL).
 *
 * The pilot accepts plain Git trees only: no submodules, no Git LFS, and no
 * `.gitattributes` filter or export rules, because a tarball loses exactly the
 * metadata those depend on. The tarball must then list exactly the tree's
 * files, links and sizes.
 */

import { appJwt } from "./github-app.js";
import { readTarGz } from "./tar.js";

const API = "https://api.github.com";
export const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const SOURCE_PERMISSIONS = { contents: "read", metadata: "read" };

/** A failure that is the submitter's to fix; its text is safe to show them. */
export class SourceRefusal extends Error {}

/** A failure at this end or GitHub's, worth retrying; its text is fixed. */
export class SourceUnavailable extends Error {}

function githubHeaders(token) {
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "palomar-server",
  };
}

async function getJson(token, path, what) {
  let response;
  try {
    response = await fetch(`${API}${path}`, { headers: githubHeaders(token) });
  } catch {
    throw new SourceUnavailable(`GitHub could not be reached for the ${what}`);
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new SourceUnavailable(`GitHub answered ${response.status} for the ${what}`);
  return response.json();
}

export function sourceAppConfigured(env) {
  return Boolean(env.SOURCE_APP_ID && env.SOURCE_APP_PRIVATE_KEY);
}

/**
 * Run `use(token)` with a fresh read-only Source App token for one repository.
 *
 * Returns null without calling `use` when the App is not installed there. The
 * token lives only for the duration of `use`, as a local.
 */
export async function withSourceToken(env, repository, use) {
  if (!sourceAppConfigured(env)) throw new SourceUnavailable("the Source App is not configured");
  const [owner, name] = repository.split("/");
  const jwt = await appJwt(env.SOURCE_APP_ID, env.SOURCE_APP_PRIVATE_KEY, Date.now());
  const installation = await getJson(jwt, `/repos/${owner}/${name}/installation`, "Source App installation");
  if (!Number.isSafeInteger(installation?.id)) return null;
  let response;
  try {
    response = await fetch(`${API}/app/installations/${installation.id}/access_tokens`, {
      method: "POST",
      headers: { ...githubHeaders(jwt), "content-type": "application/json" },
      body: JSON.stringify({ repositories: [name], permissions: SOURCE_PERMISSIONS }),
    });
  } catch {
    throw new SourceUnavailable("GitHub could not be reached for a Source App token");
  }
  if (!response.ok) throw new SourceUnavailable(`GitHub answered ${response.status} for a Source App token`);
  const minted = await response.json();
  if (typeof minted?.token !== "string" || !minted.token) {
    throw new SourceUnavailable("GitHub returned no Source App token");
  }
  return use(minted.token);
}

/**
 * The repository and this principal's permission on it, read with the token.
 * `permission` is GitHub's `admin`, `write`, `read` or `none`, and counts only
 * if GitHub says it is about the same numeric account.
 */
export function sourceRepository(token, repository) {
  return getJson(token, `/repos/${repository}`, "repository");
}

export async function sourceRepositoryAccess(token, repository, principal) {
  const repo = await sourceRepository(token, repository);
  if (!repo) return null;
  const login = encodeURIComponent(String(principal?.login ?? ""));
  const found = await getJson(
    token, `/repos/${repository}/collaborators/${login}/permission`, "repository permission",
  );
  const permission = found?.user?.id === principal?.id ? String(found?.permission ?? "none") : "none";
  return { repo, permission };
}

const ATTRIBUTE_RULE = /(^|\s)-?!?(filter|export-ignore|export-subst)(=|\s|$)/m;

/**
 * Check the commit's recursive tree and fetch its tarball.
 *
 * `token` is null for a public repository. Returns the tarball bytes and their
 * SHA-256; throws SourceRefusal for anything the pilot does not accept.
 */
export async function fetchPlainSource(token, repository, commit) {
  const tree = await getJson(token, `/repos/${repository}/git/trees/${commit}?recursive=1`, "tree");
  if (!tree || !Array.isArray(tree.tree)) {
    throw new SourceRefusal("That commit could not be read from the repository.");
  }
  if (tree.truncated) {
    throw new SourceRefusal("That commit has too many files for a confidential submission.");
  }
  const expected = new Map();
  for (const entry of tree.tree) {
    if (entry.mode === "160000" || entry.type === "commit") {
      throw new SourceRefusal(
        `Confidential submissions cannot contain Git submodules (${entry.path}).`,
      );
    }
    if (entry.type === "blob") {
      expected.set(entry.path, entry.mode === "120000" ? { link: true } : { size: entry.size });
    }
  }

  let response;
  try {
    response = await fetch(`${API}/repos/${repository}/tarball/${commit}`, {
      headers: githubHeaders(token),
    });
  } catch {
    throw new SourceUnavailable("GitHub could not be reached for the tarball");
  }
  if (!response.ok) throw new SourceUnavailable(`GitHub answered ${response.status} for the tarball`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_SOURCE_BYTES) {
    throw new SourceRefusal("That commit is too large for a confidential submission.");
  }
  const bytes = await boundedBytes(response.body, MAX_SOURCE_BYTES);
  if (!bytes) throw new SourceRefusal("That commit is too large for a confidential submission.");

  const entries = await readTarGz(bytes);
  const seen = new Set();
  for (const entry of entries) {
    if (entry.type === "directory") continue;
    const want = expected.get(entry.path);
    const matches = want && (want.link ? entry.type === "symlink"
      : entry.type === "file" && entry.size === want.size);
    if (!matches) {
      throw new SourceRefusal(
        "GitHub's archive of that commit differs from its Git tree " +
        `(${entry.path}), which usually means Git LFS; confidential submissions accept plain Git trees only.`,
      );
    }
    seen.add(entry.path);
    if (entry.type === "file" && /^(.*\/)?\.gitattributes$/.test(entry.path) &&
        ATTRIBUTE_RULE.test(new TextDecoder().decode(entry.data))) {
      throw new SourceRefusal(
        `Confidential submissions cannot use .gitattributes filter or export rules (${entry.path}).`,
      );
    }
    if (entry.type === "file" && entry.size < 1024 &&
        new TextDecoder().decode(entry.data).startsWith("version https://git-lfs.github.com/spec/")) {
      throw new SourceRefusal(`Confidential submissions cannot contain Git LFS pointers (${entry.path}).`);
    }
  }
  for (const path of expected.keys()) {
    if (!seen.has(path)) {
      throw new SourceRefusal(
        `GitHub's archive of that commit leaves out ${path}; confidential submissions accept plain Git trees only.`,
      );
    }
  }
  const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { bytes, sha256 };
}

async function boundedBytes(body, maximum) {
  const chunks = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maximum) return null;
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
