// The classification bounds reach the browser twice: bundled into
// public/preflight.js with the rest of the policy, and unbundled for the
// repair form, which the status page loads without the bundle. Generating the
// second copy keeps it from becoming a constant someone has to remember to
// change alongside the policy.
import { writeFile } from "node:fs/promises";

import policy from "../browser/preflight-policy.json" with { type: "json" };

const entries = Object.entries(policy.formalization.classification_cardinality)
  .map(([name, [, maximum]]) => `  ["classification.${name}", ${maximum}],`);

const module = `// Generated from browser/preflight-policy.json by
// tools/build-classification-limits.js. Run \`npm run build:preflight\`.
export const CLASSIFICATION_MAXIMUM = new Map([
${entries.join("\n")}
]);
`;

await writeFile(new URL("../public/classification-limits.js", import.meta.url), module);
