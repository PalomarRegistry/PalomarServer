import { isMap, isSeq, parseDocument } from "yaml";

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

function nonempty(value) {
  return typeof value === "string" && value.trim() !== "";
}

function people(value) {
  return Array.isArray(value) && value.length > 0 && value.every((person) =>
    nonempty(person) || (mapping(person) === person && nonempty(person.name)));
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

  const result = [];
  const project = mapping(data.project);
  addField(result, nonempty(project.name), "project.name", "must be a nonempty string.");
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
    addField(
      result,
      Array.isArray(values) && values.length >= minimum && values.length <= maximum &&
        values.every(nonempty) && new Set(values).size === values.length,
      field,
      `must contain ${minimum}–${maximum} distinct codes.`,
    );
  }

  const sources = data.sources;
  const sourceTypes = new Set(selectedPolicy.formalization.source_types);
  const relationships = new Set(selectedPolicy.formalization.source_relationships);
  const endorsements = new Set(selectedPolicy.formalization.source_endorsements);
  addField(result, Array.isArray(sources) && sources.length > 0, "sources", "must be a nonempty list.");
  if (Array.isArray(sources) && sources.length) {
    let original = false;
    let substantive = false;
    sources.forEach((raw, index) => {
      const source = mapping(raw);
      addField(result, nonempty(source.title), "sources", `entry ${index + 1} needs a title.`);
      addField(
        result,
        relationships.has(source.relationship),
        "sources",
        `entry ${index + 1} has an unsupported relationship.`,
      );
      if (source.type !== undefined) {
        addField(
          result,
          sourceTypes.has(source.type),
          "sources",
          `entry ${index + 1} has an unsupported type.`,
        );
      }
      if (source.author_endorsement !== undefined) {
        addField(
          result,
          endorsements.has(source.author_endorsement),
          "sources",
          `entry ${index + 1} has an unsupported author endorsement.`,
        );
      }
      original ||= source.type === "original-proof";
      substantive ||= ["formalizes", "adapts", "independently-proves"].includes(source.relationship);
      if (source.type === "original-proof" && source.relationship !== "other") {
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
      mapping(item) === item && nonempty(item.method)),
    "automation.methods",
    "must be a nonempty list whose entries name a method.",
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
