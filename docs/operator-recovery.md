# Retry an admitted verification

Use an authenticated, allowlisted Technical Maintainer `gh` account. Preview:

```sh
node tools/retry-verification.mjs --id SUBMISSION_ID --reason 'Provider failure investigated'
```

Add `--apply` to atomically archive the failed attempt, reserve normal concurrency
slots, and queue a fresh attempt. The existing server dispatcher starts it on its
next maintenance pass. The command does not alter source, paths, authorization,
consent, or admission backoff. It refuses withdrawn and active submissions.
The new execution receives a fresh rendering-attempt budget, while any existing
review retry deadline remains in force.
The admission timestamp comes from the authenticated GitHub response, avoiding
operator clock skew in run discovery. The attempt ID returned by an applied command is the durable audit identifier;
a preview generates a provisional ID and does not reserve work.

The default is the qualified `palomar-namespace-16x32-v1` profile, matching the
Submission workflow's current default. Use `--profile palomar-standard-v1` only
when the smaller GitHub-hosted worker is appropriate for this workload. The
retired `PALOMAR_NAMESPACE_ENABLED` variable is not consulted.

A CAS conflict commits no retry. Rerun the preview against current State. An
unknown GitHub ref-update outcome must be investigated by reading the current
execution attempt before trying again; do not directly dispatch a workflow.
The command leaves the actual dispatch to the durable server outbox.

Deploy State schema readers and the promoted Reviewer runtime before deploying
the server or using this command. The verifier workflow must support the new
execution inputs and attempt-suffixed run name before an operator queues work.
