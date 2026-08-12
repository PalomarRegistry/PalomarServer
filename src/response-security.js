/** Shared headers for every dynamic response, including OAuth redirects. */

export const SECURITY_HEADERS = {
  // The intake form checks the repository, commit, and cited Palomar ID in the
  // browser. The answers are hints only; the Server checks them again.
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self' https://api.github.com https://data.palomar-registry.org; " +
    "base-uri 'none'; form-action 'self' https://github.com; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  // Private API responses are already uncacheable. Keep the credential in the
  // cache key too so weakening that policy cannot mix two submissions.
  "vary": "authorization",
};
