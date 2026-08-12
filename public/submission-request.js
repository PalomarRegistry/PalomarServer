const TOKEN = /^[0-9a-f]{64}$/;

/** Whether a fragment is a complete Palomar submission capability. */
export function validSubmissionToken(token) {
  return TOKEN.test(token);
}

/**
 * Send one private status-page request with the capability owned by this tab.
 *
 * A cookie is shared by every tab on the host, so it cannot identify which of
 * two simultaneously open submission pages made a request. The fragment is
 * tab-local. Present it explicitly and omit ambient credentials, keeping one
 * page unable to read or act on the submission open in another page.
 */
export function submissionRequest(token, path, init = {}) {
  if (!validSubmissionToken(token)) throw new TypeError("invalid submission token");
  if (
    typeof path !== "string" || !path.startsWith("/") ||
    path.startsWith("//") || path.includes("\\")
  ) {
    throw new TypeError("submission requests must stay on this origin");
  }
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return fetch(path, { ...init, headers, credentials: "omit", redirect: "error" });
}
