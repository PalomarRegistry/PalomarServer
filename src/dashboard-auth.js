/** Short-lived GitHub-team authorization for the private dashboard. */

const OAUTH_COOKIE = "__Host-palomar_dashboard_oauth";
const SESSION_COOKIE = "__Host-palomar_dashboard";
const TEAM = "technical-maintainers";
const ORG = "PalomarRegistry";
const encoder = new TextEncoder();


function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}


function base64UrlToBytes(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}


function cookieValue(request, expected) {
  const matches = [];
  for (const raw of (request.headers.get("cookie") ?? "").split(";")) {
    const part = raw.replace(/^[ \t]+/, "");
    const separator = part.indexOf("=");
    const name = separator === -1 ? part : part.slice(0, separator);
    if (name === expected) matches.push(separator === -1 ? "" : part.slice(separator + 1));
  }
  return matches.length === 1 ? matches[0] : null;
}


async function hmacKey(env) {
  if (!env.TOKEN_PEPPER) throw new Error("TOKEN_PEPPER is unset");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(`palomar-dashboard-v1:${env.TOKEN_PEPPER}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}


async function signed(env, payload) {
  const body = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(env), encoder.encode(body));
  return `${body}.${bytesToBase64Url(new Uint8Array(signature))}`;
}


async function verified(env, value) {
  if (typeof value !== "string") return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const signature = base64UrlToBytes(parts[1]);
  const body = base64UrlToBytes(parts[0]);
  if (!signature || !body) return null;
  if (!(await crypto.subtle.verify("HMAC", await hmacKey(env), signature, encoder.encode(parts[0])))) {
    return null;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
}


function setCookie(name, value, maxAge, sameSite) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=${sameSite}`;
}


export async function beginDashboardLogin(request, env) {
  const nonce = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const state = `dashboard_${nonce}`;
  const binding = await signed(env, { nonce, expires: Date.now() + 10 * 60_000 });
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", env.OAUTH_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", `${new URL(request.url).origin}/oauth/callback`);
  authorize.searchParams.set("scope", "read:user read:org");
  authorize.searchParams.set("state", state);
  return new Response(null, {
    status: 303,
    headers: {
      location: authorize.toString(),
      "cache-control": "no-store",
      "set-cookie": setCookie(OAUTH_COOKIE, binding, 600, "Lax"),
    },
  });
}


async function githubJson(url, token, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "palomar-server",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) return { response, value: null };
  return { response, value: response.status === 204 ? true : await response.json() };
}


export async function completeDashboardLogin(request, env) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const match = /^dashboard_([A-Za-z0-9_-]{43})$/.exec(state);
  const binding = await verified(env, cookieValue(request, OAUTH_COOKIE));
  const clear = setCookie(OAUTH_COOKIE, "", 0, "Lax");
  if (!match || binding?.nonce !== match[1] || binding.expires < Date.now()) {
    return new Response("Invalid or expired dashboard sign-in.\n", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "set-cookie": clear },
    });
  }
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env.OAUTH_CLIENT_ID,
      client_secret: env.OAUTH_CLIENT_SECRET,
      code: url.searchParams.get("code"),
    }),
  });
  const granted = await tokenResponse.json();
  if (!granted?.access_token) {
    return new Response("GitHub declined that sign-in.\n", { status: 403, headers: { "set-cookie": clear } });
  }
  const user = await githubJson("https://api.github.com/user", granted.access_token);
  const login = user.value?.login;
  if (typeof login !== "string") {
    return new Response("GitHub did not identify that account.\n", { status: 403, headers: { "set-cookie": clear } });
  }
  const membership = await githubJson(
    `https://api.github.com/orgs/${ORG}/teams/${TEAM}/memberships/${encodeURIComponent(login)}`,
    granted.access_token,
  );
  if (membership.value?.state !== "active") {
    return new Response("This dashboard is limited to Palomar Technical Maintainers.\n", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "set-cookie": clear },
    });
  }
  // The GitHub token is deliberately not retained. Team removal takes effect
  // no later than this short session's expiry.
  const session = await signed(env, { login, expires: Date.now() + 15 * 60_000 });
  const headers = new Headers({ location: "/dashboard", "cache-control": "no-store" });
  headers.append("set-cookie", clear);
  headers.append("set-cookie", setCookie(SESSION_COOKIE, session, 900, "Strict"));
  return new Response(null, {
    status: 303,
    headers,
  });
}


export async function dashboardPrincipal(request, env) {
  const session = await verified(env, cookieValue(request, SESSION_COOKIE));
  if (
    typeof session?.login !== "string" ||
    typeof session?.expires !== "number" ||
    session.expires < Date.now()
  ) return null;
  return session.login;
}


export const DASHBOARD_TEAM = `${ORG}/${TEAM}`;
