# Palomar submission server

A Cloudflare Worker that takes submissions, establishes either that whoever
submitted can push to the repository or that an active Technical Maintainer is
running a non-registerable workflow test, and keeps every durable fact in GitHub.

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

An access token is the ordinary way back to a submission. On the agent path
there is no link to put it in, so `/api/verify` returns it in the response body.
On the browser path it is carried after the `#`, because a browser leaves that
part out of the requests it makes, so it does not reach an access log or a
`Referer` header.
The status page presents its fragment as an `Authorization: Bearer` header on
each private request and explicitly omits cookies. The fragment belongs to the
page rather than the browser profile, so two submissions open at once cannot
replace one another's credential. Saying it is "never sent to a server" would
still be wrong, and the page does not say so: it says to treat the link like a
password, which is the part a submitter can act on.

Losing the link is not permanent while a submission remains in the open-work
queue. `/submissions`, also linked from the submission form, starts a separate
recovery sign-in. GitHub identifies the same numeric account id recorded in the
original proof; Palomar then shows
every matching open submission and rotates one recovery token for each. The
original token remains valid. Numeric identity, not a reusable login, is the
authority: GitHub logins can be renamed and later reused.

After a successful browser OAuth callback, Palomar also sets a signed,
host-only identity cookie for twelve hours. It contains the account's numeric
id, login, and expiry, but no GitHub access token; the OAuth token is still used
only during the callback and discarded. The submission form uses that local
identity to list matching open-work metadata automatically. Listing is
read-only. Choosing **Open this submission** rotates the recovery capability
for only that submission, so merely loading the form neither writes State nor
invalidates a previously recovered link. An absent or expired identity cookie
falls back to the ordinary `/submissions` OAuth flow.

For a completed verification failure, the browser reads the public run's job
and check annotations directly from `api.github.com` so it can show the actual
error beside the run link. Those bounded requests carry neither a GitHub
credential nor the Palomar cookie or fragment, and the site's `no-referrer`
policy keeps the private status URL out of them.

The browser status page previously used a single `__Host-` cookie. Although it
was protected from sibling hosts, every tab on this host shared it; opening a
second submission therefore changed what the first tab read. Current status
pages use only their own fragment capability for private reads and actions. The
server still honours `/session` cookies for legacy clients, but current pages
neither create nor send them.

The short-lived cookie that binds a browser OAuth callback to the tab that
started it has the same host-only properties and a different name for every
pending intake. Only the callback consumes the exact nonce-derived name, and an
ambiguous or case-confusable protected name, or a malformed binding, is refused
before it can read or consume pending State.

Push access is not authorship. It does not establish approval from the
responsible authors of a substantive formalization, and does not replace the
declaration a submitter makes about that.

Every browser submission requests read-only `read:org` visibility and checks
whether its authenticated account is an active member of
`PalomarRegistry/technical-maintainers`. Active Technical Maintainers bypass the
ordinary per-principal start interval and the owner and submitter in-flight caps
for every submission, independently of the authorization relationship selected
on the form. The durable OAuth proof records that membership.

When an active member submits a public repository and pinned commit without
write access, the browser path automatically records it as a technical test.
The explicit technical-test relationship reaches the same path. Its durable
record says `test_submission`, does not claim `push_verified`, and carries a
distinct team-membership proof. The agent intake cannot use either
membership-based exception because its tag-and-gist proof does not establish
team membership. The pre-authentication address throttle still applies because
the account is not known until OAuth completes.

## Private operational dashboard

`/dashboard` shows aggregate submission throughput, review-round counts,
landing distributions, and bounded model-spend distributions. It never reads a
review or serves a submission id, repository, Comparator path, commit, or
submitter identity. The State reporting workflow derives
`reports/dashboard.json` in a daily or manually dispatched full sweep; the page
reads that one private file and identifies the exact immutable State
`submissions/` tree and latest event included, so lag is visible rather than
disguised as current data.

Dashboard sign-in uses the existing GitHub OAuth application with the additional
read-only `read:org` scope. The callback requires an active membership in the
closed `PalomarRegistry/technical-maintainers` team, discards the GitHub token
immediately, and issues a signed host-only session lasting fifteen minutes.
GitHub OAuth grants scopes cumulatively per application, so a maintainer who
has granted `read:org` may also receive it on a later intake token; every such
token is still single-use here and is discarded rather than stored.
Removing a maintainer therefore takes effect no later than that expiry. The
signature is domain-separated from submission-token digests while reusing the
existing `TOKEN_PEPPER`; there is no additional secret or durable login store.
The OAuth state and session cookie both reject duplicates and are never cached.
Dashboard OAuth initiation and callback share the intake address limiter, so an
unauthenticated loop cannot turn into unbounded GitHub token exchanges. Every
dynamic OAuth response carries the same no-referrer and security headers as the
rest of the Server. The API additionally requires a same-origin browser request;
the OAuth landing page itself remains a top-level cross-site navigation.

