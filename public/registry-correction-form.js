import { sourceContributorLines, sourceContributorText } from "./formalization-profile.js";
import { correctableMetadata, normalizeRegistryCorrection } from "./registry-correction.js";

const DATA = "https://data.palomar-registry.org";
const ID_RE = /^PALOMAR-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}$/;
const form = document.getElementById("registry-correction-form");
const identifier = document.getElementById("correction-id");
const editor = document.getElementById("correction-editor");
const status = document.getElementById("correction-load-status");
const baselineSummary = document.getElementById("correction-baseline");
const sourceRows = document.getElementById("correction-sources");
const relatedRows = document.getElementById("correction-related");
let baseline = null;
let loadSequence = 0;

function control(tag, part, value = "") {
  const node = document.createElement(tag);
  node.dataset.part = part;
  node.value = value ?? "";
  return node;
}

function labeled(labelText, node) {
  const label = document.createElement("label");
  label.append(labelText, node);
  return label;
}

function removeButton(label, row) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary compact";
  button.textContent = label;
  button.addEventListener("click", () => {
    row.remove();
  });
  return button;
}

function peopleText(people) {
  return (people ?? []).map((person) =>
    [person.name, person.github ?? "", person.orcid ?? ""].join(" | ").replace(/(?: \| )+$/, "")
  ).join("\n");
}

function parsePeople(value, label, { required = true } = {}) {
  const rows = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (required && !rows.length) throw new TypeError(`${label} must not be empty`);
  return rows.map((line) => {
    const [name = "", github = "", orcid = "", ...rest] = line.split("|").map((part) => part.trim());
    if (!name || rest.length) throw new TypeError(`${label} must use Name | GitHub | ORCID`);
    return { name, ...(github ? { github: github.replace(/^@/, "") } : {}), ...(orcid ? { orcid } : {}) };
  });
}

function sourceRow(value = {}) {
  const row = document.createElement("fieldset");
  row.className = "repair-repeatable";
  row.append(Object.assign(document.createElement("legend"), { textContent: "Source" }));
  const title = control("textarea", "title", value.title);
  title.rows = 2;
  title.required = true;
  const authors = control("textarea", "authors", peopleText(value.authors));
  authors.rows = 3;
  const contributors = control("textarea", "contributors", sourceContributorText(value.contributors));
  contributors.rows = 3;
  contributors.placeholder = "Name | role (one credit per line)";
  const relationship = control("select", "relationship", value.relationship);
  for (const name of ["formalizes", "adapts", "independently-proves", "background", "other"]) {
    relationship.append(Object.assign(document.createElement("option"), { value: name, textContent: name }));
  }
  relationship.value = value.relationship ?? "background";
  row.append(
    labeled("Title", title),
    labeled("Authors — one Name | GitHub | ORCID per line", authors),
    labeled("Other source credits — one Name | role per line", contributors),
    labeled("Relationship", relationship),
  );
  for (const [name, labelText, current] of [
    ["identifier", "Identifier", value.identifier],
    ["type", "Type", value.type],
    ["location", "Location", value.location],
    ["license", "License", value.license],
    ["author_endorsement", "Source-author response", value.author_endorsement],
  ]) row.append(labeled(labelText, control("input", name, current)));
  row.append(removeButton("Remove source", row));
  return row;
}

function relatedRow(value = {}) {
  const row = document.createElement("fieldset");
  row.className = "repair-repeatable";
  row.append(Object.assign(document.createElement("legend"), { textContent: "Related formalization" }));
  const identifierControl = control("input", "identifier", value.identifier);
  identifierControl.required = true;
  const relationship = control("input", "relationship", value.relationship);
  relationship.required = true;
  const note = control("textarea", "note", value.note);
  note.rows = 2;
  row.append(
    labeled("Identifier", identifierControl),
    labeled("Relationship", relationship),
    labeled("Note", note),
    removeButton("Remove related formalization", row, () => {}),
  );
  return row;
}

function readRows(container, reader) {
  return [...container.children].map(reader);
}

function part(row, name) {
  return row.querySelector(`[data-part="${name}"]`)?.value.trim() ?? "";
}

function readSource(row) {
  const result = {
    title: part(row, "title"),
    authors: parsePeople(part(row, "authors"), "Source authors", { required: false }),
    relationship: part(row, "relationship"),
  };
  const contributors = sourceContributorLines(part(row, "contributors"));
  if (contributors.length) result.contributors = contributors;
  for (const name of ["identifier", "type", "location", "license", "author_endorsement"]) {
    const value = part(row, name);
    if (value) result[name] = value;
  }
  return result;
}

function readRelated(row) {
  const result = { identifier: part(row, "identifier"), relationship: part(row, "relationship") };
  const note = part(row, "note");
  if (note) result.note = note;
  return result;
}

