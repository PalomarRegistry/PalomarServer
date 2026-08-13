/** Server-rendered pages. No submitted text is ever interpolated unescaped. */

export function escape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

export function page(env, title, body, { submitCurrent = false } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
    <meta name="theme-color" content="#101216" media="(prefers-color-scheme: dark)">
    <title>${escape(title)} — Palomar</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <link rel="stylesheet" href="/style.css">
  </head>
  <body>
    <a class="skip-link" href="#content">Skip to content</a>
    <header class="site-header">
      <a class="wordmark" href="${escape(env.SITE_URL)}" aria-label="Palomar home">Palomar</a>
      <nav aria-label="Main navigation">
        <a href="${escape(env.SITE_URL)}">Registry</a>
        <a href="${escape(env.SITE_URL)}/about.html">About</a>
        <a${submitCurrent ? ' class="active" aria-current="page"' : ""} href="/">Submit</a>
      </nav>
    </header>
    <main id="content" class="page-main">${body}</main>
    <footer class="site-footer">
      <div><span class="footer-brand">Palomar</span><span> — a registry of Lean-verified results</span></div>
      <div class="footer-links">
        <a href="${escape(env.SITE_URL)}">Registry</a>
        <a href="${escape(env.SITE_URL)}/about.html">About</a>
        <a href="https://github.com/PalomarRegistry/PalomarPolicy/blob/main/CONTRIBUTING.md">Policy</a>
      </div>
    </footer>
  </body>
</html>`;
}

export function intakeForm(
  env,
  values = {},
  problems = [],
  { automaticRecovery = false } = {},
) {
  const trouble = problems.length
    ? `<section class="disclosure problems-block" role="alert">
         <h2>That submission did not go through</h2>
         <ul class="problems">${problems.map((p) => `<li>${escape(p)}</li>`).join("")}</ul>
         <p class="hint">Everything you typed is still below.</p>
       </section>`
    : "";
  // A layout that was spelled out by hand must be visible when the form comes
  // back, or a submitter corrects one field and unknowingly reverts the rest.
  const layoutOpen = ["project_path", "formalization_metadata_path"]
    .some((name) => String(values[name] ?? "") !== "");
  const manualRegistrationOpen = String(values.existing_id ?? "") !== "";
  const approvalApplies = values.authorization_relationship === "approved";
  const recoveryAction = `<form method="get" action="/submissions">
        <button type="submit" class="secondary" id="find-submissions">Authenticate and find my submissions</button>
      </form>`;
  const recoveryContent = automaticRecovery
    ? `<div id="recovery-content">
         <p class="recovery-status" id="recovery-status" role="status">
           Checking submissions… <span class="spinner" aria-hidden="true"></span>
         </p>
       </div>
       <noscript>${recoveryAction}</noscript>`
    : `<div id="recovery-content">${recoveryAction}</div>`;
  return page(env, "Submit a result", `
    <h1>Submit a Lean-verified result</h1>
    ${trouble}
    <!-- Automated agents: read /llms.txt before submitting. -->
    <p class="lede"><strong>Before submitting, check that:</strong></p>
    <ul>
      <li>The result has credible research interest and a clear informal explanation.</li>
      <li>A public, pinned commit contains an auditable <code>Challenge.lean</code>,
          matching <code>Solution.lean</code>,
          <a href="https://github.com/leanprover/comparator">Comparator configuration</a>,
          <a href="https://github.com/mathlib-initiative/formalization.yaml"><code>formalization.yaml</code></a>,
          and a licence.</li>
      <li>You are a responsible author or maintainer, or have their approval.</li>
    </ul>
    <p>See the
      <a href="https://github.com/PalomarRegistry/PalomarPolicy/blob/main/CONTRIBUTING.md">full submission requirements</a>.
    </p>

    <section class="disclosure recovery-prompt" id="recovery-prompt"
             data-automatic="${automaticRecovery}" aria-labelledby="recovery-heading">
      <h2 id="recovery-heading">Already have a submission in progress?</h2>
      ${recoveryContent}
    </section>

    <section class="disclosure">
      <h2>What becomes public</h2>
      <p>
        The submitted repository, commit, and Comparator configuration path are
        permanently recorded in public. The automated review and decision become
        public only after you have seen them, and decided to complete the registration.
      </p>
    </section>

    <form method="post" action="/submit">
      <label for="repository">Repository</label>
      <input id="repository" name="repository" required autocomplete="off"
             list="repository-suggestions"
             aria-describedby="repository-hint"
             placeholder="owner/formalization" value="${escape(values.repository)}">
      <datalist id="repository-suggestions"></datalist>
      <p class="hint" id="repository-hint">
        <span class="field-status" id="repository-status" aria-hidden="true"></span>
        <span id="repository-message">A public GitHub repository. Type <code>owner/</code> to choose from its repositories, or paste a URL.</span>
      </p>

      <label for="commit">Commit</label>
      <input id="commit" name="commit" required pattern="\\s*[0-9a-fA-F]{40}\\s*" autocomplete="off"
             aria-describedby="commit-hint"
             placeholder="0000000000000000000000000000000000000000" value="${escape(values.commit)}">
      <p class="hint" id="commit-hint">
        <span class="field-status" id="commit-status" aria-hidden="true"></span>
        <span id="commit-message">A full 40-character SHA. Branches and tags move; a record must not.</span>
      </p>

      <label for="comparator_config_path">Comparator configuration</label>
      <input id="comparator_config_path" name="comparator_config_path" required
             autocomplete="off" list="comparator-config-suggestions"
             aria-describedby="comparator_config_path-hint"
             placeholder="comparator.json" value="${escape(values.comparator_config_path)}">
      <datalist id="comparator-config-suggestions"><option value="comparator.json"></option></datalist>
      <p class="hint" id="comparator_config_path-hint">
        <span class="field-status" id="comparator_config_path-status" aria-hidden="true"></span>
        <span id="comparator_config_path-message">Type a repository-relative path or choose a JSON file found at this commit.
        <code>comparator.json</code> is available immediately as the conventional default;
        type to narrow the suggestions, or continue typing any other path.
        One Palomar entry records this configuration and every declaration it
        selects. Submit another configuration separately.</span>
      </p>

      <details id="layout" class="disclosure"${layoutOpen ? " open" : ""}
               data-layout="${layoutOpen ? "custom" : "unchecked"}">
        <summary id="layout-summary">${
          layoutOpen ? "It looks like you have a non-standard file layout" : "File layout"
        }</summary>
        <p class="hint" id="layout-message">
          Palomar looks for the project at the repository root. If it is
          somewhere else, these are filled in for you once the commit is
          checked.
        </p>

        <label for="project_path">Project directory</label>
        <input id="project_path" name="project_path" autocomplete="off"
               placeholder="left blank for the repository root"
               value="${escape(values.project_path)}">
        <p class="hint">The directory holding the Lakefile and selected Comparator configuration.</p>

        <label for="formalization_metadata_path">Formalization metadata</label>
        <input id="formalization_metadata_path" name="formalization_metadata_path"
               autocomplete="off"
               placeholder="left blank for formalization.yaml in the project"
               value="${escape(values.formalization_metadata_path)}">
      </details>

      <section class="disclosure registration-target" id="registration-target"
               data-state="unchecked" aria-labelledby="registration-target-heading">
        <h2 id="registration-target-heading">Registration target</h2>
        <p id="registration-target-message"></p>

        <details id="registration-target-manual"${manualRegistrationOpen ? " open" : ""}>
          <summary>Enter an existing Palomar ID manually</summary>
          <label for="existing_id">Existing Palomar ID <span class="optional">optional</span></label>
          <input id="existing_id" name="existing_id" autocomplete="off"
                 pattern="\\s*[Pp][Aa][Ll][Oo][Mm][Aa][Rr]-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}\\s*"
                 aria-describedby="existing_id-hint"
                 placeholder="PALOMAR-2026-07-29-000123"
                 value="${escape(values.existing_id)}">
          <p class="hint" id="existing_id-hint">
            <span class="field-status" id="existing_id-status" aria-hidden="true"></span>
            <span id="existing_id-message">Use this to identify the registration this submission should replace.</span>
          </p>
        </details>
      </section>

      <fieldset class="submission-details" id="submission-details"
                aria-describedby="registration-target-message">
      <fieldset>
        <legend>Your relationship to this formalization</legend>
        <label class="choice">
          <input type="radio" name="authorization_relationship" value="maintainer" required
                 ${values.authorization_relationship === "maintainer" ? "checked" : ""}>
          I am a responsible author or maintainer of it
        </label>
        <label class="choice">
          <input type="radio" name="authorization_relationship" value="approved"
                 ${values.authorization_relationship === "approved" ? "checked" : ""}>
          I have approval from a responsible author or maintainer
        </label>
        <p class="hint">
          If this repository is only a thin wrapper around another formalization,
          answer about that underlying repository, not the wrapper.
        </p>
      </fieldset>

      <div class="dependent" id="approval-evidence"${approvalApplies ? "" : " hidden"}>
        <label for="authorization_evidence">
          How that approval was given <span class="optional">optional</span>
        </label>
        <textarea id="authorization_evidence" name="authorization_evidence" rows="3"
                  maxlength="4000"
                  ${approvalApplies ? "" : "disabled "}
                  aria-describedby="authorization_evidence-hint">${escape(values.authorization_evidence)}</textarea>
        <p class="hint warning" id="authorization_evidence-hint">
          Included in the public mechanical report during verification and
          retained permanently if you register. Do not name anyone who has not
          agreed to be named.
        </p>
      </div>

      <label for="context">Notes <span class="optional">optional</span></label>
      <textarea id="context" name="context" rows="4" aria-describedby="context-hint">${escape(values.context)}</textarea>
      <p class="hint" id="context-hint">
        This field is not public, but is provided to the AI checks that validate
        <code>formalization.yaml</code> and the correspondence between the
        informal and formal statements.
      </p>

      <section class="disclosure browser-preflight" id="browser-preflight"
               data-state="checking" aria-labelledby="browser-preflight-heading" hidden>
        <h2 id="browser-preflight-heading">Check this commit before authentication</h2>
        <p id="browser-preflight-summary" tabindex="-1"></p>
        <ul id="browser-preflight-diagnostics" class="problems"></ul>
        <p id="browser-preflight-deferred" class="hint"></p>
        <button type="button" class="secondary" id="browser-preflight-anyway" hidden>
          Submit anyway
        </button>
      </section>

      <button type="submit" id="submission-submit">Authenticate via GitHub</button>
      <p class="hint">
        You may be asked to sign in, so Palomar can confirm you have write
        access to the repository you are submitting. Even if you are already signed
        in, GitHub may ask you to authorize Palomar on your first submission.
        The GitHub access token is used once and not stored. Palomar remembers
        the verified account in this browser for twelve hours so it can find
        submissions in progress automatically.
      </p>
      </fieldset>
      <p class="visually-hidden" role="status" id="live-status"></p>
    </form>
    <script type="module" src="/intake.js"></script>
  `, { submitCurrent: true });
}

export function submissionsPage(
  env,
  { submissions = [], pending = null, nonce = null, problems = [] } = {},
) {
  const emptyRecovery = !pending && submissions.length === 0;
  const title = emptyRecovery
    ? "There are no submissions still in progress for this GitHub account."
    : "Your submissions in progress";
  const trouble = problems.length
    ? `<section class="disclosure problems-block" role="alert">
         <h2>The new submission has not started</h2>
         <ul class="problems">${problems.map((problem) => `<li>${escape(problem)}</li>`).join("")}</ul>
       </section>`
    : "";
  const rows = submissions.map((submission) => {
    const sameRepository = pending &&
      String(submission.repository).toLowerCase() === String(pending.repository).toLowerCase();
    const replacement = sameRepository && submission.replaceable
      ? `<form method="post" action="/submission-choice">
               <input type="hidden" name="state" value="${escape(nonce)}">
               <input type="hidden" name="replace_id" value="${escape(submission.id)}">
               <button type="submit">Abandon this submission and start the new one</button>
               <p class="hint warning">This withdraws the earlier submission and cannot be undone.</p>
             </form>`
      : "";
    return `<li class="disclosure">
          <h2>${escape(submission.repository)}</h2>
          <dl class="details">
            <dt>Submission</dt><dd><code>${escape(submission.id)}</code></dd>
            <dt>Commit</dt><dd><code>${escape(submission.commit)}</code></dd>
            <dt>Status</dt><dd>${escape(submission.statusLabel)}</dd>
          </dl>
          <p><a href="/s#${escape(submission.token)}">Open this submission</a></p>
          ${sameRepository
            ? `<p class="hint">This is the same repository as the submission you just tried to start.</p>`
            : ""}
          ${replacement}
        </li>`;
  }).join("");
  const sameReplaceable = pending && submissions.some((submission) =>
    submission.replaceable &&
    String(submission.repository).toLowerCase() === String(pending.repository).toLowerCase()
  );
  const continueNew = pending && !sameReplaceable
    ? `<section class="disclosure">
         <h2>Start the new submission</h2>
         <p>
           Continue with <strong>${escape(pending.repository)}</strong> at
           <code>${escape(pending.commit)}</code>. Existing submissions are left unchanged.
         </p>
         <form method="post" action="/submission-choice">
           <input type="hidden" name="state" value="${escape(nonce)}">
           <button type="submit" id="start-new-submission">Start the new submission</button>
         </form>
       </section>`
    : "";
  const intro = emptyRecovery
    ? ""
    : pending
    ? `<p class="lede">
         GitHub identified you. Before Palomar starts another submission, choose whether
         to return to work already in progress or continue with the new commit.
       </p>`
    : `<p class="lede">
         Here are your submissions in progress. Keep these links private.
       </p>`;
  return page(env, title, `
    <h1>${title}</h1>
    ${intro}
    ${trouble}
    ${rows ? `<ul class="submission-list">${rows}</ul>` : ""}
    ${continueNew}
    <p><a href="/">Return to the submission form</a></p>
    <script type="module" src="/submissions.js"></script>
  `);
}

export function statusPage(env) {
  return page(env, "Your submission", `
    <h1>Your submission</h1>
    <p class="lede" id="summary">Loading…</p>
    <section class="disclosure waiting" id="waiting-section" hidden>
      <h2>Please wait — no action is needed</h2>
      <p id="waiting-message" role="status"></p>
    </section>
    <div id="progress-detail"></div>
    <p class="hint">This page keeps itself up to date. You do not need to reload it.</p>
    <dl class="details" id="details"></dl>
    <h2>Progress</h2>
    <ol class="events" id="events"></ol>

    <section class="disclosure" id="verification-failure-section" hidden>
      <h2 id="failure-heading">What needs attention</h2>
      <p id="failure-intro"></p>
      <div id="failure-diagnostics"></div>
      <form id="repair-form" hidden>
        <h3>Palomar can help prepare a pull request for <code>formalization.yaml</code></h3>
        <p id="repair-explanation">
          Fill in only the values you want Palomar to change. Palomar will
          validate the result and open a pull request from its repair account;
          it will never push to your repository directly. Review and merge the
          pull request, then submit the merged commit as a new submission.
        </p>
        <div id="repair-fields"></div>
        <button type="submit">Prepare pull request</button>
        <p class="hint" id="repair-status" role="status"></p>
      </form>
      <details id="legacy-failure-details" hidden>
        <summary>Technical details from the GitHub run</summary>
      <ul class="problems" id="verification-errors"></ul>
      <p id="verification-run-context"></p>
      </details>
    </section>

    <section id="review-section" hidden>
      <h2>Your automated review</h2>
      <p class="hint">
        This is an automated review of whether your formal statements agree
        with the informal account of them, and whether the result is plausibly
        of interest. No person read it.
      </p>
      <p class="hint" id="review-privacy">
        It is private: nobody but you and the Palomar moderation team can see
        it, and it stays that way unless you register.
      </p>
      <dl class="details" id="review-summary"></dl>
      <div id="review-body"></div>
    </section>

    <div id="decision-section" hidden>
      <h2 id="decision-heading">Your decision</h2>
      <p id="decision-intro"></p>
      <div class="decision">
        <button type="button" id="register" aria-describedby="register-warning">Register this result</button>
        <button type="button" id="withdraw" class="secondary" aria-describedby="withdraw-warning">Withdraw the submission</button>
      </div>
      <p class="hint warning" id="register-warning">
        Palomar is still pre-launch. Registration makes the record, review,
        repository, and commit public during testing and creates immutable
        source-preservation tags. Your GitHub identity is not made public: a
        registered record names the submission and its authorization basis, and
        has no field for the person who sent it. The public database may still
        be reshaped until launch; after launch its registered records are
        append-only.
      </p>
      <p class="hint" id="withdraw-warning">
        Withdrawing ends this submission. Nothing about the review or decision
        becomes public.
      </p>
    </div>
    <p class="hint" id="decision-status" role="status"></p>

    <section class="disclosure">
      <h2>Keep this link</h2>
      <p>
        This is the quickest way back to this submission. Bookmark it, or copy
        it somewhere you will still have it tomorrow. If you lose it, the
        submission form can authenticate you with GitHub and issue a fresh link
        while the submission is still in progress.
      </p>
      <p class="details">
        <input id="submission-link" readonly aria-label="Link to this submission">
        <button type="button" id="copy-link" class="secondary">Copy</button>
      </p>
      <p class="hint warning">
        Anyone with this link can read the review and register or withdraw the
        submission. Treat it like a password.
      </p>
    </section>
    <script type="module" src="/status.js"></script>
  `);
}

export function errorPage(env, title, problems) {
  const list = problems.length
    ? `<ul class="problems">${problems.map((p) => `<li>${escape(p)}</li>`).join("")}</ul>`
    : "";
  return page(env, title, `<h1>${escape(title)}</h1>${list}<p><a href="/">Start again</a></p>`);
}
