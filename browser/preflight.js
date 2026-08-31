import { isMap, isSeq, parseDocument, stringify } from "yaml";

import {
  classificationMaximum,
  PROJECT_NAME_MAXIMUM,
  SUBSTANTIVE_SOURCE_RELATIONSHIPS,
} from "../public/formalization-profile.js";
import policy from "./preflight-policy.json" with { type: "json" };

export const BROWSER_PREFLIGHT_POLICY = policy;

function diagnostic(code, summary, { field = null, path = null, advisory = false } = {}) {
  return {
    code,
    summary,
    ...(field ? { field } : {}),
    ...(path ? { path } : {}),
    ...(advisory ? { advisory: true } : {}),
  };
}

function mapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function canonicalizeClassificationKeys(data) {
  const classification = mapping(data.classification);
  for (const canonical of ["arxiv", "msc2020"]) {
    const matches = Object.keys(classification)
      .filter((key) => key.toLocaleLowerCase("en-US") === canonical);
    if (matches.length > 1) return false;
    if (matches.length === 1 && matches[0] !== canonical) {
      classification[canonical] = classification[matches[0]];
      delete classification[matches[0]];
    }
  }
  return true;
}

function nonempty(value) {
  return typeof value === "string" && value.trim() !== "";
}

function people(value) {
  return Array.isArray(value) && value.length > 0 && value.every((person) =>
    nonempty(person) || (mapping(person) === person && nonempty(person.name)));
}

function addOptionalSourceText(result, value, label, index, maximum) {
  // A bare `note:` key parses to null, which the server contract reads as an
  // absent field rather than an empty one.
  if (value === undefined || value === null || value === "") return;
  if (!nonempty(value)) {
    addField(result, false, "sources", `entry ${index + 1} ${label} must be a nonempty string when supplied.`);
  } else if (value.trim().length > maximum) {
    addField(result, false, "sources", `entry ${index + 1} ${label} must be at most ${maximum} characters.`);
  }
}

function addField(result, condition, field, requirement) {
  if (!condition) {
    result.push(diagnostic(
      "formalization.invalid_field",
      `${field} ${requirement}`,
      { field, path: "formalization.yaml" },
    ));
  }
}

function containsMergeKey(node) {
  if (isMap(node)) {
    return node.items.some((pair) => pair.key?.value === "<<" ||
      containsMergeKey(pair.key) || containsMergeKey(pair.value));
  }
  if (isSeq(node)) return node.items.some(containsMergeKey);
  return false;
}

