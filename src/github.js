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

// Every write commits to one branch, so writers collide whenever two land
// together. Retrying is cheap and a collision is not a disagreement about
// anything; give it enough attempts that ordinary traffic never sees one.
const MAX_WRITE_ATTEMPTS = 8;

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

/**
 * Does this commit exist in this public repository?
 *
 * A well-formed but absent SHA answers 422, not 404, so both mean "no". Left
 * as an error, a mistyped commit reaches the submitter as a server fault
 * instead of the one thing they could actually fix.
 */
export async function resolveCommit(token, repository, commit) {
  const response = await fetch(`${API}/repos/${repository}/commits/${commit}`, {
    headers: headers(token),
  });
  if (response.status === 404 || response.status === 422) return null;
  if (!response.ok) {
    throw new GitHubError(response.status, (await response.text()).slice(0, 300));
  }
  return (await response.json())?.sha ?? null;
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
  for (let attempt = 0; ; attempt += 1) {
    const body = { message, content: encode(value), ...(sha ? { sha } : {}) };
    const response = await fetch(
      `${API}/repos/${env.STATE_REPO}/contents/${encodeURI(path)}`,
      {
        method: "PUT",
        headers: { ...headers(env.GITHUB_TOKEN), "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (response.ok) return response.json();
    if ((response.status !== 409 && response.status !== 422) || attempt >= MAX_WRITE_ATTEMPTS) {
      if (response.status === 409 || response.status === 422) {
        throw new GitHubError(response.status, "state changed underneath this write");
      }
      throw new GitHubError(response.status, (await response.text()).slice(0, 300));
    }
    // Every write here commits to one branch, so a 409 has two very different
    // causes: the file we are writing changed, or somebody else's commit landed
    // on the branch first. Only the first is a real conflict. Telling them
    // apart needs a read: if the file is still exactly as we left it, nothing
    // we care about changed and the write can simply be retried.
    if ((await blobSha(env, path)) !== sha) {
      throw new GitHubError(response.status, "state changed underneath this write");
    }
    await pause(attempt);
  }
}

/** The blob sha of a file in the state repository, or null if it is absent. */
async function blobSha(env, path) {
  const data = await call(env.GITHUB_TOKEN, `/repos/${env.STATE_REPO}/contents/${encodeURI(path)}`);
  return data?.sha ?? null;
}

/**
 * Back off with jitter, so two racing writers do not retry in lockstep.
 *
 * Capped, because a submitter is waiting on this: unbounded doubling would
 * spend half a minute on the last attempt alone, which is worse than failing.
 * A collision almost always clears on the first retry; the later attempts are
 * for the rare pile-up.
 */
function pause(attempt) {
  const spread = crypto.getRandomValues(new Uint8Array(1))[0] / 255;
  const ms = Math.round(Math.min(2 ** attempt * 80, 800) * (0.5 + spread));
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ask the reviewer to run now.
 *
 * The schedule is best-effort: GitHub throttles and skips it under load, and
 * it has gone hours without firing. Waiting for it means a submission sits
 * ready with nothing looking at it, so the moment there is work the server
 * says so. The schedule stays as a backstop for anything this missed.
 */
export async function dispatchReviewer(env) {
  if (!env.REVIEW_WORKFLOW) return false;
  const response = await fetch(
    `${API}/repos/${env.STATE_REPO}/actions/workflows/${env.REVIEW_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: { ...headers(env.GITHUB_TOKEN), "content-type": "application/json" },
      body: JSON.stringify({ ref: "main" }),
    },
  );
  if (!response.ok) {
    // Every caller swallows this, because a submission the reviewer cannot be
    // told about now is still picked up by the backstop schedule. That makes a
    // dispatch that always fails — an expired or under-scoped token — invisible:
    // the backstop silently becomes the whole drive train instead of a backstop.
    console.warn("reviewer dispatch rejected", response.status, env.REVIEW_WORKFLOW);
  }
  return response.ok;
}

/** Everything under one directory of the state repository. */
export async function listState(env, directory) {
  const data = await call(
    env.GITHUB_TOKEN,
    `/repos/${env.STATE_REPO}/contents/${encodeURI(directory)}`,
  );
  return Array.isArray(data) ? data : [];
}

export async function deleteState(env, path, sha, message) {
  const response = await fetch(
    `${API}/repos/${env.STATE_REPO}/contents/${encodeURI(path)}`,
    {
      method: "DELETE",
      headers: { ...headers(env.GITHUB_TOKEN), "content-type": "application/json" },
      body: JSON.stringify({ message, sha }),
    },
  );
  return response.ok;
}

/**
 * Start a verification run. Returns nothing useful: the run is found by id.
 *
 * This uses a token that can do nothing but start and read verification runs.
 * A fine-grained token grants the same permissions to every repository it
 * names, so one token covering both the submission repository and the state
 * repository would carry write access to the verification code itself, and a
 * leaked server secret would become a way to forge mechanical verification.
 */
export async function dispatchVerification(env, { repositoryName, commit, requestId, options }) {
  const response = await fetch(
    `${API}/repos/${env.SUBMISSION_REPO}/actions/workflows/${env.VERIFY_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: { ...headers(env.SUBMISSION_TOKEN), "content-type": "application/json" },
      body: JSON.stringify({
        ref: "main",
        inputs: {
          repository: repositoryName,
          commit,
          request_id: requestId,
          // The optional fields the issue form offers, so a server submitter
          // is not quietly told less than an issue submitter would be.
          ...(options && Object.keys(options).length
            ? { options: JSON.stringify(options) }
            : {}),
        },
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
    env.SUBMISSION_TOKEN,
    `/repos/${env.SUBMISSION_REPO}/actions/workflows/${env.VERIFY_WORKFLOW}/runs?per_page=40`,
  );
  // Exact name, not a substring: the submission id appears in a public run
  // name, so anything that merely quotes it is not this submission's run.
  const expected = `Verify submission ${requestId}`;
  const run = (data?.workflow_runs ?? []).find((item) => item.name === expected);
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    url: run.html_url,
    started_at: run.run_started_at,
  };
}

/**
 * The tag an agent created to prove it can write to the repository.
 *
 * Creating a ref requires `contents: write`, which is the capability the
 * browser path reads as `permissions.push`. Resolved rather than trusted: the
 * ref has to exist, in this repository, and point at the very commit being
 * submitted. An annotated tag is refused rather than dereferenced, so the
 * object the proof is about is never one step removed from the object it names.
 */
export const CHALLENGE_TAG_PREFIX = "palomar-verify-";

export async function challengeTag(token, name, challenge, commit) {
  // Prefixed, and not only for tidiness: GitHub refuses a branch or tag whose
  // name is 40 or 64 hex characters, because it could not be told apart from a
  // SHA, and the challenge is 64 hex. The prefix also means a maintainer who
  // notices the tag can tell what it was, rather than finding an unexplained
  // hex string appear and vanish on their repository.
  const ref = await call(
    token, `/repos/${name}/git/ref/tags/${CHALLENGE_TAG_PREFIX}${challenge}`,
  );
  if (!ref) return { ok: false, reason: "no tag by that name exists in the repository" };
  if (ref.object?.type !== "commit") {
    return { ok: false, reason: "the tag is annotated; Palomar reads lightweight tags" };
  }
  if (ref.object?.sha !== commit) {
    return { ok: false, reason: "the tag points at a different commit" };
  }
  return { ok: true };
}

/**
 * The gist an agent created to say who it is.
 *
 * A ref records no author, so this is the half that carries identity. GitHub
 * sets `owner`, and answers immediately, which is why this and not the events
 * feed: that is documented at anything up to six hours.
 */
export async function challengeGist(token, id, challenge) {
  if (!/^[0-9a-f]{1,64}$/i.test(String(id ?? ""))) {
    return { ok: false, reason: "that is not a gist id" };
  }
  const gist = await call(token, `/gists/${id}`);
  if (!gist) return { ok: false, reason: "no such gist" };
  const files = Object.values(gist.files ?? {});
  if (!files.some((file) => String(file?.content ?? "").trim() === challenge)) {
    return { ok: false, reason: "the gist does not carry the challenge" };
  }
  const owner = gist.owner;
  if (owner?.type !== "User" || !owner?.login || !owner?.id) {
    // A bot can hold a token and a gist. The record is meant to name a person.
    return { ok: false, reason: "the gist is not owned by a GitHub user account" };
  }
  return { ok: true, principal: { login: owner.login, id: owner.id } };
}
