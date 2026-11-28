/**
 * Who may start a confidential submission (contract v3.1, C1).
 *
 * `CONFIDENTIAL_INTAKE` is the single switch: `off` admits nobody, `test`
 * admits Technical Maintainers, `invited` adds the GitHub user ids in
 * `invited-confidential.json`. Anything else, including absence, reads as
 * `off`. Public intake is unaffected by every value.
 *
 * The invite list is a checked-in copy of PalomarPolicy's
 * `invited-confidential.json`, read at deploy time like the other policy data
 * this Worker bundles; `tools/check-confidential-invites.mjs` fails when the two
 * differ.
 */
import invites from "./invited-confidential.json" with { type: "json" };
import { isTechnicalMaintainer } from "./technical-maintainers.js";

const MODES = new Set(["off", "test", "invited"]);

export function validInvites(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join() === "github_user_ids,schema" &&
    value.schema === "palomar-confidential-invites/1" &&
    Array.isArray(value.github_user_ids) &&
    value.github_user_ids.every((id) => Number.isSafeInteger(id) && id > 0) &&
    new Set(value.github_user_ids).size === value.github_user_ids.length;
}

const invited = new Set(validInvites(invites) ? invites.github_user_ids : []);

export function confidentialIntakeMode(env) {
  const mode = String(env.CONFIDENTIAL_INTAKE ?? "off");
  return MODES.has(mode) ? mode : "off";
}

/** Is this deployment configured to run confidential submissions privately? */
export function confidentialRunsConfigured(env) {
  return typeof env.CONFIDENTIAL_RUNS_REPO === "string" &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.CONFIDENTIAL_RUNS_REPO) &&
    typeof env.CONFIDENTIAL_VERIFY_WORKFLOW === "string" &&
    /^[A-Za-z0-9_.-]+\.ya?ml$/.test(env.CONFIDENTIAL_VERIFY_WORKFLOW);
}

/** Could anyone at all start a confidential submission on this deployment? */
export function confidentialIntakeOpen(env) {
  return confidentialIntakeMode(env) !== "off" && confidentialRunsConfigured(env);
}

/** May this numeric GitHub principal start a confidential submission now? */
export function confidentialIntakeAllowed(env, principal, list = invited) {
  if (!confidentialIntakeOpen(env) || !Number.isSafeInteger(principal?.id)) return false;
  if (isTechnicalMaintainer(principal)) return true;
  return confidentialIntakeMode(env) === "invited" && list.has(principal.id);
}

// One refusal for every reason, so the answer says nothing about which one
// applied: switch, invitation, route or deployment.
export const CONFIDENTIAL_REFUSAL = {
  title: "Confidential submission is not available",
  detail: [
    "Confidential submission is open only to invited authors, through the browser form.",
  ],
};