export function validateFormalization(text, selectedPolicy = policy) {
  if (new TextEncoder().encode(text).length > selectedPolicy.limits.formalization_bytes) {
    return [diagnostic(
      "formalization.too_large",
      "formalization.yaml exceeds the 256 KiB limit.",
      { path: "formalization.yaml" },
    )];
  }
  let document;
  try {
    document = parseDocument(text, { merge: false, prettyErrors: false, uniqueKeys: true });
  } catch {
    return [diagnostic(
      "formalization.invalid_yaml",
      "formalization.yaml is not valid YAML.",
      { path: "formalization.yaml" },
    )];
  }
  if (document.errors.length || containsMergeKey(document.contents)) {
    return [diagnostic(
      "formalization.invalid_yaml",
      containsMergeKey(document.contents)
        ? "formalization.yaml must not use YAML merge keys."
        : "formalization.yaml contains invalid or duplicate YAML keys.",
      { path: "formalization.yaml" },
    )];
  }
  let data;
  try {
    data = document.toJS({ maxAliasCount: 100 });
  } catch {
    return [diagnostic(
      "formalization.invalid_yaml",
      "formalization.yaml could not be read safely.",
      { path: "formalization.yaml" },
    )];
  }
  if (mapping(data) !== data) {
    return [diagnostic(
      "formalization.wrong_root_type",
      "formalization.yaml must contain one top-level mapping.",
      { path: "formalization.yaml" },
    )];
  }
  if (!canonicalizeClassificationKeys(data)) {
    return [diagnostic(
      "formalization.invalid_yaml",
      "formalization.yaml contains duplicate classification keys differing only by case.",
      { path: "formalization.yaml" },
    )];
  }

  const result = [];
  const project = mapping(data.project);
  addField(
    result,
    nonempty(project.name) && project.name.trim().length <= PROJECT_NAME_MAXIMUM,
    "project.name",
    `must be a nonempty string of at most ${PROJECT_NAME_MAXIMUM} characters.`,
  );
  addField(
    result,
    nonempty(project.description) && project.description.trim().length <= 10_000,
    "project.description",
    "must be a nonempty string of at most 10000 characters.",
  );
  addField(result, people(project.authors), "project.authors", "must be a nonempty list of people.");
  addField(result, nonempty(project.license), "project.license", "must be a nonempty string.");
  const maintainers = project.responsible_maintainers ??
    (project.responsible_maintainer === undefined
      ? undefined
      : Array.isArray(project.responsible_maintainer)
        ? project.responsible_maintainer
        : [project.responsible_maintainer]);
  addField(
    result,
    people(maintainers),
    "project.responsible_maintainers",
    "must be a nonempty list of people.",
  );

  const classification = mapping(data.classification);
  for (const name of ["arxiv", "msc2020"]) {
    const field = `classification.${name}`;
    const values = classification[name];
    const [minimum, maximum] = selectedPolicy.formalization.classification_cardinality[name];
    const acceptedValues = values === undefined && minimum === 0 ? [] : values;
    const withinMaximum = maximum === null || acceptedValues?.length <= maximum;
    addField(
      result,
      Array.isArray(acceptedValues) && acceptedValues.length >= minimum && withinMaximum &&
        acceptedValues.every(nonempty) && new Set(acceptedValues).size === acceptedValues.length,
      field,
      maximum === null
        ? `must contain at least ${minimum} distinct code.`
        : `must contain ${minimum}–${maximum} distinct codes.`,
    );
  }

  const sources = data.sources;
  const relationshipCategories = new Set(
    selectedPolicy.formalization.source_relationship_categories,
  );
  addField(result, Array.isArray(sources) && sources.length > 0, "sources", "must be a nonempty list.");
  if (Array.isArray(sources) && sources.length) {
    let original = false;
    let substantive = false;
    sources.forEach((raw, index) => {
      const source = mapping(raw);
      addField(result, nonempty(source.title), "sources", `entry ${index + 1} needs a title.`);
      // An absent or empty `contributors:` key carries no claim, so the server
      // contract accepts both; only a present non-list is a defect.
      if (source.contributors !== undefined && source.contributors !== null) {
        if (!Array.isArray(source.contributors)) {
          addField(result, false, "sources", `entry ${index + 1} contributors must be a list.`);
        } else {
          source.contributors.forEach((contributor, position) => {
            const label = `entry ${index + 1} contributor ${position + 1}`;
            if (mapping(contributor) !== contributor) {
              addField(result, false, "sources", `${label} must be a mapping with a name and role.`);
              return;
            }
            if (!nonempty(contributor.name)) {
              addField(result, false, "sources", `${label} needs a name.`);
            }
            if (!nonempty(contributor.role)) {
              addField(result, false, "sources", `${label} needs a role.`);
            } else if (contributor.role.trim().length > 200) {
              addField(result, false, "sources", `${label} role must be at most 200 characters.`);
            }
          });
        }
      }
      if (!nonempty(source.relationship)) {
        addField(
          result,
          false,
          "sources",
          `entry ${index + 1} needs a relationship; original-proof entries must use other.`,
        );
      } else {
        addField(
          result,
          source.relationship.trim().length <= 500,
          "sources",
          `entry ${index + 1} relationship must be at most 500 characters.`,
        );
      }
      addOptionalSourceText(result, source.type, "type", index, 200);
      addOptionalSourceText(
        result,
        source.author_endorsement,
        "author endorsement",
        index,
        100,
      );
      addOptionalSourceText(result, source.note, "note", index, 10_000);
      const relationshipText = nonempty(source.relationship) ? source.relationship.trim() : "";
      const relationship = relationshipCategories.has(relationshipText)
        ? relationshipText
        : "other";
      // The server reads `type` through the same trimming as the other bounded
      // text fields, so padding must not change what the entry claims to be.
      const originalProof = nonempty(source.type) && source.type.trim() === "original-proof";
      original ||= originalProof;
      substantive ||= SUBSTANTIVE_SOURCE_RELATIONSHIPS.has(relationship);
      if (originalProof && relationship !== "other") {
        addField(result, false, "sources", "original-proof entries must use relationship other.");
      }
    });
    addField(
      result,
      original ? !substantive : substantive,
      "sources",
      original
        ? "original proofs may use only background or other relationships."
        : "source-based results need a formalizes, adapts, or independently-proves relationship.",
    );
  }

  const methods = mapping(data.automation).methods;
  addField(
    result,
    Array.isArray(methods) && methods.length > 0 && methods.every((item) =>
      mapping(item) === item && nonempty(item.method) && item.method.trim().length <= 500),
    "automation.methods",
    "must be a nonempty list whose entries name a method in at most 500 characters.",
  );
  addField(
    result,
    nonempty(mapping(data.review).status),
    "review.status",
    "must be a nonempty string.",
  );

  if (data.repository !== undefined) {
    const repository = mapping(data.repository);
    const role = repository.role ||
      (repository.substantive_formalization ? "thin-wrapper" : "substantive-development");
    addField(
      result,
      selectedPolicy.formalization.repository_roles.includes(role),
      "repository.substantive_formalization",
      "uses an unsupported repository role.",
    );
    if (role === "thin-wrapper") {
      const substantiveRepository = mapping(repository.substantive_formalization);
      addField(
        result,
        nonempty(substantiveRepository.id) &&
          /^[0-9a-f]{40}$/.test(substantiveRepository.revision || ""),
        "repository.substantive_formalization",
        "must name a repository and full lowercase commit.",
      );
    } else if (repository.substantive_formalization !== undefined) {
      addField(
        result,
        false,
        "repository.substantive_formalization",
        "is valid only for a thin wrapper.",
      );
    }
  }
  return result;
}

