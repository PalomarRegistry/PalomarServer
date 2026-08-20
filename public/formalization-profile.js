/** Presentation and payload contract mirrored from PalomarSubmission profile v4. */
export const FORMALIZATION_PROFILE_VERSION = 4;
export const LEGACY_REPAIR_FIELDS = new Set([
  "project.name", "project.license", "classification.arxiv",
  "classification.msc2020", "review.status",
]);

export const SOURCE_RELATIONSHIP_SUGGESTIONS = [
  "formalizes", "adapts", "independently-proves", "background", "other",
];
export const SOURCE_ENDORSEMENT_SUGGESTIONS = [
  "participated", "endorsed", "no-response", "not-contacted", "declined", "n/a", "other",
];
export const AUTOMATION_METHOD_SUGGESTIONS = [
  "manual", "copilot", "agent", "autonomous", "other",
];
export const SUBSTANTIVE_SOURCE_RELATIONSHIPS = new Set([
  "formalizes", "adapts", "independently-proves",
]);

/** Map free-form source descriptions into the closed public provenance categories. */
export function sourceRelationshipCategory(value) {
  return SOURCE_RELATIONSHIP_SUGGESTIONS.includes(value) ? value : "other";
}

export const FORMALIZATION_FIELDS = Object.freeze({
  "project.name": {
    label: "Project name", description: "The name of the formalized result or project.", input: "text",
  },
  "project.description": {
    label: "Project description",
    description: "A concise public account of the mathematical content and principal results of the formalization as a whole.",
    input: "prose",
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
    label: "arXiv classifications", description: "One to eight official arXiv category codes.", input: "text-list",
  },
  "classification.msc2020": {
    label: "MSC 2020 classifications", description: "Up to eight official MSC 2020 codes; leave empty if none apply.", input: "text-list",
  },
  sources: {
    label: "Mathematical sources", description: "Every source needs a title and an accurate relationship to the formalized result. Use named contributor roles for non-author credits. Source type is optional free text; original-proof is reserved for results first presented by the formalization.", input: "sources",
  },
  "automation.methods": {
    label: "Automation methods", description: "Choose the closest standard production category; Palomar also accepts unfamiliar wording at intake.", input: "methods",
  },
  "review.status": {
    label: "Review status", description: "This describes the review process you have already undertaken for this repository; it is not a Palomar endorsement.", input: "text",
  },
  "repository.substantive_formalization": {
    label: "Substantive formalization", description: "Only for a thin wrapper: the underlying owner/repository and full commit.", input: "substantive-repository",
  },
});

export function lines(value) {
  return String(value ?? "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

export function sourceContributorLines(value) {
  return lines(value).map((credit) => {
    const separator = credit.indexOf("|");
    return separator < 0
      ? { name: credit, role: "" }
      : {
        name: credit.slice(0, separator).trim(),
        role: credit.slice(separator + 1).trim(),
      };
  });
}

export function sourceContributorText(value) {
  return (value ?? [])
    .map((contributor) => `${contributor.name} | ${contributor.role}`)
    .join("\n");
}

export function classificationMaximum(field) {
  return field === "classification.arxiv" ? 2 : 8;
}

export function canAddClassification(field, count) {
  return count < classificationMaximum(field);
}

export function safeDraft(failure, field) {
  const values = failure?.repair_draft?.values;
  const value = values && Object.hasOwn(values, field) ? values[field] : undefined;
  return Array.isArray(value) && field.startsWith("classification.")
    ? value.slice(0, classificationMaximum(field))
    : value;
}
