/**
 * The intake form: what it promises, and what it must not send.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { intakeForm } from "../src/html.js";
import worker from "../src/index.js";

const ENV = { SITE_URL: "https://palomar-registry.org", STATE_REPO: "x/y" };
const form = intakeForm(ENV);

test("the disclosure says what is recorded and when it becomes public", () => {
  assert.match(form, /permanently and publicly recorded/);
  assert.match(form, /will not be public until you have seen them/);
  // "The review" invites the reading that a person did it. Say what it is.
  assert.match(form, /the automated review/);
  assert.match(form, /not completely secret prior to registration/);
  assert.match(form, /audited and acted on by the\s+Palomar moderation team/);
  // The earlier wording claimed reviews were readable by "the model provider"
  // and told people not to write anything sensitive in a field the reviewer
  // reads. That belongs beside the field, not in the headline promise.
  assert.doesNotMatch(form, /Never public unless you publish/);
});

test("the approval note is a field of its own, so it can be turned off", () => {
  assert.match(form, /<div class="dependent" id="approval-evidence">/);
  assert.match(form, /Included in the public mechanical report during verification/);
  assert.match(form, /maxlength="4000"/);
});

test("what a submitter typed survives a rejected submission", () => {
  // Retyping a 40-character SHA and a paragraph of notes because the server
  // had a bad moment is not acceptable.
  const filled = intakeForm(ENV, {
    repository: "owner/project",
    commit: "a".repeat(40),
    existing_id: "PALOMAR-2026-07-29-000123",
    context: "Notes <with> markup & an ampersand",
    authorization_relationship: "approved",
    authorization_evidence: "Approved by the maintainer",
  }, ["Palomar could not record that submission just now."]);

  assert.match(filled, /value="owner\/project"/);
  assert.match(filled, new RegExp(`value="${"a".repeat(40)}"`));
  assert.match(filled, /value="PALOMAR-2026-07-29-000123"/);
  assert.match(filled, /Notes &lt;with&gt; markup &amp; an ampersand/);
  assert.match(filled, /Approved by the maintainer/);
  assert.match(filled, /value="approved"\s*\n?\s*checked/);
  assert.match(filled, /could not record that submission/);
  // What was typed is escaped, not interpolated.
  assert.doesNotMatch(filled, /<with>/);
});

test("public text speaks of registration, not publication", () => {
  // "Publication" invites the comparison with a journal that the registry
  // exists not to be. Route names and record fields keep their old spelling;
  // this is about what a submitter reads.
  const visible = form.replace(/<[^>]*>/g, " ");
  assert.doesNotMatch(visible, /\bpublicat|\bpublish/i);
  assert.match(visible, /registration/i);
});

test("the button says what it does", () => {
  assert.match(form, /Authenticate via GitHub/);
  assert.doesNotMatch(form, /Continue with GitHub/);
});

test("the browser's own validation accepts whatever the normaliser accepts", async () => {
  // The `pattern` attribute runs before any script and cannot be made to
  // normalise. If it is stricter than the shared normaliser, a value is
  // reported as found by the live check and then refused on submission.
  const { normalizeCommit, normalizePalomarId } = await import("../public/normalize.js");
  const patterns = [...form.matchAll(/pattern="([^"]+)"/g)].map((m) => new RegExp(`^${m[1]}$`));
  const [commitPattern, idPattern] = patterns;
  for (const value of [
    " 8d9b8319a4ed2dd094655978e905512dee6394b6 ",
    "8D9B8319A4ED2DD094655978E905512DEE6394B6",
    "\t8d9b8319a4ed2dd094655978e905512dee6394b6\n",
  ]) {
    assert.ok(normalizeCommit(value), `the normaliser rejects ${JSON.stringify(value)}`);
    assert.ok(commitPattern.test(value), `the pattern rejects ${JSON.stringify(value)}`);
  }
  for (const value of [" PALOMAR-2026-07-29-000123 ", "palomar-2026-07-29-000123"]) {
    assert.ok(normalizePalomarId(value), `the normaliser rejects ${JSON.stringify(value)}`);
    assert.ok(idPattern.test(value), `the pattern rejects ${JSON.stringify(value)}`);
  }
  // And still refuses what the normaliser refuses.
  assert.ok(!commitPattern.test("8d9b83"));
  assert.ok(!normalizeCommit("8d9b83"));
});

test("every live-checked field names the element that describes it", () => {
  for (const id of ["repository", "commit", "existing_id"]) {
    assert.match(form, new RegExp(`aria-describedby="${id}-hint"`), `${id} is undescribed`);
    assert.match(form, new RegExp(`id="${id}-status"`), `${id} has no status slot`);
  }
});

test("the form still works without the script", () => {
  // Nothing required lives behind JavaScript: the method, action, and every
  // required control are in the markup.
  assert.match(form, /<form method="post" action="\/submit">/);
  assert.match(form, /id="repository" name="repository" required/);
  assert.match(form, /name="authorization_relationship" value="maintainer" required/);
});

test("the policy reaches exactly the two origins the form looks things up on", async () => {
  const response = await worker.fetch(
    new Request("https://submit.palomar-registry.org/"),
    ENV,
  );
  const policy = response.headers.get("content-security-policy");
  assert.match(policy, /connect-src 'self' https:\/\/api\.github\.com https:\/\/raw\.githubusercontent\.com;/);
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /form-action 'self'/);
});

test("the script never sends what the submitter typed anywhere but those origins", async () => {
  const script = await readFile(new URL("../public/intake.js", import.meta.url), "utf8");
  const destinations = [...script.matchAll(/fetch\(\s*(`[^`]*`|"[^"]*"|[A-Z_]+)/g)]
    .map((match) => match[1]);
  for (const destination of destinations) {
    assert.ok(
      /api\.github\.com/.test(destination) || destination === "REGISTRY_INDEX",
      `unexpected fetch destination: ${destination}`,
    );
  }
  assert.ok(destinations.length >= 2);
});

test("nothing in the browser can block a submission", async () => {
  const script = await readFile(new URL("../public/intake.js", import.meta.url), "utf8");
  // A rate limit or an outage on somebody else's API is not a reason to refuse
  // someone's work. Neither is a second press of a button that looked dead:
  // a guard against double submission is also a way to lose a submission.
  assert.doesNotMatch(script, /preventDefault|setCustomValidity/);
  // The one thing disabled anywhere is the approval note, which applies to
  // only one of the two answers. The submit control is never touched.
  const disabled = [...script.matchAll(/(\w+)\.disabled\s*=/g)].map((m) => m[1]);
  assert.deepEqual(disabled, ["evidence"]);
});

test("one word for one thing, in the code as well as the copy", async () => {
  // "Publication" invites the comparison with a journal that the registry
  // exists not to be. Keeping it in field names and routes while the copy says
  // registration is how a codebase ends up with two words for one idea, and
  // how a field gets read under one name and written under the other.
  const files = ["../src/index.js", "../src/html.js", "../src/submission.js",
                 "../src/github.js", "../public/status.js", "../public/intake.js"];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    const stray = [...source.matchAll(/\b\w*[Pp]ublish\w*|\b\w*[Pp]ublicat\w*/g)].map((m) => m[0]);
    assert.deepEqual(stray, [], `${file} still says ${[...new Set(stray)].join(", ")}`);
  }
});

