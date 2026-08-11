/** Presentation metadata mirrored from PalomarSubmission/formalization-profile.json. */
export const FORMALIZATION_PROFILE_VERSION = 1;

export const FORMALIZATION_FIELDS = Object.freeze({
  "project.name": {
    label: "Project name",
    description: "The name of the formalized result or project.",
    input: "text",
  },
  "project.license": {
    label: "Project license",
    description: "The SPDX identifier for the repository license; it must agree with the repository license file.",
    input: "text",
  },
  "classification.arxiv": {
    label: "arXiv classifications",
    description: "One or two arXiv category codes that describe the mathematical content.",
    input: "text-list",
  },
  "classification.msc2020": {
    label: "MSC 2020 classifications",
    description: "Between one and eight MSC 2020 classification codes.",
    input: "text-list",
  },
  "review.status": {
    label: "Review status",
    description: "The current review status claimed by the submitter; this is metadata, not a Palomar endorsement.",
    input: "text",
  },
});
