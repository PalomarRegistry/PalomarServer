/**
 * The confidential certificate pair (contract v3.1, C6; part 11.3).
 *
 * One fixed pair per submission, made once when it is held: a full
 * certificate naming the repository and commit, and an anonymous one carrying
 * only a random id, the Challenge text, the toolchain and the verdict. Each is
 * `{schema, key_id, payload, signature}`, where `payload` is JSON text and the
 * signature is Ed25519 over its UTF-8 bytes exactly as stored, so a checker
 * needs no canonical form. Documents hold no status; `GET /api/cert/<id>` does.
 */

export const CERTIFICATE_SCHEMA = "palomar-certificate/1";
export const VERDICT = "verified and passed review";
const MAX_CHALLENGE_BYTES = 256 * 1024;

function base64(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64Url(text) {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

async function sha256Hex(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function certificateKeyConfigured(env) {
  return typeof env.CERTIFICATE_SIGNING_KEY === "string" && env.CERTIFICATE_SIGNING_KEY.includes("PRIVATE KEY");
}

/** The signing key and its public half's id, from a PKCS#8 PEM. */
export async function signingKey(pem) {
  const der = Uint8Array.from(
    atob(pem.replace(/-----(BEGIN|END) PRIVATE KEY-----|\s/g, "")), (c) => c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, true, ["sign"]);
  const publicKey = fromBase64Url((await crypto.subtle.exportKey("jwk", key)).x);
  return { key, publicKey: base64(publicKey), keyId: (await sha256Hex(publicKey)).slice(0, 16) };
}

export async function signCertificate(signer, payload) {
  const text = JSON.stringify(payload);
  const signature = await crypto.subtle.sign("Ed25519", signer.key, new TextEncoder().encode(text));
  return { schema: CERTIFICATE_SCHEMA, key_id: signer.keyId, payload: text, signature: base64(signature) };
}

/** Check a document against a base64 raw public key; used by tests and checkers alike. */
export async function verifyCertificate(document, publicKeyBase64) {
  const key = await crypto.subtle.importKey(
    "raw", Uint8Array.from(atob(publicKeyBase64), (c) => c.charCodeAt(0)), { name: "Ed25519" }, false, ["verify"],
  );
  return crypto.subtle.verify(
    "Ed25519", key, Uint8Array.from(atob(document.signature), (c) => c.charCodeAt(0)),
    new TextEncoder().encode(document.payload),
  );
}

const joined = (project, name) => (project ? `${project}/${name}` : name);

/**
 * The Challenge file and toolchain, read from the frozen tarball's entries.
 *
 * The Comparator configuration names the Challenge module; its file is the
 * one `.lean` file under the project whose path ends in that module's path.
 * Throws when either cannot be found unambiguously.
 */
export function certificateEvidence(entries, requestedPaths) {
  const files = new Map(entries.filter((entry) => entry.type === "file").map((entry) => [entry.path, entry]));
  const project = requestedPaths?.project_path || "";
  const decode = (entry) => new TextDecoder("utf-8", { fatal: true }).decode(entry.data);
  const toolchainEntry = files.get(joined(project, "lean-toolchain")) ?? files.get("lean-toolchain");
  if (!toolchainEntry) throw new Error("lean-toolchain is missing from the tarball");
  const configEntry = files.get(requestedPaths?.comparator_config_path ?? "");
  if (!configEntry) throw new Error("the Comparator configuration is missing from the tarball");
  const module = JSON.parse(decode(configEntry)).challenge_module;
  if (typeof module !== "string" || !/^[A-Za-z_][A-Za-z0-9_']*(\.[A-Za-z_][A-Za-z0-9_']*)*$/.test(module)) {
    throw new Error("the Comparator configuration names no Challenge module");
  }
  const suffix = `${module.replaceAll(".", "/")}.lean`;
  const candidates = [...files.keys()].filter((path) =>
    (!project || path.startsWith(`${project}/`)) && (path === suffix || path.endsWith(`/${suffix}`)));
  const exact = joined(project, suffix);
  const chosen = candidates.includes(exact) ? exact : candidates.length === 1 ? candidates[0] : null;
  if (!chosen) throw new Error("the Challenge file could not be found unambiguously");
  const challenge = files.get(chosen);
  if (challenge.size > MAX_CHALLENGE_BYTES) throw new Error("the Challenge file is too large");
  return { challengeBytes: challenge.data, challengeText: decode(challenge), toolchain: decode(toolchainEntry).trim() };
}

/** The two payloads, exactly as part 11.3 fixes them. */
export async function certificatePayloads({ lifecycle, evidence, anonymousId, issuedOn, origin }) {
  return {
    full: {
      kind: "full",
      palomar_id: lifecycle.id,
      repository: lifecycle.repository,
      commit: lifecycle.commit,
      source_sha256: lifecycle.source_sha256,
      challenge_sha256: await sha256Hex(evidence.challengeBytes),
      toolchain: evidence.toolchain,
      verdict: VERDICT,
      issued_on: issuedOn,
      status_url: `${origin}/api/cert/${lifecycle.id}`,
    },
    anonymous: {
      kind: "anonymous",
      certificate_id: anonymousId,
      challenge: evidence.challengeText,
      toolchain: evidence.toolchain,
      verdict: VERDICT,
      status_url: `${origin}/api/cert/${anonymousId}`,
    },
  };
}