function parsedFormalization(text) {
  try {
    const document = parseDocument(text, { merge: false, prettyErrors: false, uniqueKeys: true });
    if (document.errors.length || containsMergeKey(document.contents)) return null;
    const data = document.toJS({ maxAliasCount: 100 });
    return mapping(data) === data && canonicalizeClassificationKeys(data) ? data : null;
  } catch {
    return null;
  }
}

/** Resolve the public project description while preserving legacy provenance for migration UI. */
export function formalizationDescription(text) {
  const data = parsedFormalization(text);
  if (!data) return null;
  const project = mapping(data.project);
  for (const [value, origin] of [
    [project.description, "project.description"],
    [project.short_description, "project.short_description"],
    [mapping(data.result).statement, "result.statement"],
    [project.name, "project.name"],
  ]) {
    if (nonempty(value)) {
      return {
        text: value.trim().slice(0, 10_000),
        origin,
        dedicated: origin === "project.description",
      };
    }
  }
  return null;
}

/** Names whose mathematical content the description must orient a reader toward. */
export function comparatorDeclarations(text) {
  try {
    const data = JSON.parse(text);
    if (mapping(data) !== data) return [];
    return [...(Array.isArray(data.theorem_names) ? data.theorem_names : []),
      ...(Array.isArray(data.definition_names) ? data.definition_names : [])]
      .filter(nonempty).map((item) => item.trim());
  } catch {
    return [];
  }
}

