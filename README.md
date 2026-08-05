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
- **Never public unless the author publishes:** the review, the decision, and
  the submitter's identity.
- **"Private" means not public, not confidential.** Reviews are readable by
  operators, GitHub, and the model provider, and are kept indefinitely.

## Identity

There is no account. The submitter signs in with GitHub once, purely so the
server can check `permissions.push` on the repository being submitted, and the
token is discarded immediately. Afterwards the only way back to a submission
is the link, whose secret lives in the URL fragment so it never reaches a
server log or a `Referer` header.

Push access is not authorship. It does not establish approval from the
responsible authors of a substantive formalization, and does not replace the
declaration a submitter makes about that.

## Configuration

Variables live in `wrangler.jsonc`. Secrets are set with `wrangler secret put`
and never appear in the repository:

| Secret | What it is |
| --- | --- |
| `OAUTH_CLIENT_ID` | GitHub OAuth App client id, for the push-access check |
| `OAUTH_CLIENT_SECRET` | its client secret |
| `GITHUB_TOKEN` | writes submission state and dispatches verification |
| `TOKEN_PEPPER` | so a leaked state repository does not yield live links |

## Status

Intake, push proof, state, and the status page are built and deployed.
Verification dispatch is wired but cannot complete until the mechanical
pipeline accepts a submission that has no GitHub issue behind it: the report
schema, the reviewer, and the database schema all key on an issue number
today. That is tracked as the schema-v7 work.
