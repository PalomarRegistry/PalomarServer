/** Server-rendered pages. No submitted text is ever interpolated unescaped. */

export function escape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

export function page(env, title, body) {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escape(title)} — Palomar</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <link rel="stylesheet" href="/style.css">
  </head>
  <body>
    <header><a class="wordmark" href="${escape(env.SITE_URL)}">Palomar</a></header>
    <main>${body}</main>
    <footer>
      <a href="${escape(env.SITE_URL)}">Registry</a>
      <a href="${escape(env.SITE_URL)}/about.html">About</a>
      <a href="https://github.com/PalomarRegistry/PalomarPolicy/blob/main/CONTRIBUTING.md">Policy</a>
    </footer>
  </body>
</html>`;
}

export function intakeForm(env, values = {}, problems = []) {
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

    <section class="disclosure recovery-prompt">
      <h2>Already have a submission in progress?</h2>
      <form method="get" action="/submissions">
        <button type="submit" class="secondary" id="find-submissions">Find my submissions</button>
      </form>
    </section>

    <section class="disclosure metadata-warning">
      <h2>Check <code>formalization.yaml</code> before you submit</h2>
      <p>
        Palomar checks your <code>formalization.yaml</code> file carefully, as
        this provides the essential metadata for your registration. The
        submission process may request changes, so please expect that you may
        need to update <code>formalization.yaml</code> in your repository and
        then submit with the new commit.
      </p>
      <details>
        <summary>Prompt a coding agent to check the file now</summary>
        <p class="hint">
          Paste the prompt below into a coding agent in a local clone of your
          repository. (You can also try this check in the web interface for an
          LLM, but you may need to also paste in your
          <code>formalization.yaml</code> and other context from your repository
          in order to get a useful response.) Treat its answer as advice:
          Palomar's preflight remains the authoritative check.
        </p>
        <!-- The bare URL must remain: the copy button uses textContent and drops href. -->
        <pre id="formalization-prompt">Check the formalization.yaml file for this project in the current repository for a Palomar Registry submission.

Palomar uses <a href="https://github.com/mathlib-initiative/formalization.yaml">mathlib-initiative formalization.yaml</a> v0.3 (https://github.com/mathlib-initiative/formalization.yaml) as a base and requires these top-level sections: project, classification, sources, automation, and review. Check all of the following Palomar requirements:
- project has a nonempty name, authors, license, and responsible_maintainers;
- omit repository for an ordinary project: the submitted repository is the substantive development by default. Only a thin wrapper needs repository.substantive_formalization with a GitHub repository id and full commit; an explicit repository.role of thin-wrapper remains accepted but is unnecessary;
- classification.arxiv has one or two valid arXiv category codes and classification.msc2020 has one to eight valid MSC 2020 codes;
- sources is a nonempty list, and every source has a title and relationship;
- automation.methods is a nonempty list and every entry has a nonempty method;
- review.status is nonempty.

Identify every missing, malformed, or inconsistent field. For each problem, name the exact dotted field, explain the expected value, and propose a concrete YAML change. Do not invent names, authorship, classifications, licences, source relationships, substantive repositories, commits, or review claims: mark values that I must supply myself. Return a corrected YAML draft and then a short checklist of assumptions I should verify.</pre>
        <button type="button" class="secondary" id="copy-formalization-prompt">Copy prompt</button>
        <span class="hint" id="formalization-prompt-status" role="status"></span>
      </details>
    </section>

    <section class="disclosure">
      <h2>What becomes public</h2>
      <p>
        The submitted repository, commit, and Comparator configuration path are
        permanently recorded in public. The automated review and decision become
        public only if you choose to register after seeing them.
      </p>
    </section>

    <form method="post" action="/submit">
      <label for="repository">Repository</label>
      <input id="repository" name="repository" required autocomplete="off"
             aria-describedby="repository-hint"
             placeholder="owner/formalization" value="${escape(values.repository)}">
      <p class="hint" id="repository-hint">
        <span class="field-status" id="repository-status" aria-hidden="true"></span>
        <span id="repository-message">A public GitHub repository, as <code>owner/name</code> or a URL.</span>
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
             autocomplete="off" aria-describedby="comparator_config_path-hint"
             placeholder="comparator.json" value="${escape(values.comparator_config_path)}">
      <p class="hint" id="comparator_config_path-hint">
        <span class="field-status" id="comparator_config_path-status" aria-hidden="true"></span>
        <span id="comparator_config_path-message">A repository-relative path to exactly one Comparator JSON file. One
        Palomar entry records this configuration and every declaration it
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

      <button type="submit">Authenticate via GitHub</button>
      <p class="hint">
        You may be asked to sign in, so Palomar can confirm you have write
        access to the repository you are submitting. Even if you are already signed
        in, GitHub may ask you to authorize Palomar on your first submission.
        The authorization is used once and not stored.
      </p>
      </fieldset>
      <p class="visually-hidden" role="status" id="live-status"></p>
    </form>
    <script type="module" src="/intake.js"></script>
  `);
}

export function submissionsPage(
  env,
  { submissions = [], pending = null, nonce = null, problems = [] } = {},
) {
  const trouble = problems.length
    ? `<section class="disclosure problems-block" role="alert">
         <h2>The new submission has not started</h2>
         <ul class="problems">${problems.map((problem) => `<li>${escape(problem)}</li>`).join("")}</ul>
       </section>`
    : "";
  const rows = submissions.length
    ? submissions.map((submission) => {
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
      }).join("")
    : `<li>There are no submissions still in progress for this GitHub account.</li>`;
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
           <button type="submit">Start the new submission</button>
         </form>
       </section>`
    : "";
  const intro = pending
    ? `<p class="lede">
         GitHub identified you. Before Palomar starts another submission, choose whether
         to return to work already in progress or continue with the new commit.
       </p>`
    : `<p class="lede">
         Here are your submissions in progress. Keep these links private.
       </p>`;
  return page(env, "Your submissions in progress", `
    <h1>Your submissions in progress</h1>
    ${intro}
    ${trouble}
    <ul class="submission-list">${rows}</ul>
    ${continueNew}
    <p><a href="/">Return to the submission form</a></p>
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
        <h3>Let Palomar prepare the metadata changes</h3>
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