function safePeople(value) {
  if (!Array.isArray(value) || !value.length) return null;
  const result = value.map((person) => {
    if (nonempty(person)) return person.trim();
    return mapping(person) === person && nonempty(person.name) ? person.name.trim() : null;
  });
  return result.every(Boolean) ? result : null;
}

function safeStrings(value) {
  return Array.isArray(value) && value.length && value.every(nonempty)
    ? value.map((item) => item.trim())
    : null;
}

function safeSource(value) {
  if (mapping(value) !== value) return {};
  const result = {};
  if (nonempty(value.title)) result.title = value.title.trim();
  const authors = safePeople(value.authors ??
    (value.author === undefined ? undefined : [value.author]));
  if (authors) result.authors = authors;
  if (Array.isArray(value.contributors)) {
    const contributors = value.contributors.flatMap((contributor) => {
      if (
        mapping(contributor) !== contributor ||
        !nonempty(contributor.name) ||
        !nonempty(contributor.role) ||
        contributor.role.trim().length > 200
      ) return [];
      return [{ name: contributor.name.trim(), role: contributor.role.trim() }];
    });
    if (contributors.length) result.contributors = contributors;
  }
  for (const field of ["id", "location", "license"]) {
    if (nonempty(value[field])) result[field] = value[field].trim();
  }
  for (const [field, maximum] of [
    ["type", 200], ["relationship", 500], ["note", 10_000], ["author_endorsement", 100],
  ]) {
    if (nonempty(value[field]) && value[field].trim().length <= maximum) {
      result[field] = value[field].trim();
    }
  }
  return result;
}

/** Safe, submitter-confirmed prefills for the guided metadata form. */
export function formalizationRepairDraft(text) {
  const data = parsedFormalization(text);
  if (!data) return { values: {}, origins: {} };
  const values = {};
  const origins = {};
  const project = mapping(data.project);
  const artifact = mapping(data.artifact);
  for (const [field, current, legacy] of [
    ["project.name", project.name, artifact.name],
    ["project.license", project.license, artifact.license],
  ]) {
    const value = nonempty(current) ? current.trim() : nonempty(legacy) ? legacy.trim() : null;
    if (value) {
      values[field] = value;
      origins[field] = nonempty(current) ? field : `artifact.${field.split(".").at(-1)}`;
    }
  }
  for (const [candidate, origin] of [
    [project.description, "project.description"],
    [project.short_description, "project.short_description"],
    [mapping(data.result).statement, "result.statement"],
    [project.name, "project.name"],
  ]) {
    if (nonempty(candidate)) {
      values["project.description"] = candidate.trim().slice(0, 10_000);
      origins["project.description"] = origin;
      break;
    }
  }
  for (const [field, current, legacy, legacyOrigin] of [
    ["project.authors", project.authors, artifact.authors, "artifact.authors"],
    ["project.responsible_maintainers", project.responsible_maintainers,
      project.responsible_maintainer, "project.responsible_maintainer"],
  ]) {
    const currentPeople = safePeople(current);
    const legacyPeople = safePeople(Array.isArray(legacy) ? legacy : legacy === undefined ? legacy : [legacy]);
    if (currentPeople || legacyPeople) {
      values[field] = currentPeople ?? legacyPeople;
      origins[field] = currentPeople ? field : legacyOrigin;
    }
  }
  const classification = mapping(data.classification);
  for (const name of ["arxiv", "msc2020"]) {
    const items = safeStrings(classification[name]);
    if (items) {
      const field = `classification.${name}`;
      values[field] = items.slice(0, classificationMaximum(field));
      origins[field] = field;
    }
  }
  const rawSources = Array.isArray(data.sources) && data.sources.length
    ? data.sources
    : mapping(data.source) === data.source ? [data.source] : [];
  const sources = rawSources.map((item) => safeSource(item));
  if (sources.length) {
    values.sources = sources;
    origins.sources = Array.isArray(data.sources) && data.sources.length ? "sources" : "source";
  }
  const automation = mapping(data.automation);
  const rawMethods = Array.isArray(automation.methods) && automation.methods.length
    ? automation.methods
    : nonempty(automation.method) ? [automation] : [];
  const methods = rawMethods.flatMap((raw) => {
    const item = mapping(raw);
    if (!nonempty(item.method)) return [];
    const method = { method: item.method.trim() };
    if (nonempty(item.framework)) method.framework = item.framework.trim();
    const models = safeStrings(item.models);
    if (models) method.models = models;
    return [method];
  });
  if (methods.length) {
    values["automation.methods"] = methods;
    origins["automation.methods"] = Array.isArray(automation.methods) && automation.methods.length
      ? "automation.methods" : "automation.method";
  }
  if (nonempty(mapping(data.review).status)) {
    values["review.status"] = data.review.status.trim();
    origins["review.status"] = "review.status";
  }
  const substantive = mapping(mapping(data.repository).substantive_formalization);
  if (nonempty(substantive.id) && /^[0-9a-f]{40}$/.test(substantive.revision ?? "")) {
    values["repository.substantive_formalization"] = {
      id: substantive.id.trim(), revision: substantive.revision,
    };
    origins["repository.substantive_formalization"] =
      "repository.substantive_formalization";
  }
  return { values, origins };
}

