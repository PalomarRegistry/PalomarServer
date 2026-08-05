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
  assert.match(form, /may be audited and acted on by the\s+Palomar moderation team/);
  // The earlier wording claimed reviews were readable by "the model provider"
  // and told people not to write anything sensitive in a field the reviewer
  // reads. That belongs beside the field, not in the headline promise.
  assert.doesNotMatch(form, /Never public unless you publish/);
});

test("the approval note is a field of its own, so it can be turned off", () => {
  assert.match(form, /<div class="dependent" id="approval-evidence">/);
  assert.match(form, /Published permanently and cannot be withdrawn/);
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

test("a failed lookup never blocks a submission", async () => {
  const script = await readFile(new URL("../public/intake.js", import.meta.url), "utf8");
  // A rate limit or an outage on somebody else's API is not a reason to refuse
  // someone's work, so nothing here may disable submission or cancel the event.
  assert.doesNotMatch(script, /preventDefault|submit\.disabled|setCustomValidity/);
});