test("the browser and the server agree on what a submitted value means", async () => {
  // The form's live checks and this server import the same module, so they
  // cannot drift. This asserts the property that matters rather than the
  // sharing: for every input, one answer.
  const shared = await import("../public/normalize.js");
  const server = await import("../src/submission.js");
  const inputs = [
    " 8d9b8319a4ed2dd094655978e905512dee6394b6 ",
    "8D9B8319A4ED2DD094655978E905512DEE6394B6",
    "8d9b83", "", "   ", "not a commit",
    "kim-em/erdos-unit-distance-comparator",
    " kim-em/erdos-unit-distance-comparator ",
    "https://github.com/kim-em/erdos-unit-distance-comparator",
    "https://github.com/kim-em/erdos-unit-distance-comparator.git/",
    "https://gitlab.com/kim-em/x", "kim-em",
    "PALOMAR-2026-07-29-000123", " palomar-2026-07-29-000123 ", "PALOMAR-2026-7-29-123",
  ];
  for (const value of inputs) {
    for (const name of ["normalizeCommit", "normalizeRepository", "normalizePalomarId"]) {
      assert.equal(server[name](value), shared[name](value), `${name}(${JSON.stringify(value)})`);
    }
  }
});

test("the live checks link back to what they found", async () => {
  const script = await readFile(new URL("../public/intake.js", import.meta.url), "utf8");
  // A submitter should be able to check the repository and commit the form
  // says it found, without losing the form to do it.
  assert.match(script, /https:\/\/github\.com\/\$\{data\.full_name\}/);
  assert.match(script, /https:\/\/github\.com\/\$\{name\}\/commit\/\$\{sha\}/);
  assert.match(script, /link\.target = "_blank"/);
  assert.match(script, /link\.rel = "noreferrer noopener"/);
  // The link text is set as text, and the href only ever from a normalised
  // value, which has already matched a strict pattern.
  assert.match(script, /link\.textContent = message/);
});

