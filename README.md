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

Browser status sessions use a `__Host-` cookie: it is secure, scoped to `/`,
and has no `Domain` attribute. Browsers therefore do not let a sibling host set
or shadow that credential, and the server refuses an ambiguous request carrying
the session-cookie name more than once.

The short-lived cookie that binds a browser OAuth callback to the tab that
started it has the same host-only properties and a different name for every
pending intake. Only the callback consumes the exact nonce-derived name, and an
ambiguous or case-confusable protected name, or a malformed binding, is refused
before it can read or consume pending State.

Push access is not authorship. It does not establish approval from the
responsible authors of a substantive formalization, and does not replace the
declaration a submitter makes about that.

## Private operational dashboard

`/dashboard` shows aggregate submission throughput, review-round counts,
landing distributions, and bounded model-spend distributions. It never reads a
review or serves a submission id, repository, Comparator path, commit, or
submitter identity. The State reporting workflow derives
`reports/dashboard.json` after State changes and hourly as a backstop; the page
reads that one private file and identifies the exact immutable State
`submissions/` tree and latest event included, so lag is visible rather than
disguised as current data.

Dashboard sign-in uses the existing GitHub OAuth application with the additional
read-only `read:org` scope. The callback requires an active membership in the
closed `PalomarRegistry/technical-maintainers` team, discards the GitHub token
immediately, and issues a signed host-only session lasting fifteen minutes.
Removing a maintainer therefore takes effect no later than that expiry. The
signature is domain-separated from submission-token digests while reusing the
existing `TOKEN_PEPPER`; there is no additional secret or durable login store.
The OAuth state and session cookie both reject duplicates and are never cached.

The machine-readable aggregate is available at `/api/dashboard` under the same
session. The Server validates that the stored document has the identity-free
dashboard contract and specifically refuses the complete private report's
`targets` section.

## Configuration

Variables live in `wrangler.jsonc`. Secrets are set with `wrangler secret put`
and never appear in the repository:

| Secret | What it is | Reach |
| --- | --- | --- |
| `OAUTH_CLIENT_ID` | GitHub OAuth App client id, for the push-access check | — |
| `OAUTH_CLIENT_SECRET` | its client secret | — |
| `GITHUB_TOKEN` | reads and atomically advances submission State, asks the reviewer to run, and reads public repository metadata for the repository being submitted | `PalomarSubmissionState`, contents and actions, plus public reads |
| `SUBMISSION_TOKEN` | starts and reads verification runs, and reads the submitter's public ref and gist while checking a proof | `PalomarSubmission`, actions, plus public reads |
| `TOKEN_PEPPER` | so a leaked state repository does not yield live links | — |

The State token's existing repository `Contents: write` grant covers the Git
tree, commit, and non-forced reference update used for atomic admission; it
does not need repository-administration permission.

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
needs fresh consent rather than inheriting the old. Withdrawing before consent
leaves no public trace of the review or the decision. After consent, the reviewer
still refuses to merge a withdrawn record, but source-preservation or rendering
work that already started may remain public. Only an accepted review under the
current review contract can be registered; an older in-flight review must be
rerun.

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
submitter-visible review projection live in `src/state-contract.js`; and exact
request credential transport and origin classification live in
`src/request-credentials.js`. These four modules do not perform I/O. Validated
shared-index reads, reviewer-queue appends, admission-slot release and
reconciliation writes, verification reconciliation, and abandoned-intake
cleanup live in `src/submission-lifecycle.js`. The Worker in `src/index.js`
remains the composition root: it decides which routes require credentials and
owns body decoding, responses, authorization, request-path record and rate
reads and optimistic writes, the admission-slot append, and route-level
ordering.

Admission uses GitHub's Git Data API as a transaction boundary. The Worker
reads the pending proof, rate record, capacity index, reviewer queue, and the
two create-only paths at one exact `main` commit. One derived tree then consumes
the proof and writes the submission record, capacity reservation, reviewer
queue entry, token index, and rate update. A non-forced ref update publishes all
of them together. If another writer moved `main`, the update is rejected and
the complete decision is recomputed from the new head; unreachable losing tree
and commit objects never become State. Policy refusals publish only the proof
deletion. Damaged or unavailable State publishes nothing and leaves an agent's
proof retryable within its reported attempt budget. If a ref-update response
and the follow-up reachability checks are all unavailable, the Worker reports
the outcome as unknown instead of claiming that the proof survived.

The external verification dispatch cannot be part of a Git commit. A newly
committed `verifying` record therefore doubles as a durable outbox item and
carries a short dispatch lease. The admitting request tries immediately. The
ten-minute lifecycle first searches for the workflow run (covering a crash
after GitHub accepted an ambiguous dispatch), then one reconciler claims an
expired lease and retries. It does not release capacity or declare the dispatch
lost merely because a credential or provider outage needs repair. Retries stop
after three dispatch attempts and make the scheduled pass fail loudly while
retaining the record and its slot; a pinned run that disappears is likewise
never replaced by a namesake dispatch.

