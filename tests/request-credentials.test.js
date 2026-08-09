/** Pure request-credential transport and request-origin classification. */

import assert from "node:assert/strict";
import test from "node:test";
import {
  bearerToken,
  intakeBinding,
  intakeCookie,
  madeByThisSite,
  sessionCookie,
  sessionToken,
} from "../src/request-credentials.js";
import { digest } from "../src/submission.js";

const TOKEN = "a".repeat(64);
const ORIGIN = "https://submit.palomar-registry.org";

function request(headers = {}) {
  return new Request(`${ORIGIN}/api/submission`, { headers });
}

test("the session cookie has the exact host credential attributes", () => {
  assert.deepEqual(sessionCookie(TOKEN), {
    "set-cookie":
      `palomar_session=${TOKEN}; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict`,
  });
});

test("session and bearer credentials accept only exact lowercase tokens", () => {
  assert.equal(sessionToken(request({
    cookie: `unrelated=1; palomar_session=${TOKEN}; trailing=2`,
  })), TOKEN);
  assert.equal(bearerToken(request({ authorization: `Bearer ${TOKEN}` })), TOKEN);

  for (const value of [
    TOKEN.toUpperCase(),
    TOKEN.slice(1),
    `${TOKEN}a`,
  ]) {
    assert.equal(sessionToken(request({ cookie: `palomar_session=${value}` })), null);
    assert.equal(bearerToken(request({ authorization: `Bearer ${value}` })), null);
  }
  assert.equal(sessionToken(request({ cookie: `not_palomar_session=${TOKEN}` })), null);
  assert.equal(bearerToken(request({ authorization: `bearer ${TOKEN}` })), null);
  assert.equal(bearerToken(request({ authorization: `Bearer  ${TOKEN}` })), null);
});

test("origin classification prefers fetch metadata and otherwise requires the exact origin", () => {
  assert.equal(madeByThisSite(request({ "sec-fetch-site": "same-origin" })), true);
  assert.equal(madeByThisSite(request({ "sec-fetch-site": "none" })), true);
  assert.equal(madeByThisSite(request({ origin: ORIGIN })), true);

  assert.equal(madeByThisSite(request({
    "sec-fetch-site": "cross-site",
    origin: ORIGIN,
  })), false);
  assert.equal(madeByThisSite(request({
    "sec-fetch-site": "same-site",
    origin: ORIGIN,
  })), false);
  assert.equal(madeByThisSite(request({ origin: "https://data.palomar-registry.org" })), false);
  assert.equal(madeByThisSite(request({ origin: "null" })), false);
  assert.equal(madeByThisSite(request()), false);
});

test("an intake cookie is scoped to one nonce and clears with the same attributes", async () => {
  const nonce = "7".repeat(64);
  const binding = "b".repeat(64);
  const name = `palomar_intake_${(await digest(nonce)).slice(0, 16)}`;
  const attributes = "Path=/oauth/callback; HttpOnly; Secure; SameSite=Lax";

  assert.equal(
    await intakeCookie(nonce, binding),
    `${name}=${binding}; ${attributes}; Max-Age=900`,
  );
  assert.equal(
    await intakeCookie(nonce, null, { clear: true }),
    `${name}=; ${attributes}; Max-Age=0`,
  );
});

test("an intake binding accepts only the exact nonce-scoped lowercase value", async () => {
  const nonceDigest = await digest("nonce");
  const binding = "b".repeat(64);
  const name = `palomar_intake_${nonceDigest.slice(0, 16)}`;

  assert.equal(intakeBinding(request({
    cookie: `unrelated=1; ${name}=${binding}; trailing=2`,
  }), nonceDigest), binding);
  assert.equal(intakeBinding(request({
    cookie: `${name}=${binding.toUpperCase()}`,
  }), nonceDigest), null);
  assert.equal(intakeBinding(request({
    cookie: `${name}=${binding.slice(1)}`,
  }), nonceDigest), null);
  assert.equal(intakeBinding(request({
    cookie: `${name}=${binding}`,
  }), await digest("different nonce")), null);
});
