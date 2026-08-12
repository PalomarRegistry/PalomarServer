/**
 * Pure request-credential transport and origin classification.
 *
 * Route policy, token lookup, and every state read stay in the Worker
 * composition root. This module only encodes or parses the credentials a
 * request carries and classifies the browser origin signals on that request.
 */

import { digest } from "./submission.js";

const SESSION_COOKIE_NAME = "__Host-palomar_session";
const GITHUB_IDENTITY_COOKIE_NAME = "__Host-palomar_github_identity";
const GITHUB_IDENTITY_SECONDS = 12 * 60 * 60;
const GITHUB_LOGIN_RE = /^[A-Za-z0-9_-]{1,39}$/;
const encoder = new TextEncoder();

/** Parse one exact host-prefixed credential without assigning authority by order. */
function protectedCookie(request, expectedName, valuePattern = /^[0-9a-f]{64}$/) {
  const cookie = request.headers.get("cookie") ?? "";
  const expectedFolded = expectedName.toLowerCase();
  let found = false;
  let value = null;
  for (const rawPart of cookie.split(";")) {
    const part = rawPart.replace(/^[ \t]+/, "");
    const separator = part.indexOf("=");
    const rawName = separator === -1 ? part : part.slice(0, separator);
    const name = rawName.trimEnd();
    if (name.toLowerCase() !== expectedFolded) continue;
    // Case and whitespace are not alternative spellings of a credential.
    if (found || rawName !== name || name !== expectedName) return { kind: "ambiguous" };
    found = true;
    value = separator === -1 ? null : part.slice(separator + 1);
  }
  if (!found) return { kind: "absent" };
  return typeof value === "string" && valuePattern.test(value)
    ? { kind: "valid", value }
    : { kind: "invalid" };
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - value.length % 4) % 4);
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function fromHex(value) {
  if (!/^[0-9a-f]{64}$/.test(value)) return null;
  return Uint8Array.from(value.match(/../g), (pair) => Number.parseInt(pair, 16));
}