test("the policy permits the sign-in the form redirects to", async () => {
  // form-action applies to the redirect chain, not only the first hop. The
  // submission posts here and is answered with a redirect to GitHub, so a
  // policy naming only 'self' blocks every submission that gets that far, and
  // reports it against this origin, which is misleading as well as fatal.
  const response = await worker.fetch(
    new Request("https://submit.palomar-registry.org/"), ENV,
  );
  const policy = response.headers.get("content-security-policy");
  assert.match(policy, /form-action 'self' https:\/\/github\.com/);

  // And the place the form is actually sent is inside that list.
  const { intakeForm } = await import("../src/html.js");
  const action = /action="([^"]+)"/.exec(intakeForm(ENV))[1];
  assert.equal(action, "/submit", "the form posts somewhere form-action must allow");
});

test("the status page keeps the key it tells the submitter to bookmark", async () => {
  // The page said the address bar was the only way back and to bookmark it,
  // while the script removed the key from the address bar seconds later. The
  // bookmark was useless and the submission became unreachable when the
  // twelve-hour cookie expired.
  const script = await readFile(new URL("../public/status.js", import.meta.url), "utf8");
  assert.doesNotMatch(script, /replaceState/);
  const { statusPage } = await import("../src/html.js");
  const page = statusPage(ENV);
  assert.match(page, /id="submission-link"/);
  assert.match(page, /Treat it like a password/);
  // The page used to claim the fragment was never sent to any server, while
  // the same page posts it to /session to start the session. Browsers keep it
  // out of the requests they make; that is not the same claim.
  assert.doesNotMatch(page, /never sent to any server/);
});

test("the sign-in is described as it will actually behave", () => {
  // Someone already signed in to GitHub sees nothing happen, so promising
  // they will be asked describes a step they never see.
  assert.match(form, /You may be asked to sign in/);
  assert.match(form, /already signed\s+in to GitHub you will not see anything/);
  assert.doesNotMatch(form, /You will be asked to sign in/);
});

test("every status the reviewer can set has something to show for it", async () => {
  // A status the page does not know renders as its own raw name.
  const { STATUSES } = await import("../src/submission.js");
  const script = await readFile(new URL("../public/status.js", import.meta.url), "utf8");
  const labels = script.slice(script.indexOf("const LABELS"), script.indexOf("const REVIEW_EXPLANATION"));
  for (const status of Object.keys(STATUSES)) {
    assert.ok(labels.includes(`"${status}"`) || labels.includes(`${status}:`),
      `the page has no label for "${status}"`);
  }
});

