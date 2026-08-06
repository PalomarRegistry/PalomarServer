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
  return page(env, "Submit a result", `
    <h1>Submit a Lean-verified result</h1>
    ${trouble}
    <p class="lede">
      Palomar verifies an immutable snapshot of a public repository, and performs
      a basic AI check that the formal and informal statements match and that the
      result is plausibly interesting to some mathematician. Read the
      <a href="https://github.com/PalomarRegistry/PalomarPolicy/blob/main/CONTRIBUTING.md">submission policy</a>
      first.
    </p>

    <section class="disclosure">
      <h2>What is public, and what is not</h2>
      <p>
        The fact that this repository and commit have been submitted is
        permanently and publicly recorded. Your identity, the automated review,
        and the decision will not be public until you have seen them and decided
        to go ahead with registration.
      </p>
      <p>
        The reviews are not completely secret prior to registration: they may be
        audited and acted on by the Palomar moderation team.
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

      <details id="layout" class="disclosure">
        <summary>Where the Lean project is <span class="optional">usually nothing to do</span></summary>
        <p class="hint" id="layout-message">
          Palomar looks for the project at the repository root. If it is
          somewhere else, these are filled in for you once the commit is
          checked.
        </p>

        <label for="project_path">Project directory</label>
        <input id="project_path" name="project_path" autocomplete="off"
               placeholder="left blank for the repository root">
        <p class="hint">The directory holding the Lakefile and comparator.json.</p>

        <label for="comparator_config_path">Comparator configuration</label>
        <input id="comparator_config_path" name="comparator_config_path" autocomplete="off"
               placeholder="left blank for comparator.json in the project">

        <label for="formalization_metadata_path">Formalization metadata</label>
        <input id="formalization_metadata_path" name="formalization_metadata_path"
               autocomplete="off"
               placeholder="left blank for formalization.yaml in the project">
      </details>

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

      <div class="dependent" id="approval-evidence">
        <label for="authorization_evidence">
          How that approval was given <span class="optional">optional</span>
        </label>
        <textarea id="authorization_evidence" name="authorization_evidence" rows="3"
                  aria-describedby="authorization_evidence-hint">${escape(values.authorization_evidence)}</textarea>
        <p class="hint warning" id="authorization_evidence-hint">
          Registered permanently and cannot be withdrawn. Do not name anyone who
          has not agreed to be named.
        </p>
      </div>

      <label for="existing_id">Existing Palomar ID <span class="optional">optional</span></label>
      <input id="existing_id" name="existing_id" autocomplete="off"
             pattern="\\s*[Pp][Aa][Ll][Oo][Mm][Aa][Rr]-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}\\s*"
             aria-describedby="existing_id-hint"
             placeholder="PALOMAR-2026-07-29-000123"
             value="${escape(values.existing_id)}">
      <p class="hint" id="existing_id-hint">
        <span class="field-status" id="existing_id-status" aria-hidden="true"></span>
        <span id="existing_id-message">Only to register a new version of a result already in the registry.</span>
      </p>

      <label for="context">Notes for the reviewer <span class="optional">optional</span></label>
      <textarea id="context" name="context" rows="4" aria-describedby="context-hint">${escape(values.context)}</textarea>
      <p class="hint" id="context-hint">
        Read by the reviewer and kept with the private record. Do not put
        anything sensitive here.
      </p>

      <button type="submit">Authenticate via GitHub</button>
      <p class="hint">
        You may be asked to sign in, so Palomar can confirm you have write
        access to the repository you are submitting. If you are already signed
        in to GitHub you will not see anything. The sign-in is used once and
        not stored.
      </p>
      <p class="visually-hidden" role="status" id="live-status"></p>
    </form>
    <script type="module" src="/intake.js"></script>
  `);
}

export function statusPage(env) {
  return page(env, "Your submission", `
    <h1>Your submission</h1>
    <p class="lede" id="summary">Loading…</p>
    <div id="progress-detail"></div>
    <p class="hint">This page keeps itself up to date. You do not need to reload it.</p>
    <dl class="details" id="details"></dl>
    <h2>Progress</h2>
    <ol class="events" id="events"></ol>

    <section id="review-section" hidden>
      <h2>Your automated review</h2>
      <p class="hint">
        This is an automated review of whether your formal statements agree
        with the informal account of them, and whether the result is plausibly
        of interest. No person read it. It is private: nobody but you and the
        Palomar moderation team can see it, and it stays that way unless you
        register.
      </p>
      <dl class="details" id="review-summary"></dl>
      <div id="review-body"></div>
      <div class="decision">
        <button type="button" id="register">Register this result</button>
        <button type="button" id="withdraw" class="secondary">Withdraw the submission</button>
      </div>
      <p class="hint warning" id="register-warning">
        Registration is permanent. It puts the record, the review, and the
        repository and commit into the public registry, and Palomar records are
        append-only: a registered record is never removed. Withdrawing leaves no
        public trace of the review or the decision.
      </p>
      <p class="hint" id="decision-status" role="status"></p>
    </section>

    <section class="disclosure">
      <h2>Keep this link</h2>
      <p>
        This is the only way back to this submission. Palomar does not email,
        and there is no account to sign in to. Bookmark it, or copy it
        somewhere you will still have it tomorrow.
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
    <script src="/status.js" defer></script>
  `);
}

export function errorPage(env, title, problems) {
  const list = problems.length
    ? `<ul class="problems">${problems.map((p) => `<li>${escape(p)}</li>`).join("")}</ul>`
    : "";
  return page(env, title, `<h1>${escape(title)}</h1>${list}<p><a href="/">Start again</a></p>`);
}