/** Check that a complete guided edit set resolves every portable metadata issue. */
export function canApplyFormalizationRepair(text, fields) {
  const data = parsedFormalization(text);
  if (!data || !Array.isArray(fields) || !fields.length) return false;
  for (const field of fields) {
    if (!nonempty(field)) return false;
    let parent = data;
    for (const part of field.split(".").slice(0, -1)) {
      if (parent[part] === undefined || parent[part] === null) {
        parent = {};
      } else if (mapping(parent[part]) === parent[part]) {
        parent = parent[part];
      } else {
        return false;
      }
    }
  }
  return true;
}

export function validateFormalizationRepair(text, edits, selectedPolicy = policy) {
  const data = parsedFormalization(text);
  if (!data || !Array.isArray(edits) ||
      !canApplyFormalizationRepair(text, edits.map((item) => item?.field))) {
    return [diagnostic("formalization.invalid_yaml", "formalization.yaml cannot be repaired safely.")];
  }
  const candidate = structuredClone(data);
  for (const edit of edits) {
    if (!nonempty(edit?.field)) continue;
    const parts = edit.field.split(".");
    let parent = candidate;
    for (const part of parts.slice(0, -1)) {
      if (parent[part] === undefined || parent[part] === null) parent[part] = {};
      parent = parent[part];
    }
    parent[parts.at(-1)] = structuredClone(edit.value);
  }
  return validateFormalization(stringify(candidate), selectedPolicy);
}

/** Return guided fields only when they cover every blocking preliminary finding. */
export function guidedFormalizationDiagnostics(diagnostics) {
  if (!Array.isArray(diagnostics)) return [];
  const blocking = diagnostics.filter((item) => !item?.advisory);
  if (!blocking.length || blocking.some((item) =>
    item?.code !== "formalization.invalid_field" || !nonempty(item.field))) {
    return [];
  }
  return [...new Map(blocking.map((item) => [item.field, item])).values()];
}

function jsonTokens(text) {
  const tokens = [];
  for (let index = 0; index < text.length;) {
    if (/\s/.test(text[index])) {
      index += 1;
      continue;
    }
    if ('{}[],:'.includes(text[index])) {
      tokens.push(text[index]);
      index += 1;
      continue;
    }
    if (text[index] === '"') {
      const start = index++;
      while (index < text.length) {
        if (text[index] === "\\") index += 2;
        else if (text[index++] === '"') break;
      }
      tokens.push({ string: JSON.parse(text.slice(start, index)) });
      continue;
    }
    const start = index;
    while (index < text.length && !/[\s{}[\],:]/.test(text[index])) index += 1;
    tokens.push({ primitive: text.slice(start, index) });
  }
  return tokens;
}

