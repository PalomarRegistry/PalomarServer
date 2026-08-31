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
const STATE_BRANCH = "main";

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

/** GitHub may have moved State even though the ref-update response was lost. */
export class StateUpdateOutcomeError extends Error {}

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

/** Read one bounded UTF-8 file at an exact public repository commit. */
export async function repositoryTextFile(token, repository, commit, path, maximumBytes) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const query = new URLSearchParams({ ref: commit });
  const data = await call(token, `/repos/${repository}/contents/${encodedPath}?${query}`);
  if (data === null) return null;
  if (
    data.type !== "file" || data.encoding !== "base64" ||
    typeof data.content !== "string" || !Number.isSafeInteger(data.size)
  ) {
    throw new GitHubError(422, `${path} was not an inline regular file`);
  }
  if (data.size > maximumBytes) {
    throw new GitHubError(422, `${path} exceeded its ${maximumBytes}-byte limit`);
  }
  let binary;
  try {
    binary = atob(data.content.replace(/\s/g, ""));
  } catch {
    throw new GitHubError(422, `${path} did not contain valid base64`);
  }
  if (binary.length !== data.size) {
    throw new GitHubError(422, `${path} did not match its declared size`);
  }
  if (binary.length > maximumBytes) {
    throw new GitHubError(422, `${path} exceeded its ${maximumBytes}-byte limit`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    throw new GitHubError(422, `${path} was not valid UTF-8`);
  }
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
  return decodeState(path, data);
}

function encode(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value, null, 2) + "\n");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeState(path, data) {
  if (data === null) return { value: null, sha: null };
  if (typeof data.content !== "string") {
    throw new SyntaxError(`${path} did not contain inline JSON`);
  }
  const text = new TextDecoder().decode(
    Uint8Array.from(atob(data.content.replace(/\n/g, "")), (c) => c.charCodeAt(0)),
  );
  return { value: JSON.parse(text), sha: data.sha };
}

/**
 * Read a closed set of State files from one exact branch head.
 *
 * Contents reads without `ref` can each observe a different commit. Admission
 * needs a single input snapshot: its rate decision, capacity decision, proof
 * consumption, and every projected write either belong to one parent commit
 * or none of them do.
 */
export async function readStateSnapshot(env, paths) {
  const unique = [...new Set(paths)];
  if (unique.length !== paths.length) throw new Error("State snapshot paths must be unique");
  const ref = await call(
    env.GITHUB_TOKEN,
    `/repos/${env.STATE_REPO}/git/ref/heads/${STATE_BRANCH}`,
  );
  const headSha = ref?.object?.type === "commit" ? ref.object.sha : null;
  if (typeof headSha !== "string" || !/^[0-9a-f]{40}$/i.test(headSha)) {
    throw new GitHubError(503, `State ${STATE_BRANCH} did not resolve to a commit`);
  }
  const commit = await call(
    env.GITHUB_TOKEN,
    `/repos/${env.STATE_REPO}/git/commits/${headSha}`,
  );
  const treeSha = commit?.tree?.sha;
  if (typeof treeSha !== "string" || !/^[0-9a-f]{40}$/i.test(treeSha)) {
    throw new GitHubError(503, `State ${STATE_BRANCH} commit had no tree`);
  }
  const files = {};
  await Promise.all(unique.map(async (path) => {
    const query = new URLSearchParams({ ref: headSha });
    const data = await call(
      env.GITHUB_TOKEN,
      `/repos/${env.STATE_REPO}/contents/${encodeURI(path)}?${query}`,
    );
    files[path] = decodeState(path, data);
  }));
  return { headSha, treeSha, files };
}

/**
 * Commit several JSON replacements/deletions as one State transition.
 *
 * A false answer is an ordinary compare-and-swap loss: another writer moved
 * main after the snapshot. The caller must reread and re-evaluate every input.
 * Tree and commit objects created before that loss are unreachable and never
 * become State. No forced ref update is ever used.
 */
