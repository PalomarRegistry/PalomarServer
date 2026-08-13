import assert from "node:assert/strict";
import test from "node:test";

import { errorPage, intakeForm, page, statusPage } from "../src/html.js";

const env = { SITE_URL: "https://palomar-registry.org" };
const html = page(env, "Submit a result", "<h1>Form</h1>");

test("submission pages use the registry navigation and page structure", () => {
  assert.match(html, /class="site-header"/);
  assert.match(html, /class="wordmark"[^>]*>Palomar<\/a>/);
  assert.match(html, /<nav aria-label="Main navigation">/);
  assert.match(html, /<a href="\/">Submit<\/a>/);
  assert.match(html, /<main id="content" class="page-main">/);
  assert.match(html, /class="site-footer"/);
  assert.match(html, /class="footer-brand">Palomar<\/span>/);
});

test("only the submission form marks Submit as the current page", () => {
  const current = /<a class="active" aria-current="page" href="\/">Submit<\/a>/;
  assert.match(intakeForm(env), current);
  assert.doesNotMatch(statusPage(env), current);
  assert.doesNotMatch(errorPage(env, "No", []), current);
});

test("the submission form relies on interactive preflight instead of static metadata guidance", () => {
  const form = intakeForm(env);
  assert.doesNotMatch(form, /Check <code>formalization\.yaml<\/code> before you submit/);
  assert.doesNotMatch(form, /copy-formalization-prompt/);
  assert.match(form, /id="browser-preflight"/);
  assert.match(form, /only after you have seen them, and decided to complete the registration/);
});

test("submission pages let browser colour preference select page chrome", () => {
  assert.match(html, /name="theme-color" content="#ffffff" media="\(prefers-color-scheme: light\)"/);
  assert.match(html, /name="theme-color" content="#101216" media="\(prefers-color-scheme: dark\)"/);
});

test("submission pages retain a keyboard skip link", () => {
  assert.match(html, /<a class="skip-link" href="#content">Skip to content<\/a>/);
});