export function duplicateJsonKeys(text) {
  const tokens = jsonTokens(text);
  const duplicates = new Set();
  let cursor = 0;
  function value() {
    const token = tokens[cursor++];
    if (token === "{") {
      const keys = new Set();
      while (tokens[cursor] !== "}") {
        const key = tokens[cursor++].string;
        if (keys.has(key)) duplicates.add(key);
        keys.add(key);
        cursor += 1;
        value();
        if (tokens[cursor] === ",") cursor += 1;
      }
      cursor += 1;
    } else if (token === "[") {
      while (tokens[cursor] !== "]") {
        value();
        if (tokens[cursor] === ",") cursor += 1;
      }
      cursor += 1;
    }
  }
  value();
  return [...duplicates].sort();
}

export function validateComparator(text, selectedPolicy = policy) {
  if (new TextEncoder().encode(text).length > selectedPolicy.limits.configuration_bytes) {
    return [diagnostic("comparator.too_large", "Comparator configuration exceeds 1 MiB.")];
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    return [diagnostic("comparator.invalid_json", "Comparator configuration is not valid JSON.")];
  }
  const duplicates = duplicateJsonKeys(text);
  if (duplicates.length) {
    return [diagnostic(
      "comparator.duplicate_key",
      `Comparator configuration repeats: ${duplicates.join(", ")}.`,
    )];
  }
  if (mapping(config) !== config) {
    return [diagnostic("comparator.wrong_root_type", "Comparator configuration must be one object.")];
  }
  const result = [];
  const keys = new Set(Object.keys(config));
  const missing = selectedPolicy.comparator.required_keys.filter((key) => !keys.has(key));
  const unknown = [...keys].filter((key) => !selectedPolicy.comparator.allowed_keys.includes(key));
  if (missing.length) result.push(diagnostic("comparator.missing_key", `Comparator configuration is missing: ${missing.join(", ")}.`));
  if (unknown.length) result.push(diagnostic("comparator.unknown_key", `Comparator configuration has unknown keys: ${unknown.join(", ")}.`));
  const modulePattern = /^[A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)*$/;
  for (const name of ["challenge_module", "solution_module"]) {
    if (!modulePattern.test(config[name] || "")) {
      result.push(diagnostic("comparator.invalid_module", `${name} is not a safe dotted Lean module.`, { field: name }));
    }
  }
  if (config.challenge_module === config.solution_module) {
    result.push(diagnostic("comparator.same_module", "Challenge and Solution modules must be distinct."));
  }
  for (const [name, required] of [["theorem_names", true], ["definition_names", false]]) {
    const values = config[name] ?? [];
    if (!Array.isArray(values) || (required && values.length === 0) || !values.every(nonempty)) {
      result.push(diagnostic("comparator.invalid_declarations", `${name} must contain nonempty declaration names.`, { field: name }));
    }
  }
  const axioms = config.permitted_axioms;
  if (!Array.isArray(axioms) || !axioms.every((item) => selectedPolicy.comparator.standard_axioms.includes(item))) {
    result.push(diagnostic("comparator.invalid_axioms", "permitted_axioms exceeds Palomar's standard allowlist.", { field: "permitted_axioms" }));
  }
  return result;
}

function leanVersion(value, pattern) {
  const match = new RegExp(pattern).exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ? 0 : 1, Number(match[4] || 0)];
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function validateToolchain(text, selectedPolicy = policy) {
  const current = leanVersion(text, selectedPolicy.toolchain.pattern);
  if (!current) return [diagnostic("toolchain.invalid", "lean-toolchain does not name a supported Lean release.")];
  const minimum = leanVersion(`leanprover/lean4:${selectedPolicy.toolchain.minimum}`, selectedPolicy.toolchain.pattern);
  if (compareVersions(current, minimum) < 0) {
    return [diagnostic("toolchain.unsupported", `Lean is older than Palomar's minimum (${selectedPolicy.toolchain.minimum}).`)];
  }
  return [];
}

