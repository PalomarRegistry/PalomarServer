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

## Who may submit

Push access, and nothing else, today.

There is a second rule in the source, off in `wrangler.jsonc` and switched on by
naming the signals it should count. It asks that somebody who has already
registered a result in Palomar has been near the repository being submitted: a
star, a fork, an issue, a pull request, a comment, or a commit, any one of them
from any one of those people. Push access says a submitter may speak for a
repository; this asks whether the repository exists outside the submission. It
is a limit on how fast Palomar opens up rather than a judgement about anything,
and it is meant to come off.

Somebody who has already registered a result is not asked again, which is what
`SUBMISSION_ENDORSEMENT_SELF` is for: `exempt` is that, and `excluded` keeps
asking them and stops their own star being the answer. The trade is that under
`exempt` one registered result unlocks every repository its author can push to,
for good, and under `excluded` a returning submitter with a new repository
nobody has found yet is turned away.

Who counts is `index/endorsers.json` in the state repository, which has two
halves. `registered` is derived: `palomar-review` adds a submitter when their
result registers, and `palomar-review rebuild-endorsers` rederives the whole
thing from the records less anything the database has taken down. A takedown is
the registry's retraction and nothing propagates it back to the private record,
so until that sweep runs a withdrawn result still lets repositories in. Run it
after a takedown.

`allowed` is written by hand and nothing derives it. It is how somebody counts
before they have registered anything, and it is not a nicety: with `registered`
empty the rule refuses everybody, including the people whose submissions would
have filled it in. So a rule that is on with nobody to name is treated as a
deployment fault and answers 503, whether the file is missing or merely empty,
rather than telling every submitter in turn that their repository is the
problem. The same goes for a signal name that does not exist: it would leave the
rule off, which is not a narrower rule but no rule at all, so it stops the
deployment instead.

An entry is a `login`, an `id`, or both. Prefer both. A login is renameable and
the account that later takes an abandoned one is a different person with the
same name, so the id is what makes an entry survive a rename; a login alone is
matched by name, without regard to case, which is what makes the hand-written
half usable by somebody who has a name and not a number.

Reading is bounded: five pages of a hundred per list, run together, stopping at
the first person found. A list GitHub will not answer, or one longer than that,
is not an absence: the submission is admitted and its record says `unchecked`
and why. Turning a bad minute at GitHub into a refusal aimed at somebody who did
nothing wrong is the worse failure, and the rate limit and the admission caps
are still in front of whatever comes next.

## Configuration

Variables live in `wrangler.jsonc`, each with the reason for its value beside
it. Two of them decide policy rather than naming a repository:

| Variable | What it does |
| --- | --- |
| `SUBMISSION_ENDORSEMENT` | which kinds of engagement let a repository be submitted at all, from `star`, `fork`, `issue`, `pull-request`, `comment`, `commit`. Empty is off, and off is what Palomar runs. A name that is not on that list fails `/healthz`, so a typo cannot look like the rule working |
| `SUBMISSION_ENDORSEMENT_SELF` | `exempt` to stop asking somebody who has already registered a result, or `excluded` to keep asking and to stop their own engagement being the answer |

Secrets are set with `wrangler secret put` and never appear in the repository:

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

`index/open.json` holds every submission the reviewer is not yet finished with.
This server adds an id when it admits one, and the reviewer drops one when the
record says there is nothing left to do to it, so a reviewer pass costs the
queue rather than the size of the registry. It is derived rather than
authoritative: an index that is missing, damaged, or too old is rebuilt from
every record, so losing this file costs one rebuild and no submissions.

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

To deploy manually:

```bash
npm test
npx wrangler deploy
curl -s https://submit.palomar-registry.org/healthz
```

The separate, secret-free `palomar-domain-redirect` Worker owns
`palomarregistry.org` and `www.palomarregistry.org`. It permanently redirects
every path and query string to the same URL at `palomar-registry.org`:

```bash
npm run deploy:redirect
curl -sSI https://palomarregistry.org/about.html
```
