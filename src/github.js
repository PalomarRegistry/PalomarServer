/**
 * Every durable thing the server knows lives in GitHub.
 *
 * The Worker holds no state of its own between requests. A submission is a
 * directory of JSON files committed to a private repository, and every
 * transition is a commit. That is what makes the server disposable: switch it
 * off and the record is complete, and the operator CLI can drive any
 * submission to a terminal state without it.
 */

const API = "https://api.github.com";

function headers(token) {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "palomar-server",
  };
}

export class GitHubError extends Error {
  constructor(status, message) {
    super(`GitHub ${status}: ${message}`);
    this.status = status;
  }
}

async function call(token, path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...headers(token), ...(init.headers ?? {}) },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new GitHubError(response.status, (await response.text()).slice(0, 300));
  }
  return response.status === 204 ? true : response.json();
}

/** Does this commit exist in this public repository? */
export async function resolveCommit(token, repository, commit) {
  const data = await call(token, `/repos/${repository}/commits/${commit}`);
  return data?.sha ?? null;
}

export async function repository(token, name) {
  return call(token, `/repos/${name}`);
}

/**
 * Read a JSON file from the state repository.
 *
 * Returns the parsed contents together with the blob sha, because every write
 * is conditional on the sha it read: two submissions updating the same index
 * must not silently lose one.
 */
export async function readState(env, path) {
  const data = await call(
    env.GITHUB_TOKEN,
    `/repos/${env.STATE_REPO}/contents/${encodeURI(path)}`,
  );
  if (!data?.content) return { value: null, sha: null };
  const text = new TextDecoder().decode(
    Uint8Array.from(atob(data.content.replace(/\n/g, "")), (c) => c.charCodeAt(0)),
  );
  return { value: JSON.parse(text), sha: data.sha };
}

function encode(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value, null, 2) + "\n");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Write a JSON file, refusing to clobber a concurrent change.
 *
 * `sha` null means "create only": if the path already exists GitHub returns
 * 422 and we surface it, rather than overwriting a record we never read.
 */
export async function writeState(env, path, value, message, sha = null) {
  const body = { message, content: encode(value), ...(sha ? { sha } : {}) };
  const response = await fetch(
    `${API}/repos/${env.STATE_REPO}/contents/${encodeURI(path)}`,
    {
      method: "PUT",
      headers: { ...headers(env.GITHUB_TOKEN), "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (response.status === 409 || response.status === 422) {
    throw new GitHubError(response.status, "state changed underneath this write");
  }
  if (!response.ok) {
    throw new GitHubError(response.status, (await response.text()).slice(0, 300));
  }
  return response.json();
}

/** Start a verification run. Returns nothing useful: the run is found by id. */
export async function dispatchVerification(env, { repositoryName, commit, requestId }) {
  const response = await fetch(
    `${API}/repos/${env.SUBMISSION_REPO}/actions/workflows/${env.VERIFY_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: { ...headers(env.GITHUB_TOKEN), "content-type": "application/json" },
      body: JSON.stringify({
        ref: "main",
        inputs: { repository: repositoryName, commit, request_id: requestId },
      }),
    },
  );
  if (!response.ok) {
    throw new GitHubError(response.status, (await response.text()).slice(0, 300));
  }
}

/**
 * Find the verification run for a submission.
 *
 * Matched on the request id in the run name, which the workflow sets from its
 * inputs. A dispatch does not return a run id, so this is how a dispatched run
 * is recovered after a crash between dispatching and recording.
 */
export async function findVerificationRun(env, requestId) {
  const data = await call(
    env.GITHUB_TOKEN,
    `/repos/${env.SUBMISSION_REPO}/actions/workflows/${env.VERIFY_WORKFLOW}/runs?per_page=40`,
  );
  const run = (data?.workflow_runs ?? []).find((item) =>
    typeof item.name === "string" && item.name.includes(requestId),
  );
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    url: run.html_url,
    started_at: run.run_started_at,
  };
}
