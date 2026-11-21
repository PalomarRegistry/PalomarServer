/**
 * Installation tokens for the two Palomar GitHub Apps.
 *
 * A personal access token spends its owner's REST allowance, which every other
 * thing that person runs shares, so an unrelated burst there took submission
 * down with it. An App installation has an allowance of its own. Two Apps, not
 * one, for the reason README gives for two tokens: the State App must not be
 * able to write the verification code in `PalomarSubmission`.
 *
 * Each App's key is stored as PKCS#8 (`openssl pkcs8 -topk8 -nocrypt` converts
 * the PKCS#1 file GitHub issues). A deployment without an App's key falls back
 * to the static token of the same role, which is what tests and local
 * development use.
 */

const API = "https://api.github.com";

// Only the token string and its expiry outlive a request.
const tokens = new Map();

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

const json64 = (value) => base64Url(new TextEncoder().encode(JSON.stringify(value)));

async function appJwt(appId, pem, now) {
  const der = Uint8Array.from(
    atob(pem.replace(/-----(BEGIN|END) PRIVATE KEY-----|\s/g, "")),
    (character) => character.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  // Backdated a minute for clock skew; GitHub refuses a lifetime over ten.
  const issued = Math.floor(now / 1000) - 60;
  const unsigned = `${json64({ alg: "RS256", typ: "JWT" })}.${json64({ iat: issued, exp: issued + 540, iss: appId })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

async function appCall(jwt, path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "palomar-server",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub App ${path}: ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  return response.json();
}

/** A token for the App installed on `repository`, renewed five minutes early. */
export async function installationToken(appId, privateKey, repository, now = Date.now()) {
  const cached = tokens.get(repository);
  if (cached && cached.expiresAt - now > 5 * 60_000) return cached.token;
  const jwt = await appJwt(appId, privateKey, now);
  const { id } = await appCall(jwt, `/repos/${repository}/installation`);
  const minted = await appCall(jwt, `/app/installations/${id}/access_tokens`, { method: "POST" });
  tokens.set(repository, { token: minted.token, expiresAt: Date.parse(minted.expires_at) });
  return minted.token;
}

/** `env` with each role's token minted from its App, where that App is configured. */
export async function withInstallationTokens(env) {
  const [state, submission] = await Promise.all([
    env.STATE_APP_PRIVATE_KEY &&
      installationToken(env.STATE_APP_ID, env.STATE_APP_PRIVATE_KEY, env.STATE_REPO),
    env.SUBMISSION_APP_PRIVATE_KEY &&
      installationToken(env.SUBMISSION_APP_ID, env.SUBMISSION_APP_PRIVATE_KEY, env.SUBMISSION_REPO),
  ]);
  return {
    ...env,
    GITHUB_TOKEN: state || env.GITHUB_TOKEN,
    SUBMISSION_TOKEN: submission || env.SUBMISSION_TOKEN,
  };
}