async function commitStateSnapshot(env, snapshot, changes, message) {
  const paths = changes.map((change) => change.path);
  if (new Set(paths).size !== paths.length) {
    throw new Error("A State transaction cannot change one path twice");
  }
  const tree = await call(
    env.GITHUB_TOKEN,
    `/repos/${env.STATE_REPO}/git/trees`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        base_tree: snapshot.treeSha,
        tree: changes.map((change) => ({
          path: change.path,
          mode: "100644",
          type: "blob",
          ...(change.delete ? { sha: null } : {
            content: JSON.stringify(change.value, null, 2) + "\n",
          }),
        })),
      }),
    },
  );
  if (typeof tree?.sha !== "string") throw new GitHubError(502, "GitHub created no State tree");
  const commit = await call(
    env.GITHUB_TOKEN,
    `/repos/${env.STATE_REPO}/git/commits`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, tree: tree.sha, parents: [snapshot.headSha] }),
    },
  );
  if (typeof commit?.sha !== "string") {
    throw new GitHubError(502, "GitHub created no State commit");
  }
  const update = {
    method: "PATCH",
    headers: { ...headers(env.GITHUB_TOKEN), "content-type": "application/json" },
    body: JSON.stringify({ sha: commit.sha, force: false }),
  };
  let response;
  let uncertain = false;
  try {
    response = await fetch(
      `${API}/repos/${env.STATE_REPO}/git/refs/heads/${STATE_BRANCH}`,
      update,
    );
  } catch {
    // A rejected fetch has the same unknown outcome as an HTTP 5xx here.
  }
  if (!response || response.status >= 500) {
    // Repeating this non-forced update is idempotent. If the first request
    // landed, GitHub either accepts the same target again or reports that a
    // later descendant is now at the ref; if it did not, this request applies
    // the commit. This closes the ordinary lost-response window without a
    // second State transition or a forced write.
    uncertain = true;
    try {
      response = await fetch(
        `${API}/repos/${env.STATE_REPO}/git/refs/heads/${STATE_BRANCH}`,
        update,
      );
    } catch {
      response = null;
    }
  }
  if (uncertain && !response?.ok) {
    try {
      const ref = await call(
        env.GITHUB_TOKEN,
        `/repos/${env.STATE_REPO}/git/ref/heads/${STATE_BRANCH}`,
      );
      const headSha = ref?.object?.type === "commit" ? ref.object.sha : null;
      if (headSha === commit.sha) return true;
      if (typeof headSha === "string" && /^[0-9a-f]{40}$/i.test(headSha)) {
        const comparison = await call(
          env.GITHUB_TOKEN,
          `/repos/${env.STATE_REPO}/compare/${commit.sha}...${headSha}`,
        );
        if (
          ["ahead", "identical"].includes(comparison?.status) &&
          comparison?.merge_base_commit?.sha === commit.sha
        ) return true;
      }
    } catch {
      // The outcome remains unknown; the typed error below prevents callers
      // from claiming that the proof was definitely not consumed.
    }
    if (response?.status === 409) return false;
    if (response?.status === 422) {
      const detail = (await response.text()).slice(0, 300);
      if (/not a fast.?forward/i.test(detail)) return false;
    }
    throw new StateUpdateOutcomeError("State ref update outcome is unknown");
  }
  if (response.status === 409) return false;
  if (response.status === 422) {
    const detail = (await response.text()).slice(0, 300);
    if (/not a fast.?forward/i.test(detail)) return false;
    throw new GitHubError(response.status, detail || "State ref update was rejected");
  }
  if (!response.ok) {
    throw new GitHubError(response.status, (await response.text()).slice(0, 300));
  }
  return true;
}

/**
 * Re-evaluate and atomically apply one multi-file State transition.
 *
 * `project` receives files from one exact commit and returns the complete
 * change set, commit message, and value to hand to the caller. Ref contention
 * retries from a fresh head; contract conflicts raised by `project` do not.
 */
