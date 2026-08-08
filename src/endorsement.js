/**
 * Whether anybody Palomar already trusts has been near this repository.
 *
 * Push access proves a submitter may speak for a repository. It proves nothing
 * about whether the repository is real: a fresh account and a repository made a
 * minute ago clear it, which is why the admission caps exist and say so. This
 * is the other half, an eligibility rule rather than a rate, and it asks for
 * one cheap thing that is expensive to manufacture: that somebody who has
 * already registered a result in Palomar has engaged with this repository.
 *
 * A star, a fork, an issue, a pull request, a comment, or a commit. Any one of
 * them, from any one of those people. None of it is a judgement about quality;
 * it is a judgement about whether anything here exists outside the submission.
 *
 * It is off unless `SUBMISSION_ENDORSEMENT` names the signals that count, and
 * it is off in `wrangler.jsonc` today. Turning it on is one line, and the line
 * says exactly which signals a deployment is asking for.
 */

import { readState, repositoryPage } from "./github.js";

/**
 * Who counts, kept where every other index lives.
 *
 * Plaintext logins and ids, unlike `index/rate/` and `index/tokens/`, which are
 * filed under peppered digests so that listing a directory does not enumerate
 * everyone who has ever submitted. Nothing is given away by the difference:
 * `submissions/<id>/state.json` already carries `submitter` in the clear in the
 * same private repository, so a digest here would protect a name that is two
 * files away. What it would cost is the two things this file exists for: an
 * operator adding somebody by hand, and a rebuild that can be read and checked.
 */
export const ENDORSERS_PATH = "index/endorsers.json";

// Named in `SUBMISSION_ENDORSEMENT`, and the same words the refusal uses.
export const SIGNALS = {
  star: {
    phrase: "a star",
    // A stargazer is the account itself, not a wrapper around one.
    scans: [{ path: "stargazers", actor: (item) => item }],
  },
  fork: {
    phrase: "a fork",
    scans: [{ path: "forks", actor: (item) => item?.owner }],
  },
  issue: {
    phrase: "an issue",
    // `/issues` answers with pull requests too, and they are counted under
    // their own name or not at all: a deployment asking for `issue` alone and
    // silently accepting pull requests would be a wider rule than the one it
    // configured.
    scans: [{
      path: "issues?state=all",
      actor: (item) => (item?.pull_request ? null : item?.user),
    }],
  },
  "pull-request": {
    phrase: "a pull request",
    scans: [{ path: "pulls?state=all", actor: (item) => item?.user }],
  },
  comment: {
    phrase: "a comment",
    // Both kinds. A review comment on a pull request is not an issue comment
    // and does not appear in the other list, and somebody who has reviewed code
    // here has done more than somebody who has not.
    scans: [
      { path: "issues/comments", actor: (item) => item?.user },
      { path: "pulls/comments", actor: (item) => item?.user },
    ],
  },
  commit: {
    phrase: "a commit",
    // Null whenever GitHub cannot match the commit's email to an account, which
    // is a miss rather than an error: the signal is "this account committed
    // here", and an unlinked email does not say that.
    scans: [{ path: "commits", actor: (item) => item?.author }],
  },
};

// How far into each list this is willing to read. Every scan is one request per
// hundred, they run together, and the shape of the answer barely depends on the
// depth: the repository this is meant to catch has one page of everything and
// usually none, and the repository with more than five hundred stargazers is
// already not the drive-by the rule is about. Deeper would buy precision on
// exactly the repositories where precision does not matter, at a request cost
// paid by every submission that reaches here.
const PER_PAGE = 100;
const MAX_PAGES = 5;

/**
 * What this deployment is asking for, read from the environment.
 *
 * `ok` is false only for a configuration that cannot be honoured: a signal list
 * that asks for something and names nothing this understands. The caller stops
 * serving on that, which is the same answer a missing `INTAKE_LIMITER` gets and
 * for the same reason. The alternative is worse than it sounds: `enabled`
 * would be false, so a typo would not narrow the rule but remove it, and a
 * deployment that believed it had switched the rule on would be admitting
 * everybody with nothing to say otherwise. A configuration that cannot be
 * honoured is not one to guess at.
 */
