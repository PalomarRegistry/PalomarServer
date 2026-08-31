/** Closed contract for an exceptional Palomar-maintainer metadata correction. */

export const REGISTRY_CORRECTION_SCHEMA_VERSION = 1;
export const REGISTRY_CORRECTION_KIND = "palomar-maintainer";
export const MAX_CORRECTION_EXPLANATION = 4_000;
// The correction is nested as a JSON string inside the workflow-dispatch
// options JSON. Leave room for that escaping and the other dispatch inputs.
export const MAX_REGISTRY_CORRECTION_BYTES = 48_000;

export const CORRECTABLE_FIELDS = Object.freeze([
  "title",
  "abstract",
  "authors",
  "classification.arxiv",
  "classification.msc2020",
  "provenance.responsible_maintainers",
  "provenance.mathematical_sources",
  "provenance.related_formalizations",
]);

const ID_RE = /^PALOMAR-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}$/;
const GITHUB_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const ORCID_RE = /^[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{3}[0-9X]$/;
// eslint-disable-next-line no-control-regex -- decoded public text must exclude controls
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const SOURCE_RELATIONSHIPS = new Set([
  "formalizes", "adapts", "independently-proves", "background", "other",
]);

function object(value, label, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has unsupported fields`);
  }
  return value;
}

function text(value, label, maximum, { oneLine = false } = {}) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > maximum || CONTROL_RE.test(result) || (oneLine && /[\r\n]/.test(result))) {
    throw new TypeError(`${label} must be nonempty text of at most ${maximum} characters`);
  }
  return result;
}

function optionalText(value, label, maximum) {
  if (value === undefined) return undefined;
  return text(value, label, maximum);
}

function person(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a person object`);
  }
  const allowed = new Set(["name", "github", "orcid"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError(`${label} has unsupported fields`);
  }
  const result = { name: text(value.name, `${label}.name`, 500, { oneLine: true }) };
  if (value.github !== undefined) {
    const github = text(value.github, `${label}.github`, 39, { oneLine: true }).replace(/^@/, "");
    if (!GITHUB_RE.test(github)) throw new TypeError(`${label}.github is malformed`);
    result.github = github;
  }
  if (value.orcid !== undefined) {
    const orcid = text(value.orcid, `${label}.orcid`, 19, { oneLine: true });
    if (!ORCID_RE.test(orcid)) throw new TypeError(`${label}.orcid is malformed`);
    result.orcid = orcid;
  }
  return result;
}

function people(value, label, { required = true } = {}) {
  if (!Array.isArray(value) || (required && value.length < 1) || value.length > 100) {
    throw new TypeError(`${label} must contain ${required ? "between one and" : "at most"} 100 people`);
  }
  return value.map((item, index) => person(item, `${label}[${index}]`));
}

function classifications(value, label, maximum) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    throw new TypeError(`${label} must contain between one and ${maximum} codes`);
  }
  const result = value.map((item, index) => text(item, `${label}[${index}]`, 32, { oneLine: true }));
  if (new Set(result).size !== result.length) throw new TypeError(`${label} contains duplicates`);
  return result;
}

function mathematicalSource(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a source object`);
  }
  const allowed = new Set([
    "title", "authors", "relationship", "identifier", "type", "location", "license",
    "author_endorsement",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError(`${label} has unsupported fields`);
  }
  const relationship = text(value.relationship, `${label}.relationship`, 32, { oneLine: true });
  if (!SOURCE_RELATIONSHIPS.has(relationship)) {
    throw new TypeError(`${label}.relationship is unsupported`);
  }
  const result = {
    title: text(value.title, `${label}.title`, 10_000),
    authors: people(value.authors ?? [], `${label}.authors`, { required: false }),
    relationship,
  };
  for (const [name, maximum] of [
    ["identifier", 2_048], ["type", 200], ["location", 1_000], ["license", 500],
    ["author_endorsement", 100],
  ]) {
    const found = optionalText(value[name], `${label}.${name}`, maximum);
    if (found !== undefined) result[name] = found;
  }
  return result;
}

function relatedFormalization(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a related-formalization object`);
  }
  const allowed = new Set(["identifier", "relationship", "note"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError(`${label} has unsupported fields`);
  }
  const result = {
    identifier: text(value.identifier, `${label}.identifier`, 2_048),
    relationship: text(value.relationship, `${label}.relationship`, 500),
  };
  const note = optionalText(value.note, `${label}.note`, 10_000);
  if (note !== undefined) result.note = note;
  return result;
}

