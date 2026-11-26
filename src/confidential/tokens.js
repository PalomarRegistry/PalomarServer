/**
 * Confidential token kinds, generation and hashing (contract v2 section 3).
 *
 * Every confidential token is 32 random bytes and is stored only as
 * `sha256(TOKEN_PEPPER ":" kind ":" token)`. The kind is part of the digest, so
 * a token of one kind can never match a stored token of another: an endpoint
 * that is handed the wrong kind sees an unknown token and answers with the
 * same 401 it gives every unknown token.
 */

import { digest, pepper } from "../submission.js";

export const TOKEN_KINDS = Object.freeze(["status", "release", "link", "capability", "ticket"]);

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function randomBytes(count) {
  return crypto.getRandomValues(new Uint8Array(count));
}

/** 32 random bytes, base64url without padding (43 characters). */
export function newToken() {
  let binary = "";
  for (const byte of randomBytes(32)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** The stored form of a token of one kind. */
export async function kindDigest(env, kind, token) {
  if (!TOKEN_KINDS.includes(kind)) throw new TypeError(`unknown token kind ${kind}`);
  return digest(`${pepper(env)}:${kind}:${token}`);
}

/** 32 random hex characters: a nonce. */
export function newNonce() {
  return [...randomBytes(16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 128 random bits as 26 lowercase base32 characters (the last carries 3 bits).
 * Used for certificate IDs, each generated independently of everything else.
 */
export function newRandomId() {
  const bytes = randomBytes(16);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Canonical JSON: keys sorted, no whitespace, UTF-8 raw, integers only. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new TypeError("canonical JSON carries integers only");
  }
  return JSON.stringify(value);
}