The machine-readable aggregate is available at `/api/dashboard` under the same
session. The Server validates that the stored document has the identity-free
dashboard contract with an exact field-name allowlist and deep value shapes,
instead of trying to spot a few forbidden identity fields. The contract is
represented by versioned aggregate fixtures retained as backward-compatibility
examples, not as evidence about current producer output. Pull-request CI runs
the current consumer against every dashboard fixture from the base commit, so
editing a fixture cannot disguise a backward-incompatible change.
State CI runs its real producer output through this repository's
consumer, while Server CI proves that a candidate still accepts every schema
version retained by its base commit. Together those two directions prevent
either repository from crossing the contract boundary alone, without granting
the public Server repository access to private State. The page and API link
directly to the private Database's one-person Moderator forms for takedown and
restoration. Those links are operator conveniences, not State data.

Dashboard contracts are append-only by `schema_version`. A new required field,
removed field, changed literal, or narrowed value shape requires a new schema
version. Deploy the Server consumer accepting both versions first; only then
change State to emit the new version. Keep the earlier consumer until no stored
report uses it. Corrections that make a producer conform to its already-declared
schema do not create a new version.

## Configuration

Variables live in `wrangler.jsonc`. Secrets are set with `wrangler secret put`
and never appear in the repository:

| Secret | What it is | Reach |
| --- | --- | --- |
| `OAUTH_CLIENT_ID` | GitHub OAuth App client id, for submission push-access and dashboard team checks | — |
| `OAUTH_CLIENT_SECRET` | its client secret | — |
| `GITHUB_TOKEN` | reads and atomically advances submission State, asks the reviewer to run, and reads public repository metadata for the repository being submitted | `PalomarSubmissionState`, contents and actions, plus public reads |
| `SUBMISSION_TOKEN` | starts and reads verification runs, and reads the submitter's public ref and gist while checking a proof | `PalomarSubmission`, actions, plus public reads |
| `TOKEN_PEPPER` | so a leaked state repository does not yield live links, and to authenticate short-lived GitHub identity cookies under a domain-separated HMAC key | — |

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
rerun. A technical-team test can reach the same accepted-review screen, but its
registration control is disabled with an explanation. `/register` and the
reviewer independently refuse it, and State validation reports any test record
edited by hand to carry consent or registration state. Test submissions also
cannot request an automated metadata-repair pull request.

## The state a submission holds

```text
submissions/<id>/state.json   # the record: status, source, authorization, run, consent
submissions/<id>/review.json  # the private review, once delivered
index/tokens/<digest>.json    # original or recovery token digest to submission id
index/principals/<digest>.json # private submission locator for one submitter
index/rate/<digest>.json       # how long this submitter waits before starting again
index/inflight.json           # admission slots, released by cron reconciliation
index/open.json               # the reviewer's queue: added here, pruned there
index/review-timing.json      # how long recent reviews took, for the estimate
pending/<digest>.json         # a one-time intake nonce; an OAuth submission may
                              #   retain its proved identity until the choice,
                              #   and a record older than fifteen minutes is
                              #   refused on read and swept on the next pass
```

`index/inflight.json` has exactly one top-level field, `open`, and no versioned
pre-launch variants. Each entry has exactly `id`, `owner`, `submitter`, and
`at`. The id is the current 12-character lowercase submission id; owner and
submitter are GitHub logins (`owner` may be `null`); and `at` is a UTC timestamp
at whole-second precision. Duplicate ids, missing or extra fields, noncanonical
timestamps, and a missing file stop admission and reconciliation visibly. They
are not coerced to an empty list or treated as if the repository owner were the
submitter.

The index enforces at most two active verifications for one repository owner
and at most one for one submitter. It deliberately has no global admission cap:
existing work by unrelated people cannot make intake refuse everyone. The edge
address throttle and the submitter's exponentially increasing start interval
remain independent controls.

`index/open.json` is likewise required. The server consumes only its
`schema_version: 1` marker and an `open` array of unique current submission ids.
Every other top-level field belongs to the reviewer: the server preserves it on
append without interpreting its shape or timestamp precision. A missing or
malformed queue is never replaced as though it were empty.

Recovery first reads the authenticated principal's pepper-keyed locator,
then intersects its submission ids with the current reviewer queue. It reads
only that person's current records rather than fanning out across the shared
queue, checks every stored numeric principal id, and atomically rotates their optional
`recovery_token_sha256` pointers. Repeated recovery therefore costs current
work rather than registry history and retains at most one recovery pointer per
submission. It neither invalidates the original pointer nor makes a login name
an authority.