export function endorsementPolicy(env) {
  const raw = String(env?.SUBMISSION_ENDORSEMENT ?? "").trim();
  if (!raw) return { enabled: false, ok: true, signals: [], self: "exempt" };

  const requested = [...new Set(
    raw.split(",").map((name) => name.trim().toLowerCase()).filter(Boolean),
  )];
  const signals = requested.filter((name) => Object.hasOwn(SIGNALS, name));
  const unknown = requested.filter((name) => !Object.hasOwn(SIGNALS, name));
  if (unknown.length) {
    console.error("configuration", `SUBMISSION_ENDORSEMENT names no such signal: ${unknown.join(", ")}`);
  }
  if (!signals.length) {
    console.error("configuration", "SUBMISSION_ENDORSEMENT names no signal this understands");
    return { enabled: false, ok: false, signals: [], self: "exempt" };
  }

  // `exempt`: somebody who has already registered a result submits without
  // being asked again, which is the whole point of having registered one.
  // `excluded`: they are asked every time, and their own star never answers it,
  // so every repository needs somebody else. Stricter, and the reason to want
  // it is that one registered result otherwise unlocks every repository its
  // author can push to.
  const requestedSelf = String(env?.SUBMISSION_ENDORSEMENT_SELF ?? "exempt").trim().toLowerCase();
  const self = requestedSelf === "excluded" ? "excluded" : "exempt";
  if (requestedSelf !== self) {
    console.error("configuration", `SUBMISSION_ENDORSEMENT_SELF is not exempt or excluded: ${requestedSelf}`);
  }

  return { enabled: true, ok: true, signals, self };
}

/**
 * Everyone whose engagement counts, as the two ways an actor can be recognised.
 *
 * Ids for anybody Palomar registered, because a login is renameable and the
 * account that later takes an abandoned one is a different person. Logins are
 * matched too, for allowlist entries added by hand before their subject has an
 * id on file. An operator writing a name is the point of that list, and asking
 * for a numeric id first would defeat it. An entry carrying both is matched by
 * either, and the id is what makes it survive a rename.
 */
function readEndorsers(value) {
  const ids = new Set();
  const logins = new Set();
  const collect = (rows) => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (Number.isInteger(row?.id)) ids.add(row.id);
      if (typeof row?.login === "string" && row.login) logins.add(row.login.toLowerCase());
    }
  };
  collect(value?.allowed);
  collect(value?.registered);
  return { ids, logins };
}

/** The endorser this actor is, or null. */
function recognise(endorsers, actor) {
  if (!actor) return null;
  const login = typeof actor.login === "string" ? actor.login : null;
  if (Number.isInteger(actor.id) && endorsers.ids.has(actor.id)) {
    return { login, id: actor.id };
  }
  if (login && endorsers.logins.has(login.toLowerCase())) {
    return { login, id: Number.isInteger(actor.id) ? actor.id : null };
  }
  return null;
}

/**
 * Read one list until it answers, runs out, or runs past what this will read.
 *
 * Stops the moment any other scan has found somebody: they are looking for the
 * same answer, and the first one to have it makes the rest of the requests
 * pointless rather than merely redundant.
 */
async function scan(env, repositoryName, { path, actor }, endorsers, state) {
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    if (state.found) return;
    const separator = path.includes("?") ? "&" : "?";
    const query = `${separator}per_page=${PER_PAGE}&page=${page}`;
    let items;
    try {
      items = await repositoryPage(env.GITHUB_TOKEN, `/repos/${repositoryName}/${path}${query}`);
    } catch (error) {
      // Not an absence. A rate limit, a bad gateway and a repository that has
      // just been made private all land here, and none of them means nobody
      // has starred anything.
      state.unread.push(`${path}: ${error.message}`);
      return;
    }
    for (const item of items) {
      const found = recognise(endorsers, actor(item));
      if (found) {
        state.found = { signal: state.signalOf.get(path), by: found };
        return;
      }
    }
    // A short page is the end of the list, and the only way to know the list
    // was read rather than sampled.
    if (items.length < PER_PAGE) return;
  }
  state.unread.push(`${path}: longer than ${MAX_PAGES * PER_PAGE}`);
}

