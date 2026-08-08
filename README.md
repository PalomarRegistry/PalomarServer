# Palomar submission server

A Cloudflare Worker that takes submissions, establishes that whoever submitted
can push to the repository they submitted, and keeps every durable fact in
GitHub.

Live at <https://submit.palomar-registry.org>.

## Why it holds no state

The Worker keeps nothing between requests. A submission is a directory of JSON
files committed to the private `PalomarRegistry/PalomarSubmissionState`
repository, and every transition is a commit. Switch the Worker off and the
record is complete; the operator CLI can drive any submission to a terminal
state without it. That is the property that stops this becoming something we
cannot leave.

## What is secret, and what is not

Stated on the intake form, in these words, because it is not what people
assume:

- **Public from the moment you submit:** the repository, commit, and selected
  Comparator configuration path.
  Verification runs in a public Actions workflow whose logs are public.
- **Never public unless the author registers:** the review, the decision, and
  the submitter's identity.
- **"Private" means not public, not confidential.** Reviews are readable by
  operators, GitHub, and the model provider, and are kept indefinitely.

## Identity

There is no account. There are two ways in, and a record says which one it came
through, because they do not prove the same thing.

A person signs in with GitHub once, so the server can check `permissions.push`
on the repository being submitted and read the login it is answering for. The
token is discarded immediately and written nowhere; the login is kept, because
it is what the quotas count against. GitHub answered for the same account that
authorised Palomar, so one account both can push and identified itself.

An agent has no browser, and drives a tag at the submitted commit plus a secret
gist carrying the same challenge. Creating a ref needs the same write access;
the gist supplies an identity, because a ref records no author and a third party
cannot ask GitHub who has push. That establishes that someone who can push
submitted the repository and that an account named itself, which are not
provably the same account, so the record carries `separately-attested` rather
than `same-account` and the two are not treated as equivalent anywhere.

Afterwards the only way back to a submission is its access token. On the agent
path there is no link to put it in, so `/api/verify` returns it in the response
body. On the browser path it is carried after the `#`, because a browser leaves
that part out of the requests it makes, so it does not reach an access log or a
`Referer` header.
The status page does send it to Palomar once, in the body of a `POST`, to
exchange it for a short-lived cookie. Saying it is "never sent to a server"
would be wrong, and the page does not say so: it says to treat the link like a
password, which is the part a submitter can act on.

Push access is not authorship. It does not establish approval from the
responsible authors of a substantive formalization, and does not replace the
declaration a submitter makes about that.

## Configuration

Variables live in `wrangler.jsonc`. Secrets are set with `wrangler secret put`
and never appear in the repository:

| Secret | What it is | Reach |
| --- | --- | --- |
| `OAUTH_CLIENT_ID` | GitHub OAuth App client id, for the push-access check | — |
| `OAUTH_CLIENT_SECRET` | its client secret | — |
| `GITHUB_TOKEN` | writes submission state, asks the reviewer to run, and reads public repository metadata for the repository being submitted | `PalomarSubmissionState`, contents and actions, plus public reads |
| `SUBMISSION_TOKEN` | starts and reads verification runs, and reads the submitter's public ref and gist while checking a proof | `PalomarSubmission`, actions, plus public reads |
| `TOKEN_PEPPER` | so a leaked state repository does not yield live links | — |

Two GitHub tokens, not one, because a fine-grained token grants the same
permissions to every repository it names. A single token covering both
repositories would carry write access to the verification code itself, and this
server is internet-facing and takes untrusted input: a leaked secret would
become a way to forge mechanical verification. Neither token needs admin
anywhere, and neither can touch `PalomarDatabase`.

## The verification run

Dispatching a workflow does not return a run id, so the server finds the run it
started by name: the workflow's `run-name` is `Verify submission <id>`. The
submission id is public, so anyone able to dispatch that workflow can produce a
run carrying it. The name is therefore matched exactly, and the run is pinned
the first time it is seen and never replaced. The reviewer accepts only the
pinned run id, so the name is not the trust boundary in either place.

## Consent

Registration is the submitter's decision and nobody else's. `/register` records
consent together with the digest of the review the submitter was shown, and the
reviewer refuses to register anything whose bytes differ, so a revised review
needs fresh consent rather than inheriting the old. Withdrawing leaves no public
trace of the review or the decision. Only an accepted review under the current
review contract can be registered; an older in-flight review must be rerun.

## The state a submission holds

```text
submissions/<id>/state.json   # the record: status, source, authorization, run, consent
submissions/<id>/review.json  # the private review, once delivered
index/tokens/<digest>.json    # access token digest to submission id
index/rate/<digest>.json      # how long this submitter waits before starting again
index/inflight.json           # admission slots, released by cron reconciliation
index/open.json               # the reviewer's queue: added here, pruned there
index/review-timing.json      # how long recent reviews took, for the estimate
pending/<digest>.json         # a one-time intake nonce, consumed at the OAuth
                              #   callback or at /api/verify, swept after an hour
```

`index/inflight.json` has exactly one top-level field, `open`, and no versioned
pre-launch variants. Each entry has exactly `id`, `owner`, `submitter`, and
`at`. The id is the current 12-character lowercase submission id; owner and
submitter are GitHub logins (`owner` may be `null`); and `at` is a UTC timestamp
at whole-second precision. Duplicate ids, missing or extra fields, noncanonical
timestamps, and a missing file stop admission and reconciliation visibly. They
are not coerced to an empty list or treated as if the repository owner were the
submitter.

