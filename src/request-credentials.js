/**
 * Pure request-credential transport and origin classification.
 *
 * Route policy, token lookup, and every state read stay in the Worker
 * composition root. This module only encodes or parses the credentials a
 * request carries and classifies the browser origin signals on that request.
 */

import { digest } from "./submission.js";

const SESSION_COOKIE_NAME = "__Host-palomar_session";

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
  const cookie = request.headers.get("cookie") ?? "";
  let found = false;
  let value = null;
  for (const rawPart of cookie.split(";")) {
    const part = rawPart.trimStart();
    const separator = part.indexOf("=");
    const rawName = separator === -1 ? part : part.slice(0, separator);
    const name = rawName.trimEnd();
    if (name !== SESSION_COOKIE_NAME) continue;
    // Count a whitespace-padded protected name as ambiguity without accepting
    // that malformed spelling by itself.
    if (found || rawName !== name) return null;
    found = true;
    value = separator === -1 ? null : part.slice(separator + 1);
  }
  return found && typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
    ? value
    : null;
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
 * record whose name the holder must already know.
 */
export async function intakeCookie(nonce, binding, { clear = false } = {}) {
  const name = `palomar_intake_${(await digest(nonce)).slice(0, 16)}`;
  const attributes = "Path=/oauth/callback; HttpOnly; Secure; SameSite=Lax";
  return clear
    ? `${name}=; ${attributes}; Max-Age=0`
    : `${name}=${binding}; ${attributes}; Max-Age=900`;
}

/** Read a binding named by an already validated lowercase-hex nonce digest. */
export function intakeBinding(request, nonceDigest) {
  const name = `palomar_intake_${nonceDigest.slice(0, 16)}`;
  const match = new RegExp(`(?:^|;\\s*)${name}=([0-9a-f]{64})(?:;|$)`)
    .exec(request.headers.get("cookie") ?? "");
  return match ? match[1] : null;
}