async function githubIdentityKey(env) {
  if (!env.TOKEN_PEPPER) throw new Error("TOKEN_PEPPER is unset");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(`palomar-github-identity-v1:${env.TOKEN_PEPPER}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function validPrincipal(principal) {
  return Number.isSafeInteger(principal?.id) && principal.id > 0 &&
    typeof principal?.login === "string" && GITHUB_LOGIN_RE.test(principal.login);
}

/**
 * Remember that GitHub identified this browser, without retaining its OAuth token.
 *
 * The payload is authenticated rather than secret: it contains only the
 * account's own numeric id and login. The numeric id is the authority because
 * a login can be renamed and later reused. Domain separation keeps this use of
 * TOKEN_PEPPER independent from submission-capability digests.
 */
export async function githubIdentityCookie(env, principal, { clear = false } = {}) {
  const attributes = "Path=/; HttpOnly; Secure; SameSite=Strict";
  if (clear) {
    return `${GITHUB_IDENTITY_COOKIE_NAME}=; ${attributes}; Max-Age=0`;
  }
  if (!validPrincipal(principal)) throw new TypeError("invalid GitHub principal");
  const payload = base64Url(encoder.encode(JSON.stringify({
    schema_version: 1,
    id: principal.id,
    login: principal.login,
    expires: Date.now() + GITHUB_IDENTITY_SECONDS * 1000,
  })));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await githubIdentityKey(env),
    encoder.encode(payload),
  );
  const value = `${payload}.${[...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return `${GITHUB_IDENTITY_COOKIE_NAME}=${value}; ${attributes}; ` +
    `Max-Age=${GITHUB_IDENTITY_SECONDS}`;
}

/** Read a valid, unexpired GitHub identity established by this Worker. */
export async function githubIdentityPrincipal(request, env) {
  const credential = protectedCookie(
    request,
    GITHUB_IDENTITY_COOKIE_NAME,
    /^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/,
  );
  if (credential.kind !== "valid") return null;
  const [payload, signatureHex] = credential.value.split(".");
  const signature = fromHex(signatureHex);
  if (!signature || !await crypto.subtle.verify(
    "HMAC",
    await githubIdentityKey(env),
    signature,
    encoder.encode(payload),
  )) return null;
  const bytes = fromBase64Url(payload);
  if (!bytes) return null;
  let identity;
  try {
    identity = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (
    identity?.schema_version !== 1 ||
    !validPrincipal(identity) ||
    typeof identity.expires !== "number" ||
    !Number.isSafeInteger(identity.expires) ||
    identity.expires <= Date.now()
  ) return null;
  return { id: identity.id, login: identity.login };
}

/** The one-time exchange: fragment in, short-lived host-only cookie out. */
export function sessionCookie(token) {
  return {
    "set-cookie":
      `${SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict`,
  };
}

/**
 * Read exactly one browser-owned session credential.
 *
 * Supporting browsers enforce the `__Host-` prefix by requiring `Secure`,
 * `Path=/`, and no `Domain`, so a sibling host cannot set or shadow this name.
 * Raw clients can still construct ambiguous Cookie headers, and no ordering of
 * two credentials is authoritative, so duplicate names fail closed.
 */
export function sessionToken(request) {
  const credential = protectedCookie(request, SESSION_COOKIE_NAME);
  return credential.kind === "valid" ? credential.value : null;
}

/**
 * The same credential, presented rather than carried.
 *
 * A cookie is ambient: the browser attaches it to whatever it is talked into
 * sending, which is what makes cross-site request forgery a thing at all. This
 * is not, because `Authorization` is not a CORS-safelisted header: a page on
 * another origin cannot attach it without a preflight this server never grants,
 * and a form, an image, or a navigation cannot set a header at all. That is a
 * statement about other origins, not a claim that the token is safe from
 * anything already holding it. So an agent presenting the token is exempt from
 * the same-origin requirement below, and a browser carrying the cookie is not.
 */
export function bearerToken(request) {
  const match = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get("authorization") ?? "");
  return match ? match[1] : null;
}

/**
 * Whether a request carrying the session cookie was made by this site.
 *
 * `SameSite=Strict` is scoped to the registrable domain, not to the origin, so
 * `data.palomar-registry.org` is same-site with this host and a document
 * executing there has the cookie attached to whatever it sends here. That
 * origin serves render bundles built from submitted Lean source, which is the
 * one place in Palomar that runs something a submitter wrote. The render CSP
 * blocks the outbound request today, which means the render CSP is currently
 * part of this server's defence against forgery. That is not how the layering
 * is meant to read, and the documentation is emphatic that no layer should be
 * removed because another one happens to cover it.
 *
 * `Sec-Fetch-Site` answers the question directly and needs no allowlist to
 * maintain. `Origin` is the fallback for anything that does not send it. A
 * request that sends neither is not a browser, and gets told to present the
 * token as a header instead, where no ambient credential is involved.
 */
export function madeByThisSite(request) {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = request.headers.get("origin");
  // An absent header does not prove that a browser is harmless. The literal
  // `null` a sandboxed or redirected context sends is rejected below too.
  if (origin === null) return false;
  return origin === new URL(request.url).origin;
}

/**
 * The cookie that unlocks one pending intake, named after the intake it opens.
 *
 * Named rather than fixed, because a submitter may have two submissions in
 * flight and the form does not stop them starting a second in another tab. One
 * name would mean the second sign-in overwrote the first one's cookie, and then
 * finishing the first would look exactly like the attack this exists to catch:
 * refused, and its pending record deleted, for doing nothing wrong.
 *
 * `Lax`, not `Strict`. The callback is a top-level navigation from github.com,
 * and `Strict` would withhold the cookie on the one request that needs it. Lax
 * is enough here because the cookie confers nothing on its own: it only opens a
 * record whose name the holder must already know. `Path=/` and no `Domain` are
 * required by the `__Host-` prefix; only the callback consumes the nonce-named
 * credential, so the broader path grants no authority on another route.
 */
export async function intakeCookie(nonce, binding, { clear = false } = {}) {
  const name = `__Host-palomar_intake_${(await digest(nonce)).slice(0, 16)}`;
  const attributes = "Path=/; HttpOnly; Secure; SameSite=Lax";
  return clear
    ? `${name}=; ${attributes}; Max-Age=0`
    : `${name}=${binding}; ${attributes}; Max-Age=3600`;
}

/** Parse the exact binding named by an already validated lowercase-hex nonce digest. */
export function intakeCredential(request, nonceDigest) {
  return protectedCookie(request, `__Host-palomar_intake_${nonceDigest.slice(0, 16)}`);
}
