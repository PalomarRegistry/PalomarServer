# Palomar submission server

A Cloudflare Worker that takes submissions, proves the submitter can push to
the repository they are submitting, and keeps every durable fact in GitHub.

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

- **Public from the moment you submit:** the repository and commit.
  Verification runs in a public Actions workflow whose logs are public.
- **Never public unless the author registers:** the review, the decision, and
  the submitter's identity.
- **"Private" means not public, not confidential.** Reviews are readable by
  operators, GitHub, and the model provider, and are kept indefinitely.

## Identity

There is no account. The submitter signs in with GitHub once, purely so the
server can check `permissions.push` on the repository being submitted, and the
token is discarded immediately. Afterwards the only way back to a submission
is the link, whose secret lives in the URL fragment so it never reaches a
server log or a `Referer` header.

The key is carried after the `#` because a browser leaves that part out of the
requests it makes, so it does not reach an access log or a `Referer` header.
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
| `GITHUB_TOKEN` | writes submission state and asks the reviewer to run | `PalomarSubmissionState`, contents and actions |
| `SUBMISSION_TOKEN` | starts and reads verification runs | `PalomarSubmission`, actions |
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
index/inflight.json           # admission slots, released by cron reconciliation
pending/<digest>.json         # a one-time intake nonce, consumed at OAuth callback
```

## Operating a submission

```bash
palomar-review list                                  # what is awaiting review
palomar-review run --submission <id> --engine codex  # dry run; nothing changes
palomar-review run --submission <id> --engine codex --apply   # deliver privately
# the submitter decides, on their status page
palomar-review register --submission <id>             # only after consent
palomar-review finalize --submission <id> --pr <n>   # after the database PR merges
```

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