function normalizedMetadata(value) {
  object(value, "registry correction metadata", [
    "title", "abstract", "authors", "classification", "provenance",
  ]);
  const classification = object(
    value.classification,
    "registry correction metadata.classification",
    ["arxiv", "msc2020"],
  );
  const provenance = object(
    value.provenance,
    "registry correction metadata.provenance",
    ["responsible_maintainers", "mathematical_sources", "related_formalizations"],
  );
  if (!Array.isArray(provenance.mathematical_sources) || provenance.mathematical_sources.length > 100) {
    throw new TypeError("registry correction metadata.provenance.mathematical_sources is malformed");
  }
  if (!Array.isArray(provenance.related_formalizations) || provenance.related_formalizations.length > 100) {
    throw new TypeError("registry correction metadata.provenance.related_formalizations is malformed");
  }
  return {
    title: text(value.title, "registry correction metadata.title", 300),
    abstract: text(value.abstract, "registry correction metadata.abstract", 10_000),
    authors: people(value.authors, "registry correction metadata.authors"),
    classification: {
      arxiv: classifications(classification.arxiv, "registry correction metadata.classification.arxiv", 2),
      msc2020: classifications(classification.msc2020, "registry correction metadata.classification.msc2020", 8),
    },
    provenance: {
      responsible_maintainers: people(
        provenance.responsible_maintainers,
        "registry correction metadata.provenance.responsible_maintainers",
      ),
      mathematical_sources: provenance.mathematical_sources.map(
        (item, index) => mathematicalSource(
          item,
          `registry correction metadata.provenance.mathematical_sources[${index}]`,
        ),
      ),
      related_formalizations: provenance.related_formalizations.map(
        (item, index) => relatedFormalization(
          item,
          `registry correction metadata.provenance.related_formalizations[${index}]`,
        ),
      ),
    },
  };
}

function valueAt(metadata, field) {
  return field.split(".").reduce((value, key) => value?.[key], metadata);
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Normalize the browser payload without trusting its claimed delta. */
export function normalizeRegistryCorrection(value) {
  object(value, "registry correction", ["schema_version", "based_on", "explanation", "metadata"]);
  if (value.schema_version !== REGISTRY_CORRECTION_SCHEMA_VERSION) {
    throw new TypeError("registry correction schema_version is unsupported");
  }
  const basedOn = object(value.based_on, "registry correction.based_on", ["id", "version"]);
  if (typeof basedOn.id !== "string" || !ID_RE.test(basedOn.id)) {
    throw new TypeError("registry correction.based_on.id is malformed");
  }
  if (!Number.isSafeInteger(basedOn.version) || basedOn.version < 1) {
    throw new TypeError("registry correction.based_on.version is malformed");
  }
  return {
    schema_version: REGISTRY_CORRECTION_SCHEMA_VERSION,
    kind: REGISTRY_CORRECTION_KIND,
    based_on: { id: basedOn.id, version: basedOn.version },
    explanation: text(
      value.explanation,
      "registry correction.explanation",
      MAX_CORRECTION_EXPLANATION,
    ),
    metadata: normalizedMetadata(value.metadata),
  };
}

/** The public fields from one already validated canonical entry. */
export function correctableMetadata(entry) {
  return normalizedMetadata({
    title: entry?.title,
    abstract: entry?.abstract,
    authors: (entry?.authors ?? []).map(({ name, github, orcid }) => ({
      name,
      ...(github ? { github } : {}),
      ...(orcid ? { orcid } : {}),
    })),
    classification: entry?.classification,
    provenance: {
      responsible_maintainers: (entry?.provenance?.responsible_maintainers ?? [])
        .map(({ name, github, orcid }) => ({
          name,
          ...(github ? { github } : {}),
          ...(orcid ? { orcid } : {}),
        })),
      mathematical_sources: (entry?.provenance?.mathematical_sources ?? []).map((source) => ({
        ...source,
        authors: (source.authors ?? []).map(({ name, github, orcid }) => ({
          name,
          ...(github ? { github } : {}),
          ...(orcid ? { orcid } : {}),
        })),
      })),
      related_formalizations: entry?.provenance?.related_formalizations ?? [],
    },
  });
}

/** Derive the only delta registration is allowed to apply. */
export function registryCorrectionDelta(correction, baselineEntry) {
  const normalized = normalizeRegistryCorrection({
    schema_version: correction.schema_version,
    based_on: correction.based_on,
    explanation: correction.explanation,
    metadata: correction.metadata,
  });
  if (
    baselineEntry?.id !== normalized.based_on.id ||
    baselineEntry?.version !== normalized.based_on.version
  ) throw new TypeError("registry correction baseline identity disagrees with the entry");
  const baseline = correctableMetadata(baselineEntry);
  const changedFields = CORRECTABLE_FIELDS.filter(
    (field) => !same(valueAt(normalized.metadata, field), valueAt(baseline, field)),
  );
  if (!changedFields.length) throw new TypeError("registry correction does not change any metadata");
  return {
    ...normalized,
    changed_fields: changedFields,
    edits: changedFields.map((field) => ({ field, value: valueAt(normalized.metadata, field) })),
  };
}