/**
 * Ask whether this repository may be submitted, given who Palomar trusts.
 *
 * Answers `{ refused: false, endorsement }`, or a refusal shaped like the ones
 * `rateLimit` and `admit` return, so the caller renders all three the same way.
 *
 * Three things can be true and only one of them is the submitter's fault. Being
 * found is an answer. Reading every configured list to its end and finding
 * nobody is an answer. Failing to read one of them is not: it admits, and says
 * in the record that it did. A rule that turns a bad minute at GitHub into a
 * refusal aimed at a person who did nothing wrong is worse than a rule that
 * occasionally lets one through, and the caps and the rate limit are still in
 * front of whatever comes next.
 */
export async function requireEndorsement(env, { repositoryName, principal }) {
  const policy = endorsementPolicy(env);
  if (!policy.enabled) return { refused: false, endorsement: null };

  const file = await readState(env, ENDORSERS_PATH).catch(() => null);
  if (file === null) {
    // The read failed rather than answering. Same reasoning as an unread list.
    console.warn("endorsement", `could not read ${ENDORSERS_PATH}; admitting`);
    return {
      refused: false,
      endorsement: {
        outcome: "unchecked",
        reason: `${ENDORSERS_PATH} could not be read`,
        checked_at: now(),
      },
    };
  }
  const endorsers = file.value === null ? null : readEndorsers(file.value);
  if (endorsers === null || (!endorsers.ids.size && !endorsers.logins.size)) {
    // The rule is on and there is nobody it could ever answer yes for, so every
    // submission would be refused with a message implying the submitter's
    // repository is the problem. Absent and empty are the same failure here and
    // are treated the same: this is configuration drift, of the kind
    // `INTAKE_LIMITER` gets the same answer for, and it is ours. The way out is
    // the hand-written `allowed` list, which exists precisely because the
    // derived half starts empty and cannot fill itself.
    console.error("configuration", `${ENDORSERS_PATH} names nobody`);
    return {
      refused: true,
      status: 503,
      title: "Palomar is not configured",
      detail: [
        "This deployment is missing something it needs and is not accepting",
        "submissions. This is ours to fix, not yours.",
      ],
    };
  }

  if (policy.self === "exempt" && recognise(endorsers, principal)) {
    return {
      refused: false,
      endorsement: { outcome: "prior-submitter", checked_at: now() },
    };
  }
  if (policy.self === "excluded" && principal) {
    // Their own engagement stops counting, rather than their submission being
    // refused for it: the question is whether anybody else is here.
    if (Number.isInteger(principal.id)) endorsers.ids.delete(principal.id);
    if (typeof principal.login === "string") endorsers.logins.delete(principal.login.toLowerCase());
  }

  const state = { found: null, unread: [], signalOf: new Map() };
  const scans = [];
  for (const name of policy.signals) {
    for (const item of SIGNALS[name].scans) {
      state.signalOf.set(item.path, name);
      scans.push(item);
    }
  }
  await Promise.all(scans.map((item) => scan(env, repositoryName, item, endorsers, state)));

  if (state.found) {
    return {
      refused: false,
      endorsement: {
        outcome: "endorsed",
        signal: state.found.signal,
        by: state.found.by.login ?? String(state.found.by.id),
        checked_at: now(),
      },
    };
  }
  if (state.unread.length) {
    console.warn("endorsement", `${repositoryName}: ${state.unread.join("; ")}`);
    return {
      refused: false,
      endorsement: { outcome: "unchecked", reason: state.unread.join("; "), checked_at: now() },
    };
  }
  return {
    refused: true,
    status: 403,
    title: "That repository has no connection to Palomar yet",
    detail: [
      `Palomar is currently accepting repositories that somebody who has already`,
      `registered a result has engaged with: ${describeSignals(policy.signals)}.`,
      "Nothing about your repository has been judged. This is a limit on how",
      "fast Palomar is opening up, and it is meant to be temporary.",
    ],
  };
}

/** "a star, a fork, or a commit", in the order the configuration named them. */
function describeSignals(signals) {
  const phrases = signals.map((name) => SIGNALS[name].phrase);
  if (phrases.length === 1) return phrases[0];
  return `${phrases.slice(0, -1).join(", ")}, or ${phrases[phrases.length - 1]}`;
}

function now() {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}