function fill(entry) {
  const metadata = correctableMetadata(entry);
  document.getElementById("correction-title").value = metadata.title;
  document.getElementById("correction-abstract").value = metadata.abstract;
  document.getElementById("correction-authors").value = peopleText(metadata.authors);
  document.getElementById("correction-arxiv").value = metadata.classification.arxiv.join("\n");
  document.getElementById("correction-msc2020").value = metadata.classification.msc2020.join("\n");
  document.getElementById("correction-maintainers").value = peopleText(
    metadata.provenance.responsible_maintainers,
  );
  sourceRows.replaceChildren(...metadata.provenance.mathematical_sources.map(sourceRow));
  relatedRows.replaceChildren(...metadata.provenance.related_formalizations.map(relatedRow));

  document.getElementById("repository").value = entry.source.repository;
  document.getElementById("commit").value = entry.source.commit;
  document.getElementById("existing_id").value = entry.id;
  document.getElementById("project_path").value = entry.source.project_path ?? "";
  document.getElementById("comparator_config_path").value = entry.formalization.comparator_config_path;
  document.getElementById("formalization_metadata_path").value = entry.formalization.formalization_metadata_path;
  baselineSummary.textContent =
    `Based on ${entry.id} version ${entry.version} at ${entry.source.repository}@${entry.source.commit}.`;
  editor.hidden = false;
}

async function load() {
  const mine = ++loadSequence;
  baseline = null;
  editor.hidden = true;
  const id = identifier.value.trim().toUpperCase();
  if (!ID_RE.test(id)) {
    status.textContent = id ? "Enter a complete Palomar identifier." : "Enter an identifier to load its current active version.";
    return;
  }
  identifier.value = id;
  status.textContent = "Loading the current active version…";
  try {
    const versionsResponse = await fetch(`${DATA}/versions/${id}.json`, { cache: "no-store" });
    if (!versionsResponse.ok) throw new Error(versionsResponse.status === 404 ? "That record is not active." : "Registry data is unavailable.");
    const versions = await versionsResponse.json();
    if (versions?.id !== id || !Array.isArray(versions.entries) || !versions.entries.length) {
      throw new Error("The version history is malformed.");
    }
    const summary = versions.entries.reduce((latest, item) =>
      Number(item.version) > Number(latest.version) ? item : latest
    );
    if (!Number.isSafeInteger(summary.version) || typeof summary.path !== "string") {
      throw new Error("The current version is malformed.");
    }
    const entryResponse = await fetch(`${DATA}/${summary.path.replace(/^\//, "")}`, { cache: "no-store" });
    if (!entryResponse.ok) throw new Error("The current entry could not be loaded.");
    const entry = await entryResponse.json();
    if (entry?.id !== id || entry?.version !== summary.version) throw new Error("The entry identity is inconsistent.");
    if (mine !== loadSequence) return;
    baseline = entry;
    fill(entry);
    status.textContent = `Loaded current version ${entry.version}.`;
  } catch (error) {
    if (mine !== loadSequence) return;
    status.textContent = error instanceof Error ? error.message : "The current entry could not be loaded.";
  }
}

identifier?.addEventListener("change", load);
identifier?.addEventListener("input", () => {
  clearTimeout(identifier._correctionTimer);
  identifier._correctionTimer = setTimeout(load, 350);
});
document.getElementById("correction-add-source")?.addEventListener("click", () => sourceRows.append(sourceRow()));
document.getElementById("correction-add-related")?.addEventListener("click", () => relatedRows.append(relatedRow()));

form?.addEventListener("submit", (event) => {
  if (!baseline) {
    event.preventDefault();
    status.textContent = "Load the current record before submitting.";
    return;
  }
  try {
    const correction = normalizeRegistryCorrection({
      schema_version: 1,
      based_on: { id: baseline.id, version: baseline.version },
      explanation: document.getElementById("correction-explanation").value,
      metadata: {
        title: document.getElementById("correction-title").value,
        abstract: document.getElementById("correction-abstract").value,
        authors: parsePeople(document.getElementById("correction-authors").value, "Authors"),
        classification: {
          arxiv: document.getElementById("correction-arxiv").value.split(/\s+/).filter(Boolean),
          msc2020: document.getElementById("correction-msc2020").value.split(/\s+/).filter(Boolean),
        },
        provenance: {
          responsible_maintainers: parsePeople(
            document.getElementById("correction-maintainers").value,
            "Responsible maintainers",
          ),
          mathematical_sources: readRows(sourceRows, readSource),
          related_formalizations: readRows(relatedRows, readRelated),
        },
      },
    });
    document.getElementById("registry-correction-payload").value = JSON.stringify(correction);
  } catch (error) {
    event.preventDefault();
    status.textContent = error instanceof Error ? error.message : "The correction is malformed.";
  }
});
