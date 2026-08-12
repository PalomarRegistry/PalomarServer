/** Presentation and payload contract mirrored from PalomarSubmission profile v2. */
export const FORMALIZATION_PROFILE_VERSION = 2;
export const LEGACY_REPAIR_FIELDS = new Set([
  "project.name", "project.license", "classification.arxiv",
  "classification.msc2020", "review.status",
]);

export const SOURCE_TYPES = ["", "paper", "book", "web discussion", "folklore", "original-proof", "other"];
export const SOURCE_RELATIONSHIPS = ["formalizes", "adapts", "independently-proves", "background", "other"];
export const SOURCE_ENDORSEMENTS = ["", "participated", "endorsed", "no-response", "not-contacted", "declined", "n/a"];
export const AUTOMATION_METHODS = ["manual", "copilot", "agent", "autonomous", "other"];

export const FORMALIZATION_FIELDS = Object.freeze({
  "project.name": {
    label: "Project name", description: "The name of the formalized result or project.", input: "text",
  },
  "project.authors": {
    label: "Project authors", description: "People who authored the formalization. Palomar does not infer authorship.", input: "people",
  },
  "project.license": {
    label: "Project license", description: "The SPDX identifier matching the repository license file.", input: "text",
  },
  "project.responsible_maintainers": {
    label: "Responsible maintainers", description: "People responsible for the submitted formalization. Palomar does not infer this from authorship.", input: "people",
  },
  "classification.arxiv": {
    label: "arXiv classifications", description: "One or two official arXiv category codes, one per line.", input: "text-list",
  },
  "classification.msc2020": {
    label: "MSC 2020 classifications", description: "Between one and eight official MSC 2020 codes, one per line.", input: "text-list",
  },
  sources: {
    label: "Mathematical sources", description: "Every source needs a title and an accurate relationship to the formalized result.", input: "sources",
  },
  "automation.methods": {
    label: "Automation methods", description: "Describe each distinct way the formalization was produced; use manual when appropriate.", input: "methods",
  },
  "review.status": {
    label: "Review status", description: "The review completed before submission; this is not a Palomar endorsement.", input: "text",
  },
  "repository.substantive_formalization": {
    label: "Substantive formalization", description: "Only for a thin wrapper: the underlying owner/repository and full commit.", input: "substantive-repository",
  },
});

export function lines(value) {
  return String(value ?? "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

export function safeDraft(failure, field) {
  const values = failure?.repair_draft?.values;
  return values && Object.hasOwn(values, field) ? values[field] : undefined;
}