test("every page asks for the favicon, and it is servable", async () => {
  const { statusPage } = await import("../src/html.js");
  for (const [name, page] of [["intake", form], ["status", statusPage(ENV)]]) {
    assert.match(page, /rel="icon" href="\/favicon\.svg"/, `${name} does not ask for the favicon`);
  }
  const icon = await readFile(new URL("../public/favicon.svg", import.meta.url), "utf8");
  assert.match(icon, /prefers-color-scheme: dark/);
  // The policy is default-src 'none' with img-src 'self', so nothing external.
  assert.doesNotMatch(icon, /<script|xlink:href|href="http/);
});

test("a project that is not at the repository root can be submitted", async () => {
  // The verifier has always taken these paths and CONTRIBUTING has always
  // documented them, but the form collected none of them, so a nested project
  // was documented and unsubmittable.
  for (const name of ["project_path", "comparator_config_path", "formalization_metadata_path"]) {
    assert.match(form, new RegExp(`name="${name}"`), `the form cannot say ${name}`);
  }
});

test("the layout is worked out from the repository rather than asked for", async () => {
  const { locateProject } = await import("../public/normalize.js");
  const found = locateProject(["lean-toolchain", "comparator.json", "lakefile.toml"]);
  assert.equal(found.found, true);
  assert.equal(found.project, "");
  const nested = locateProject([
    "formalization.yaml", "examples/p/comparator.json", "examples/p/lakefile.lean",
  ]);
  assert.equal(nested.project, "examples/p");
  // Metadata at the repository root is normal even for a nested project.
  assert.equal(nested.metadata, "formalization.yaml");
  // Two projects is a question for the submitter, not a guess.
  assert.equal(locateProject([
    "a/comparator.json", "a/lakefile.toml", "b/comparator.json", "b/lakefile.toml",
  ]).ambiguous, true);
  assert.equal(locateProject(["README.md"]).found, false);
});

test("nothing that only looks like a project is suggested as one", async () => {
  const { locateProject } = await import("../public/normalize.js");
  const real = ["proof/comparator.json", "proof/lakefile.toml"];

  // A name that merely ends in the right characters is a different file.
  assert.equal(locateProject([...real, "tests/not-comparator.json"]).project, "proof");
  // A dependency checkout carries whole projects of somebody else's.
  assert.equal(
    locateProject([...real, ".lake/packages/dep/comparator.json", ".lake/packages/dep/lakefile.toml"]).project,
    "proof",
  );
  // A configuration with no Lakefile beside it is a fixture, not a project.
  assert.equal(locateProject([...real, "fixtures/comparator.json"]).project, "proof");
  // The verifier refuses every symlinked component, so suggesting one would
  // send a submitter to a run that could only fail.
  assert.equal(
    locateProject([
      { path: "comparator.json", type: "blob", mode: "120000" },
      { path: "lakefile.toml", type: "blob", mode: "100644" },
    ]).found,
    false,
  );
  // One metadata file is an answer. Two is a guess, and a guess is silently
  // wrong: the submitter would never see which was chosen.
  assert.equal(locateProject([...real, "docs/formalization.yaml"]).metadata, "docs/formalization.yaml");
  assert.equal(
    locateProject([...real, "docs/formalization.yaml", "papers/formalization.yaml"]).metadata,
    "",
  );
});

test("a rejected submission gives back the layout it was told", async () => {
  const response = await worker.fetch(
    new Request("https://submit.palomar-registry.org/submit", {
      method: "POST",
      body: new URLSearchParams({
        repository: "owner/name",
        commit: "nonsense",
        authorization_relationship: "maintainer",
        project_path: "proof",
        comparator_config_path: "proof/Comparator/config.json",
        formalization_metadata_path: "docs/formalization.yaml",
      }),
    }),
    ENV,
  );
  const body = await response.text();
  assert.equal(response.status, 400);
  // Silently blanking these would submit the default paths next time, which
  // can verify a different project in the same repository.
  assert.match(body, /value="proof"/);
  assert.match(body, /value="proof\/Comparator\/config\.json"/);
  assert.match(body, /value="docs\/formalization\.yaml"/);
  // And shown, not folded away where nobody looks before pressing submit.
  assert.match(body, /<details id="layout"[^>]* open/);
  assert.match(body, /non-standard file layout/);
});

test("the layout heading says whether there is anything in it to do", async () => {
  const script = await readFile(new URL("../public/intake.js", import.meta.url), "utf8");

  // Nothing typed and nothing checked yet claims neither way.
  const fresh = intakeForm(ENV, {}, []);
  assert.match(fresh, /<summary id="layout-summary">File layout<\/summary>/);
  assert.match(fresh, /data-layout="unchecked"/);
  assert.doesNotMatch(fresh, /looks okay/);

  // A layout somebody spelled out is non-standard by definition, whatever the
  // repository turns out to look like.
  assert.match(
    intakeForm(ENV, { project_path: "proof" }, []),
    /<summary id="layout-summary">It looks like you have a non-standard file layout<\/summary>/,
  );

  // The settled case is the one that recedes, and it is the only one that does.
  assert.match(script, /ok: "File layout looks okay"/);
  const css = await readFile(new URL("../public/style.css", import.meta.url), "utf8");
  assert.match(css, /#layout\[data-layout="ok"\][^{]*\{[^}]*var\(--dim\)/);
  assert.doesNotMatch(css, /#layout\[data-layout="custom"\]/);

  // Every state the script can set has words to show for it.
  const states = [...script.matchAll(/summarize\("(\w+)"\)/g)].map((m) => m[1]);
  assert.ok(states.length >= 3, "the summary is never changed");
  for (const state of new Set(states)) {
    assert.match(script, new RegExp(`${state}: "`), `summarize("${state}") says nothing`);
  }
});

test("a directory really called `invalid` is a path, not an error", async () => {
  const response = await worker.fetch(
    new Request("https://submit.palomar-registry.org/submit", {
      method: "POST",
      body: new URLSearchParams({
        repository: "owner/name", commit: "nope",
        authorization_relationship: "maintainer", project_path: "invalid",
      }),
    }),
    ENV,
  );
  const body = await response.text();
  assert.doesNotMatch(body, /must be a path inside the repository/);
});

test("what agents are told about this service is true of this service", async () => {
  const guide = await readFile(new URL("../public/llms.txt", import.meta.url), "utf8");
  const server = await readFile(new URL("../src/index.js", import.meta.url), "utf8");

  // A document that drifts from the routes is worse than no document: an
  // agent following it fails in a way it cannot diagnose.
  const named = [...guide.matchAll(/`(?:GET|POST) (\/[a-z/]+)`/g)].map((m) => m[1]);
  assert.ok(named.length >= 5, "the guide names no endpoints");
  for (const path of new Set(named)) {
    assert.match(server, new RegExp(`url\\.pathname === "${path}"`), `${path} does not exist`);
  }

  // The one thing it must say, since nothing in the protocol enforces it.
  assert.match(guide, /do not drive the GitHub sign-in yourself/i);
  assert.match(guide, /\/register/);

  // It points at the policy rather than paraphrasing it, because a paraphrase
  // is a second copy that goes stale silently.
  assert.match(guide, /PalomarPolicy\/blob\/main\/CONTRIBUTING\.md/);
});

test("a path that escapes the repository is refused", async () => {
  for (const bad of ["../etc/passwd", "/absolute", "a/../../b", "a\\\\b", "a/./b"]) {
    const response = await worker.fetch(
      new Request("https://submit.palomar-registry.org/submit", {
        method: "POST",
        body: new URLSearchParams({
          repository: "owner/name", commit: "a".repeat(40),
          authorization_relationship: "maintainer", project_path: bad,
        }),
      }),
      ENV,
    );
    const body = await response.text();
    assert.match(body, /must be a path inside the repository/, `${bad} was not refused`);
  }
});