`index/open.json` is likewise required. The server consumes only its
`schema_version: 1` marker and an `open` array of unique current submission ids.
Every other top-level field belongs to the reviewer: the server preserves it on
append without interpreting its shape or timestamp precision. A missing or
malformed queue is never replaced as though it were empty.

The pure intake normalization and validation live in `src/intake-contract.js`;
admission caps and rate-record projection live in `src/admission-contract.js`;
the checks for these indexes, the current review marker, and the
submitter-visible review projection live in `src/state-contract.js`. The Worker
in `src/index.js` remains the composition root for body decoding, responses,
reads, optimistic writes, authorization, and ordering; contract code does not
perform I/O.

Before pointing a fresh or staging Worker at a new state repository, copy the
two files in `state-bootstrap/index/` to `index/` and commit them. Deploying the
Worker before that initialization deliberately leaves intake unavailable; it
does not silently grant unbounded capacity.

These files are separate GitHub commits, not a transaction. Validation and
compare-and-swap writes prevent a known-bad index or a concurrent edit from
being silently overwritten, but a conflict after an earlier commit can leave a
partial admission or decision. A later request can retry an entry whose
reservation remains in flight; other partial states require an operator.

`index/open.json` holds every submission the reviewer is not yet finished with.
This server adds an id when it admits one, and the reviewer drops one when the
record says there is nothing left to do to it, so a reviewer pass costs the
queue rather than the size of the registry. The reviewer can rebuild this
derived queue from the records on its maintenance path, but the server does not
silently reconstruct or overwrite it. A missing or malformed queue makes intake
and affected status transitions unavailable until the reviewer or an operator
restores it.

`index/rate/<digest>.json` slows down a submitter who keeps starting and never
finishes. Starting is the expensive act: it dispatches a verification run that
takes a quarter of an hour of somebody's runners whether or not anything comes
of it. So the interval is sixty seconds to begin with, doubles every time a
submission is started, and is put back to that floor only by a completed
registration. A submission that fails verification, or is withdrawn, leaves it
where it is, because those are exactly the loops worth slowing down.

There is no ceiling, and that is deliberate rather than an omission to fix.
Twenty starts with nothing registered is already years; nobody submitting in
good faith reaches it, and the failure worth designing for is the other one, a
person locked out with no way back on their own. The escape hatch is an operator
deleting one file, which is why the file records the login and the time beside
the interval even though its name is a peppered digest of the principal. The
name is a digest for the same reason `index/tokens/` is: listing the directory
should not enumerate everyone who has ever submitted.

This server applies the reset, not the reviewer, even though the reviewer is
what registers. It sees the reset when a status refresh finds the submission
settled at `registered`, so the good news and the reset arrive on the same
request. Letting the reviewer do it would put `TOKEN_PEPPER` in reviewer CI, and
that pepper exists so a leaked state repository yields no live links. Somebody
who closes the tab between consenting and that poll waits longer once, and
opening the link again fixes it.

## Operating a submission

The scheduled workflow in the private PalomarSubmissionState repository runs
`palomar-review auto`, which is one command that advances everything in the
queue. The commands below are the manual and recovery interface for the same
pipeline, one submission at a time.

```bash
palomar-review list                                  # what is awaiting review
palomar-review run --submission <id> --engine codex  # writes no state
palomar-review run --submission <id> --engine codex --apply   # deliver privately
# the submitter decides, on their status page
palomar-review register --submission <id>             # only after consent
palomar-review finalize --submission <id> --pr <n>   # after the database PR merges
```

`run` without `--apply` still runs the review: it calls the model, spends money,
and writes a workspace. What it does not do is touch the state repository, which
is the only thing `--apply` adds.

## Deploying

Pushes to `main` are deployed automatically after the test suite passes. The
GitHub repository must provide `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` as Actions secrets. CI uploads and promotes a version;
it does not change the existing route or cron trigger.

The Worker imports no package from npm at runtime. The locked npm graph is
development tooling: Wrangler and the Miniflare/workerd stack it uses to develop,
bundle and deploy the Worker. That still handles source code and, during the
deployment steps, runs next to production credentials, so CI rejects every
low-or-higher advisory in the complete development graph. A least-permission
weekly workflow repeats that registry audit directly from the lockfile, without
running dependency install hooks, so an advisory published after the last code
change does not wait for another pull request; it can also be run manually.

Before the first deployment against a State repository, commit both files from
`state-bootstrap/index/` as described above. Admission and scheduled
reconciliation validate the contracts before using them; `/healthz` stays a
network-free configuration check so public monitoring cannot spend the shared
GitHub API budget.

To deploy manually:

```bash
npm ci
npm run audit:dependencies
npm test
npx wrangler deploy --dry-run
npx wrangler deploy
curl -s https://submit.palomar-registry.org/healthz
```

The separate, secret-free `palomar-domain-redirect` Worker owns
`palomarregistry.org` and `www.palomarregistry.org`. It permanently redirects
every path and query string to the same URL at `palomar-registry.org`:

```bash
npx wrangler deploy --config redirect/wrangler.jsonc --dry-run
npm run deploy:redirect
curl -sSI https://palomarregistry.org/about.html
```