function joined(project, name) {
  return project ? `${project}/${name}` : name;
}

function regular(entry) {
  return entry?.type === "blob" && /^100\d{3}$/.test(entry.mode || "");
}

export function inspectTree(entries, requestedPaths, selectedPolicy = policy) {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const diagnostics = [];
  const project = requestedPaths.project || "";
  const comparator = requestedPaths.comparator;
  const metadata = requestedPaths.metadata || joined(project, "formalization.yaml");
  const lakefiles = ["lakefile.toml", "lakefile.lean"]
    .map((name) => joined(project, name))
    .filter((path) => byPath.has(path));
  if (lakefiles.length !== 1 || !regular(byPath.get(lakefiles[0]))) {
    diagnostics.push(diagnostic("layout.lakefile", "The project must contain exactly one regular lakefile.toml or lakefile.lean."));
  }
  for (const [name, path, limit] of [
    ["formalization.yaml", metadata, selectedPolicy.limits.formalization_bytes],
    ["Comparator configuration", comparator, selectedPolicy.limits.configuration_bytes],
  ]) {
    const entry = byPath.get(path);
    if (!regular(entry)) diagnostics.push(diagnostic("layout.file_missing", `${name} is not a regular file at ${path}.`, { path }));
    else if (entry.size > limit) diagnostics.push(diagnostic("layout.file_too_large", `${name} exceeds its size limit.`, { path }));
  }
  const toolchain = [joined(project, "lean-toolchain"), "lean-toolchain"]
    .find((path) => regular(byPath.get(path)));
  if (!toolchain) diagnostics.push(diagnostic("toolchain.missing", "lean-toolchain is not a regular file in the project or repository root.", { path: "lean-toolchain" }));
  if (lakefiles[0]?.endsWith("lakefile.lean") && !regular(byPath.get(joined(project, "lake-manifest.json")))) {
    diagnostics.push(diagnostic("layout.manifest_missing", "lakefile.lean projects require a committed lake-manifest.json."));
  }
  if (entries.some((entry) => entry.type === "commit" || entry.mode === "160000")) {
    diagnostics.push(diagnostic("repository.submodule", "The repository contains a Git submodule, which Palomar cannot preserve."));
  }
  const size = entries.reduce((total, entry) => total + (entry.type === "blob" ? Number(entry.size || 0) : 0), 0);
  if (size > selectedPolicy.limits.source_bytes) {
    diagnostics.push(diagnostic("repository.too_large", "The repository exceeds Palomar's 500 MiB source limit."));
  }
  const licensePattern = /^(?:licen[cs]e|copying|unlicense|ofl)(?:\.(?:md|markdown|txt))?$/i;
  if (!entries.some((entry) => !entry.path.includes("/") && regular(entry) && licensePattern.test(entry.path))) {
    diagnostics.push(diagnostic(
      "license.missing",
      "No conventional license file was found at the repository root.",
      { advisory: true },
    ));
  }
  const metadataEntry = byPath.get(metadata);
  const comparatorEntry = byPath.get(comparator);
  return {
    diagnostics,
    files: {
      formalization: regular(metadataEntry) &&
        metadataEntry.size <= selectedPolicy.limits.formalization_bytes ? metadataEntry : null,
      comparator: regular(comparatorEntry) &&
        comparatorEntry.size <= selectedPolicy.limits.configuration_bytes ? comparatorEntry : null,
      toolchain: toolchain ? byPath.get(toolchain) : null,
    },
  };
}

export function validatePortable(input, selectedPolicy = policy) {
  return [
    ...(input.formalization === undefined ? [] : validateFormalization(input.formalization, selectedPolicy)),
    ...(input.comparator === undefined ? [] : validateComparator(input.comparator, selectedPolicy)),
    ...(input.toolchain === undefined ? [] : validateToolchain(input.toolchain, selectedPolicy)),
  ];
}
