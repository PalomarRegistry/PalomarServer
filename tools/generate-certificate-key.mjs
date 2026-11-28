// Generate the Ed25519 key that signs confidential certificates.
//
// Usage: node tools/generate-certificate-key.mjs <private-key-path>
//
// Writes the PKCS#8 PEM private key to the path (mode 600, refusing to
// overwrite) and prints the public key entry for PalomarPolicy's
// keys/certificates.json and this repository's public/certificate-keys.json.
// Install the private key with:
//   npx wrangler secret put CERTIFICATE_SIGNING_KEY < <private-key-path>
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { signingKey } from "../src/certificates.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: node tools/generate-certificate-key.mjs <private-key-path>");
  process.exit(2);
}
const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
writeFileSync(path, pem, { mode: 0o600, flag: "wx" });
const { keyId, publicKey } = await signingKey(pem);
console.log(JSON.stringify({
  key_id: keyId,
  alg: "Ed25519",
  public_key: publicKey,
  not_before: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  revoked_at: null,
}, null, 2));