export async function transactState(env, paths, project) {
  for (let attempt = 0; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
    const snapshot = await readStateSnapshot(env, paths);
    const projected = await project(snapshot.files);
    if (projected.changes.length === 0) return projected.result;
    if (await commitStateSnapshot(
      env,
      snapshot,
      projected.changes,
      projected.message,
    )) return projected.result;
    if (attempt >= MAX_WRITE_ATTEMPTS) {
      throw new GitHubError(409, "State branch kept changing underneath this transaction");
    }
    await pause(attempt);
  }
  throw new Error("unreachable State transaction attempt");
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

/** Wake the metadata repair worker; its schedule remains the durable backstop. */
export async function dispatchRepairer(env) {
  if (!env.REPAIR_WORKFLOW) return false;
  const response = await fetch(
    `${API}/repos/${env.STATE_REPO}/actions/workflows/${env.REPAIR_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: { ...headers(env.GITHUB_TOKEN), "content-type": "application/json" },
      body: JSON.stringify({ ref: "main" }),
    },
  );
  if (!response.ok) {
    console.warn("repairer dispatch rejected", response.status, env.REPAIR_WORKFLOW);
  }
  return response.ok;
}

// The contents API answers at most this many entries for one directory, and
// says to use the git trees API past it.
const CONTENTS_DIRECTORY_LIMIT = 1000;

/**
 * Everything under one directory of the state repository.
 *
 * A listing of exactly the API's limit cannot be told apart from one that was
 * cut off at it, so both are refused. The caller is a sweep, and a sweep that
 * silently sees a prefix of a directory is a sweep that reports having tidied
 * up while the part it never saw grows without bound.
 */
export async function listState(env, directory) {
  const data = await call(
    env.GITHUB_TOKEN,
    `/repos/${env.STATE_REPO}/contents/${encodeURI(directory)}`,
  );
  if (!Array.isArray(data)) return [];
  if (data.length >= CONTENTS_DIRECTORY_LIMIT) {
    throw new Error(
      `${directory} holds ${data.length} entries, at or past the ` +
        `${CONTENTS_DIRECTORY_LIMIT} the contents API will list; it cannot be enumerated ` +
        "this way any more",
    );
  }
  return data;
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
export async function dispatchVerification(
  env,
  { repositoryName, commit, requestId, options, mode = "full" },
) {
  if (!new Set(["preflight", "full", "correction"]).has(mode)) {
    throw new Error("invalid verification mode");
  }
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
          mode,
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
// Pages of a hundred. A submission that is admitted and dispatched is looked
// for from the moment it was admitted, so reaching this many full pages means
// the workflow ran three hundred times in that window, which is a different
// problem from the one this function is solving.
const MAX_RUN_PAGES = 3;

function describeRun(run) {
  return {
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    url: run.html_url,
    started_at: run.run_started_at,
  };
}

/**
 * The verification run a submission dispatched.
 *
 * A dispatch answers with no run id, so a run has to be recovered by name the
 * first time. `per_page=40` made that a window rather than a search: forty runs
 * between the dispatch and the next reconcile and this submission's run was
 * never seen again, and its record went on holding an owner slot and its
 * submitter's sole slot until somebody edited private state by hand. Bounded
 * by when the submission was admitted
 * instead, since nothing started before it can be its run, and by `event`,
 * because a scheduled or push-triggered run never carries this name.
 *
 * Once a run is pinned it is asked for by id. Searching by name and then
 * refusing whatever came back would wedge a record whose own run had simply
 * fallen further down the list than the search reached.
 *
 * Answers `{ run, complete }`. `complete` says whether the absence of a run is
 * something this function actually established, or only where it stopped
 * looking, and the difference decides whether a submission may be given up on.
 * Reading a truncated search as "no such run" is how a live run gets its slot
 * taken away from it.
 */
export async function findVerificationRun(
  env,
  requestId,
  { pinnedRunId = null, since = null, mode = "full" } = {},
) {
  if (!new Set(["preflight", "full", "correction"]).has(mode)) {
    throw new Error("invalid verification mode");
  }
  const expected = mode === "preflight"
    ? `Preflight submission ${requestId}`
    : mode === "correction"
      ? `Validate registry correction ${requestId}`
      : `Verify submission ${requestId}`;

  if (pinnedRunId) {
    const run = await call(
      env.SUBMISSION_TOKEN,
      `/repos/${env.SUBMISSION_REPO}/actions/runs/${pinnedRunId}`,
    );
    // The repository comes from the path and the workflow and event were
    // established when this id was first discovered and written to private
    // state, so the name is what is left to check, against a record that has
    // been corrupted or an id that has been reused.
    if (!run || run.name !== expected) return { run: null, complete: true };
    return { run: describeRun(run), complete: true };
  }

  // Exact name, not a substring: the submission id appears in a public run
  // name, so anything that merely quotes it is not this submission's run.
  const query = new URLSearchParams({ event: "workflow_dispatch", per_page: "100" });
  if (since) query.set("created", `>=${since}`);
  for (let page = 1; page <= MAX_RUN_PAGES; page += 1) {
    query.set("page", String(page));
    const data = await call(
      env.SUBMISSION_TOKEN,
      `/repos/${env.SUBMISSION_REPO}/actions/workflows/${env.VERIFY_WORKFLOW}/runs?${query}`,
    );
    const runs = data?.workflow_runs ?? [];
    const run = runs.find((item) => item.name === expected);
    if (run) return { run: describeRun(run), complete: true };
    // A short page is the last page: the run is genuinely not there.
    if (runs.length < 100) return { run: null, complete: true };
  }
  // Every page was full, so the search ran out of pages rather than out of
  // runs, and nothing has been established.
  return { run: null, complete: false };
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
export async function challengeGist(token, id, challenge, { issuedAt = null } = {}) {
  if (!/^[0-9a-f]{1,64}$/i.test(String(id ?? ""))) {
    return { ok: false, reason: "that is not a gist id" };
  }
  const gist = await call(token, `/gists/${id}`);
  if (!gist) return { ok: false, reason: "no such gist" };
  const files = Object.values(gist.files ?? {});
  if (!files.some((file) => String(file?.content ?? "").trim() === challenge)) {
    return { ok: false, reason: "the gist does not carry the challenge" };
  }
  // Made for this challenge rather than found already carrying it. The
  // challenge is public by construction: it is a tag name on a public
  // repository, so anybody watching can read it. A gist more than a minute
  // older than the intake cannot have been made for it, and the minute is
  // slack for the two clocks involved rather than a judgement about anything.
  // It costs a legitimate agent nothing, since it creates the gist after being
  // told what to put in it.
  if (issuedAt && Date.parse(gist.created_at ?? 0) < Date.parse(issuedAt) - 60_000) {
    return { ok: false, reason: "the gist predates this challenge" };
  }
  // The instructions say secret and the check should say it too. A public gist
  // is discoverable, so somebody talked into posting the challenge in one could
  // be found rather than having to hand the id over, which is the difference
  // between an attack that needs cooperation and one that needs a single
  // careless act.
  if (gist.public !== false) {
    return { ok: false, reason: "the gist is public; Palomar reads secret gists" };
  }
  const owner = gist.owner;
  if (owner?.type !== "User" || !owner?.login || !owner?.id) {
    // A bot can hold a token and a gist. The record is meant to name a person.
    return { ok: false, reason: "the gist is not owned by a GitHub user account" };
  }
  return { ok: true, principal: { login: owner.login, id: owner.id } };
}
