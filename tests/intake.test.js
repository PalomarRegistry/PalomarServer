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
  assert.match(form, /not completely secret prior to registration/);
  assert.match(form, /audited and acted on by the\s+Palomar moderation team/);
  // The earlier wording claimed reviews were readable by "the model provider"
  // and told people not to write anything sensitive in a field the reviewer
  // reads. That belongs beside the field, not in the headline promise.
  assert.doesNotMatch(form, /Never public unless you publish/);
});

test("the approval note is a field of its own, so it can be turned off", () => {
  assert.match(form, /<div class="dependent" id="approval-evidence">/);
  assert.match(form, /Registered permanently and cannot be withdrawn/);
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

test("a cited Palomar ID is shape-checked by the browser before it is sent", () => {
  assert.match(form, /pattern="PALOMAR-\[0-9\]\{4\}-\[0-9\]\{2\}-\[0-9\]\{2\}-\[0-9\]\{6\}"/);
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