Each locator contains exactly `schema_version: 1` and a unique `submissions`
array. Admission appends to it atomically with the new submission; terminal ids
may remain because recovery intersects it with `index/open.json` before reading
records. Submissions from an OAuth-verified Technical Maintainer use the same
locator without acquiring the ordinary submitter backoff or in-flight caps.

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

A browser submission pauses after OAuth when that submitter already has open
work. The choice page includes fresh links to all of it. When a matching
repository is selected for replacement, withdrawing the earlier record,
exchanging any admission slot, consuming the pending OAuth proof, admitting the
new record, and updating both queues happen in the same transaction. A rate or
capacity refusal writes none of those changes, so “start the new one” cannot
strand the earlier submission halfway through the choice.

The external verification dispatch cannot be part of a Git commit. A newly
committed `verifying` record therefore doubles as a durable outbox item and
carries a short dispatch lease. The admitting request tries immediately. The
ten-minute lifecycle first searches for the workflow run (covering a crash
after GitHub accepted an ambiguous dispatch), then one reconciler claims an
expired lease and retries. It does not release capacity or declare the dispatch
lost merely because a credential or provider outage needs repair. After three
complete searches and dispatch attempts, an undiscoverable run is irrecoverable:
the scheduled pass records the Palomar-owned `dispatch-lost` status before
releasing its slot. A
pinned run that GitHub confirms is gone is handled the same way and is never
replaced by a namesake dispatch. Queued or running work remains reserved without
an age timeout.

The full workflow performs authoritative preparation before installing its
verification-only toolchain. A failed run first enters a reporting status; the Reviewer ingests the exact
run's artifact and atomically records bounded, owner-labelled diagnostics before
the status page treats the result as terminal.

Before pointing a fresh or staging Worker at a new state repository, copy the
three files in `state-bootstrap/index/` to `index/` and commit them. Deploying the
Worker before that initialization deliberately leaves intake unavailable; it
does not silently disable the owner and submitter limits.

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

`index/repairs.json` is a separate durable outbox for submitter-authorized
metadata repairs. `POST /api/repair` requires the submission capability, the
digest of the current failure, a `changes-required` record, and fields explicitly
marked repairable in that failure. It atomically writes the request, its queue
entry, and the record marker. Profile 2 covers every mechanically required
metadata field, including structured people, source, and automation lists, and
requires one complete submitter-confirmed payload before it queues a pull
request. Safe values from an older metadata shape may be shown as editable
prefills, but classifications, maintainers, source relationships, repository
roles, and review claims are never inferred. Malformed YAML, non-mapping roots,
aliases, unsafe paths, and mixed unsupported failures remain manual-only.

`index/rate/<digest>.json` slows down a submitter who keeps starting and never
finishes. Starting is the expensive act: it dispatches a verification run that
takes a quarter of an hour of somebody's runners whether or not anything comes
of it. So the interval is sixty seconds to begin with, doubles every time a
submission is started, and is put back to that floor only by a completed
registration or by one of the first two preparation failures that asks for repository
changes. Later metadata failures keep the accumulated interval, so the
correction concession cannot turn repeated preparation work into an unbounded
cheap loop. A submission
that fails full verification, or is withdrawn, leaves it where it is, because
those are exactly the loops worth slowing down; ordinary metadata correction is
not treated as abuse.

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
`CLOUDFLARE_API_TOKEN` as Actions secrets. The Cloudflare dashboard credential
stored under that secret is named exactly **palomar worker deployment token**.
It is not **PalomarDatabaseTools GitHub deploy**, which is a separate credential
owned by a different repository. **palomar worker deployment token** must not
have **Workers Routes: Edit**: this deployment deliberately uploads and promotes
versions without changing the existing route. Before uploading a version, CI
reapplies the reviewed Worker hostname policy; it then uploads and promotes
that version. The version workflow does not change the existing route or cron
trigger.

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

Before the first deployment against a State repository, commit all three files from
`state-bootstrap/index/` as described above. Admission and scheduled
reconciliation validate the contracts before using them; `/healthz` stays a
network-free configuration check so public monitoring cannot spend the shared
GitHub API budget.

Merge the State reporting change and run `Refresh private operational report`
to create `reports/dashboard.json` on State `main` before merging this Server
change. A Server merge deploys automatically; if the report is not ready, the
authenticated route fails closed with a typed 503 until it appears. No OAuth
application callback change is needed: dashboard and intake both return through the existing
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

## Classification snapshots

The guided metadata form serves the checked-in arXiv and MSC 2020 taxonomy
snapshots from `public/taxonomies/`. Their sources, retrieval date, and
third-party licensing terms are recorded in `public/taxonomies/LICENSE.md`.
Keep that notice with the assets when updating or redistributing them.