Before pointing a fresh or staging Worker at a new state repository, copy the
two files in `state-bootstrap/index/` to `index/` and commit them. Deploying the
Worker before that initialization deliberately leaves intake unavailable; it
does not silently grant unbounded capacity.

Admission is the multi-file transaction described above. Later lifecycle and
submitter decisions remain ordered Git commits rather than one global
transaction: their operations are idempotent or deliberately leave an earlier
durable state that the next request or scheduled pass can finish. Git State
continues to be the auditable source of truth; no separate coordinator or
export process is required.

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

The Server owns the rate document's current `schema_version: 1` contract. A
present document records a GitHub `login`, positive integer `starts`, an integer
`interval_seconds` of at least sixty, and canonical UTC-seconds
`last_start_at` and `next_allowed_at` timestamps. The State repository's
whole-tree validator deliberately treats these producer-owned fields as opaque,
so the Server validates all of them before admission and before projecting a
reset. A missing file is a first start; a malformed present file makes intake
temporarily unavailable rather than silently granting the floor. A malformed
file also leaves a registration reset unapplied until repair, but does not hide
the already-registered result from its submitter.

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
`CLOUDFLARE_API_TOKEN` as Actions secrets. Before uploading a version, CI
reapplies the reviewed Worker hostname policy; it then uploads and promotes that
version. The version workflow does not change the existing route or cron trigger.

The Worker imports no package from npm at runtime. The locked npm graph is
development tooling: Wrangler and the official Vitest pool's Miniflare/workerd
stack used to test, bundle, and deploy the Worker. That still handles source
code and, during the deployment steps, runs next to production credentials, so
CI rejects every low-or-higher advisory in the complete development graph. A
least-permission weekly workflow repeats that registry audit directly from the
lockfile, without running dependency install hooks, so an advisory published
after the last code change does not wait for another pull request; it can also
be run manually. The required audit includes the runtime test harness and its
Vitest graph, so an advisory there also blocks deployment.

`npm test` remains the fast Node contract suite. `npm run test:runtime` is the
small required integration layer: it loads both real Wrangler configurations
in workerd, invokes the actual Worker entrypoints, and intercepts representative
GitHub traffic at the runtime `fetch` boundary. CI requires both before the
deployment job can run; its runtime tests receive dummy required bindings, no
credentials, and no remote services. An outbound-service guard refuses any
request that a test does not explicitly intercept. The pinned workerd/Vitest
graph requires Node 22.12 or later. When advancing a Worker's compatibility
date, also advance the pinned Wrangler when needed so its local workerd supports
that date.

`npm run lint` applies the locked ESLint recommended correctness rules to every
shipped Worker and browser module, the Node and workerd tests, and their
JavaScript configuration. It catches invalid or unreachable code, unresolved
globals, and unused bindings across those environments. This is deliberately a
lint gate, not a claim that the untyped JavaScript has been statically
type-checked; it parses import declarations but does not resolve their targets.
The lint packages are part of the complete audited development graph described
above, so a future low-or-higher advisory in that graph also blocks deployment.

Before the first deployment against a State repository, commit both files from
`state-bootstrap/index/` as described above. Admission and scheduled
reconciliation validate the contracts before using them; `/healthz` stays a
network-free configuration check so public monitoring cannot spend the shared
GitHub API budget.

Do not deploy the dashboard routes until the State reporting change has merged
and `Refresh private operational report` has successfully created
`reports/dashboard.json` on State `main`. No OAuth application callback change
is needed: dashboard and intake both return through the existing
`/oauth/callback`, and their bound state values are disjoint.

To deploy manually:

```bash
npm ci
npm run audit:dependencies
npm run lint
npm test
npm run test:runtime
npx wrangler deploy --dry-run
npx wrangler deploy
curl -s https://submit.palomar-registry.org/healthz
```

Both Worker configurations explicitly disable `workers.dev` and versioned or
aliased preview URLs. The reviewed hostnames are their only public routes; do
not enable another hostname without giving it the same exposure review. The
main deployment applies just this account-level hostname policy before every
version upload, while the redirect deployment applies its complete configuration
through `wrangler deploy`.

The separate, secret-free `palomar-domain-redirect` Worker owns
`palomarregistry.org` and `www.palomarregistry.org`. It permanently redirects
every path and query string to the same URL at `palomar-registry.org`:

```bash
npx wrangler deploy --config redirect/wrangler.jsonc --dry-run
npm run deploy:redirect
curl -sSI https://palomarregistry.org/about.html
```
