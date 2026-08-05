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

export function intakeForm(env, values = {}) {
  return page(env, "Submit a result", `
    <h1>Submit a Lean-verified result</h1>
    <p class="lede">
      Palomar verifies an immutable snapshot of a public repository and reviews it
      editorially. Read the
      <a href="https://github.com/PalomarRegistry/PalomarPolicy/blob/main/CONTRIBUTING.md">submission policy</a>
      first.
    </p>

    <section class="disclosure">
      <h2>What is public, and what is not</h2>
      <ul>
        <li>
          <strong>Public from the moment you submit:</strong> your repository and commit.
          Verification runs in a public GitHub Actions workflow, and its logs are public.
          Whether you later publish is inferable from the registry.
        </li>
        <li>
          <strong>Never public unless you publish:</strong> the review, the decision, and
          your identity as submitter.
        </li>
        <li>
          <strong>"Private" means not public, not confidential.</strong> Reviews are readable
          by Palomar operators, by GitHub, and by the model provider, and are kept
          indefinitely. Do not put anything sensitive in the notes field.
        </li>
      </ul>
    </section>

    <form method="post" action="/submit">
      <label for="repository">Repository</label>
      <input id="repository" name="repository" required
             placeholder="owner/formalization" value="${escape(values.repository)}">
      <p class="hint">A public GitHub repository, as <code>owner/name</code> or a URL.</p>

      <label for="commit">Commit</label>
      <input id="commit" name="commit" required pattern="[0-9a-fA-F]{40}"
             placeholder="0000000000000000000000000000000000000000" value="${escape(values.commit)}">
      <p class="hint">A full 40-character SHA. Branches and tags move; a record must not.</p>

      <label for="existing_id">Existing Palomar ID <span class="optional">optional</span></label>
      <input id="existing_id" name="existing_id" placeholder="PALOMAR-2026-07-29-000123"
             value="${escape(values.existing_id)}">
      <p class="hint">Only to publish a new version of a result already in the registry.</p>

      <label for="context">Notes for the reviewer <span class="optional">optional</span></label>
      <textarea id="context" name="context" rows="4"></textarea>

      <button type="submit">Continue with GitHub</button>
      <p class="hint">
        You will be asked to sign in so Palomar can confirm you have write access to the
        repository you are submitting. The sign-in is used once and not stored.
      </p>
    </form>
  `);
}

export function statusPage(env) {
  return page(env, "Your submission", `
    <h1>Your submission</h1>
    <p class="lede" id="summary">Loading…</p>
    <dl class="details" id="details"></dl>
    <h2>Progress</h2>
    <ol class="events" id="events"></ol>
    <section class="disclosure">
      <h2>Keep this page</h2>
      <p>
        The link in your address bar is the only way back to this submission. Palomar
        does not email, and there is no account to sign in to. Bookmark it.
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
