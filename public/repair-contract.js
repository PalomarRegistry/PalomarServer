import {
  AUTOMATION_METHODS,
  SOURCE_ENDORSEMENTS,
  SOURCE_RELATIONSHIPS,
  SOURCE_TYPES,
} from "./formalization-profile.js";

export const REPAIR_FIELDS_V1 = new Map([
  ["project.name", "text"], ["project.license", "text"],
  ["classification.arxiv", "list"], ["classification.msc2020", "list"],
  ["review.status", "text"],
]);
export const REPAIR_FIELDS_V2 = new Map([
  ...REPAIR_FIELDS_V1,
  ["project.authors", "people"], ["project.responsible_maintainers", "people"],
  ["sources", "sources"], ["automation.methods", "methods"],
  ["repository.substantive_formalization", "substantive-repository"],
]);

function exact(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key));
}

function line(value, field, maximum = 500) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maximum || /[\r\n]/.test(text)) {
    throw new TypeError(`${field} must be one line of at most ${maximum} characters`);
  }
  return text;
}

function lineList(value, field, maximum = 100) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    throw new TypeError(`${field} must contain between one and ${maximum} values`);
  }
  return value.map((item) => line(item, field));
}

function classificationList(value, field, maximum, taxonomy) {
  const items = lineList(value, field, maximum);
  const canonical = taxonomy instanceof Map
    ? taxonomy
    : taxonomy
    ? new Map(
      (Array.isArray(taxonomy) ? taxonomy : Object.keys(taxonomy))
        .map((code) => [String(code).toUpperCase(), code]),
    )
    : null;
  const result = items.map((item) => {
    if (!canonical) return item;
    const code = canonical.get(item.toUpperCase());
    if (!code) throw new TypeError(`${field} contains an unrecognized classification code`);
    return code;
  });
  if (new Set(result).size !== result.length) {
    throw new TypeError(`${field} must not contain duplicate classifications`);
  }
  return result;
}

function sourceList(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new TypeError("sources must contain between one and twenty entries");
  }
  const allowed = ["title", "authors", "id", "type", "location", "relationship", "license", "author_endorsement"];
  const result = value.map((source, index) => {
    if (!exact(source, allowed)) throw new TypeError(`sources[${index}] contains unsupported fields`);
    const item = { title: line(source.title, `sources[${index}].title`) };
    if (source.authors !== undefined) item.authors = lineList(source.authors, `sources[${index}].authors`);
    for (const [field, maximum] of [["id", 2048], ["location", 1000], ["license", 500]]) {
      if (source[field] !== undefined) item[field] = line(source[field], `sources[${index}].${field}`, maximum);
    }
    if (source.type) {
      if (!SOURCE_TYPES.includes(source.type)) throw new TypeError(`sources[${index}].type is unsupported`);
      item.type = source.type;
    }
    if (!SOURCE_RELATIONSHIPS.includes(source.relationship)) {
      throw new TypeError(`sources[${index}].relationship is required`);
    }
    item.relationship = source.relationship;
    if (source.author_endorsement) {
      if (!SOURCE_ENDORSEMENTS.includes(source.author_endorsement)) {
        throw new TypeError(`sources[${index}].author_endorsement is unsupported`);
      }
      item.author_endorsement = source.author_endorsement;
    }
    return item;
  });
  const original = result.some((item) => item.type === "original-proof");
  const substantive = new Set(["formalizes", "adapts", "independently-proves"]);
  if (original && result.some((item) => substantive.has(item.relationship))) {
    throw new TypeError("original-proof cannot be combined with a substantive source relationship");
  }
  if (original && result.some((item) => item.type === "original-proof" && item.relationship !== "other")) {
    throw new TypeError("original-proof sources must use relationship other");
  }
  if (!original && !result.some((item) => substantive.has(item.relationship))) {
    throw new TypeError("source-based results need a formalizes, adapts, or independently-proves source");
  }
  return result;
}

function methodList(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new TypeError("automation.methods must contain between one and twenty entries");
  }
  return value.map((method, index) => {
    if (!exact(method, ["method", "framework", "models"])) {
      throw new TypeError(`automation.methods[${index}] contains unsupported fields`);
    }
    const name = line(method.method, `automation.methods[${index}].method`);
    if (!AUTOMATION_METHODS.includes(name)) throw new TypeError(`${name} is not a supported automation method`);
    const result = { method: name };
    if (method.framework !== undefined) result.framework = line(method.framework, `automation.methods[${index}].framework`);
    if (method.models !== undefined) result.models = lineList(method.models, `automation.methods[${index}].models`);
    return result;
  });
}

export function normalizedRepairEdits(value, profileVersion = 1, taxonomies = {}) {
  const fields = profileVersion === 2 ? REPAIR_FIELDS_V2 : REPAIR_FIELDS_V1;
  if (!Array.isArray(value) || value.length < 1 || value.length > fields.size) {
    throw new TypeError(`edits must contain between one and ${fields.size} repairable fields`);
  }
  const seen = new Set();
  return value.map((edit) => {
    const field = typeof edit?.field === "string" ? edit.field : "";
    const kind = fields.get(field);
    if (!kind || seen.has(field)) throw new TypeError(`unsupported or duplicate repair field: ${field}`);
    seen.add(field);
    let normalized;
    if (kind === "text") normalized = line(edit.value, field);
    else if (kind === "list") {
      const maximum = field === "classification.arxiv" ? 2 : 8;
      normalized = classificationList(edit.value, field, maximum, taxonomies[field]);
    }
    else if (kind === "people") normalized = lineList(edit.value, field);
    else if (kind === "sources") normalized = sourceList(edit.value);
    else if (kind === "methods") normalized = methodList(edit.value);
    else {
      if (!exact(edit.value, ["id", "revision"]) || !/^[0-9a-f]{40}$/.test(edit.value.revision ?? "")) {
        throw new TypeError(`${field} must name a repository and full lowercase commit`);
      }
      const id = line(edit.value.id, `${field}.id`);
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(id)) {
        throw new TypeError(`${field}.id must name a repository as owner/name`);
      }
      normalized = { id, revision: edit.value.revision };
    }
    return { field, value: normalized };
  }).sort((left, right) => left.field.localeCompare(right.field));
}

export function normalizedQueuedRepairEdits(value, profileVersion, taxonomies) {
  for (const field of ["classification.arxiv", "classification.msc2020"]) {
    if (!(taxonomies?.[field] instanceof Map)) {
      throw new TypeError(`queued repairs require the ${field} taxonomy`);
    }
  }
  return normalizedRepairEdits(value, profileVersion, taxonomies);
}
