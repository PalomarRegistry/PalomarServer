import {
  AUTOMATION_METHOD_SUGGESTIONS,
  canAddClassification,
  classificationMaximum,
  FORMALIZATION_FIELDS,
  FORMALIZATION_PROFILE_VERSION,
  lines,
  safeDraft,
  SOURCE_ENDORSEMENT_SUGGESTIONS,
  SOURCE_RELATIONSHIP_SUGGESTIONS,
} from "./formalization-profile.js";
import { normalizedRepairEdits } from "./repair-contract.js";
import { canonicalClassification, classificationProblem, taxonomyIndex } from "./repair-form-contract.js";

function el(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function textControl(name, value = "", { required = false, placeholder = "" } = {}) {
  const input = document.createElement("input");
  input.dataset.part = name;
  input.value = value ?? "";
  input.required = required;
  input.maxLength = 2048;
  input.placeholder = placeholder;
  return input;
}

function sourceTypeControl(value = "") {
  const input = textControl("type", value, {
    placeholder: "article, paper, book, formalization, …",
  });
  input.maxLength = 200;
  return input;
}

/** Build and validate the guided metadata editor embedded in the intake form. */
export function createPreflightRepairForm({ container, fields, status }) {
  const taxonomies = new Map();
  let sequence = 0;
  let active = false;
  let attempted = false;
  let intent = null;

  function setStatus(message = "") {
    status.textContent = message;
  }

  function taxonomy(field) {
    const name = field === "classification.arxiv" ? "arxiv-categories" : "msc2020-codes";
    if (taxonomies.has(name)) return taxonomies.get(name);
    const list = document.createElement("datalist");
    list.id = `preflight-repair-${name}`;
    document.body.append(list);
    const result = { list, index: null, ready: false };
    taxonomies.set(name, result);
    result.loaded = fetch(`/taxonomies/${name}.json`, { credentials: "same-origin" })
      .then((response) => {
        if (!response.ok) throw new Error("taxonomy unavailable");
        return response.json();
      })
      .then((data) => {
        result.index = taxonomyIndex(data);
        const fragment = document.createDocumentFragment();
        for (const [code, summary] of result.index?.entries ?? []) {
          const item = document.createElement("option");
          item.value = code;
          if (summary) {
            item.label = summary;
            item.textContent = summary;
          }
          fragment.append(item);
        }
        list.replaceChildren(fragment);
        result.ready = true;
        validate();
      })
      .catch(() => {
        // The Worker validates these codes again before it records any request.
        result.ready = true;
        validate();
      });
    return result;
  }

  function validationMessage(control) {
    if (control.dataset.validationMessage) {
      return document.getElementById(control.dataset.validationMessage);
    }
    const message = el("p", "");
    message.id = `preflight-repair-validation-${++sequence}`;
    message.className = "hint warning repair-validation";
    message.hidden = true;
    control.dataset.validationMessage = message.id;
    control.setAttribute(
      "aria-describedby",
      [control.getAttribute("aria-describedby"), message.id].filter(Boolean).join(" "),
    );
    control.insertAdjacentElement("afterend", message);
    return message;
  }

  function setValidity(control, message = "") {
    control.setCustomValidity(message);
    const show = Boolean(message) && (
      attempted || control.dataset.touched === "true" || control.dataset.originallyInvalid === "true"
    );
    control.setAttribute("aria-invalid", String(show));
    const visible = validationMessage(control);
    visible.textContent = show ? message : "";
    visible.hidden = !show;
    return !message;
  }

  function groupValidity(wrapper, message = "") {
    let node = wrapper.querySelector(":scope > .repair-group-validation");
    if (!node) {
      node = el("p", "");
      node.className = "hint warning repair-group-validation";
      node.setAttribute("role", "status");
      wrapper.append(node);
    }
    const show = Boolean(message);
    node.textContent = show ? message : "";
    node.hidden = !show;
  }

  function classificationRow(field, value = "", onRowsChanged = () => {}, prefilled = false) {
    const row = document.createElement("div");
    row.className = "repair-classification";
    const input = textControl("code", value, { required: true });
    if (prefilled) input.dataset.originallyInvalid = "true";
    const source = taxonomy(field);
    input.setAttribute("list", source.list.id);
    input.setAttribute(
      "aria-label",
      field === "classification.msc2020"
        ? "MSC 2020 classification code" : "arXiv classification code",
    );
    const summary = el("p", "");
    summary.className = "hint classification-summary";
    summary.id = `preflight-repair-classification-summary-${++sequence}`;
    summary.hidden = true;
    input.setAttribute("aria-describedby", summary.id);
    const showSummary = () => {
      const canonical = canonicalClassification(input.value, source.index);
      const description = field === "classification.msc2020" && canonical
        ? source.index.summaries.get(canonical) ?? ""
        : "";
      summary.textContent = description;
      summary.hidden = !description;
    };
    input.addEventListener("input", showSummary);
    input.addEventListener("change", () => {
      const canonical = canonicalClassification(input.value, source.index);
      if (canonical) input.value = canonical;
      showSummary();
      validate();
    });
    void source.loaded.then(() => {
      showSummary();
      validate();
    });
    const remove = el("button", "Remove");
    remove.type = "button";
    remove.className = "secondary compact";
    remove.addEventListener("click", () => {
      const rows = row.parentElement;
      row.remove();
      if (rows && !rows.children.length) {
        rows.append(classificationRow(field, "", onRowsChanged));
      }
      onRowsChanged();
      validate();
    });
    row.append(input, remove, summary);
    return row;
  }

  function sourceRow(value = {}, prefilled = false) {
    const row = document.createElement("fieldset");
    row.className = "repair-repeatable";
    row.dataset.kind = "source";
    row.append(el("legend", "Source"));
    const guidance = el(
      "p",
      "Relationship describes what this formalization does with the source: " +
        "formalizes follows it, adapts changes it, independently-proves reaches the same result, " +
        "background supplies context, and other covers an original proof or another relationship. " +
        "Source-author response records whether an author was contacted or involved; leave it " +
        "unspecified when it does not apply. Use Source note to explain an other category.",
    );
    guidance.className = "hint";
    row.append(guidance);
    const relationship = textControl("relationship", value.relationship, {
      required: true,
      placeholder: SOURCE_RELATIONSHIP_SUGGESTIONS.join(", "),
    });
    relationship.maxLength = 500;
    relationship.required = true;
    if (prefilled && !relationship.value.trim()) {
      relationship.dataset.originallyInvalid = "true";
    }
    const title = textControl("title", value.title, { required: true });
    if (prefilled && !title.value.trim()) title.dataset.originallyInvalid = "true";
    const authors = document.createElement("textarea");
    authors.dataset.part = "authors";
    authors.rows = 2;
    authors.value = (value.authors ?? []).join("\n");
    for (const [labelText, control] of [
      ["Title", title],
      ["Authors", authors],
      ["Type", sourceTypeControl(value.type)],
      ["Relationship", relationship],
      ["Source note", (() => {
        const input = document.createElement("textarea");
        input.dataset.part = "note";
        input.rows = 3;
        input.maxLength = 10_000;
        input.placeholder = "Explain relationship or source-author response: other";
        input.value = value.note ?? "";
        return input;
      })()],
      ["Identifier", textControl("id", value.id, { placeholder: "DOI, arXiv id, URL, or citation" })],
      ["Location", textControl("location", value.location)],
      ["License", textControl("license", value.license)],
      ["Source-author response", (() => {
        const input = textControl("author_endorsement", value.author_endorsement, {
          placeholder: SOURCE_ENDORSEMENT_SUGGESTIONS.join(", "),
        });
        input.maxLength = 100;
        return input;
      })()],
    ]) {
      const label = el("label", labelText);
      label.append(control);
      row.append(label);
    }
    const remove = el("button", "Remove source");
    remove.type = "button";
    remove.className = "secondary compact";
    remove.addEventListener("click", () => {
      const rows = row.parentElement;
      row.remove();
      if (rows && !rows.children.length) rows.append(sourceRow());
      validate();
    });
    row.append(remove);
    return row;
  }

  function methodRow(value = {}) {
    const row = document.createElement("fieldset");
    row.className = "repair-repeatable";
    row.dataset.kind = "method";
    row.append(el("legend", "Method"));
    const guidance = el(
      "p",
      "Choose the closest production category: manual for work written without generative assistance, copilot for interactive " +
        "suggestions, agent for a directed coding agent, autonomous for an independently run " +
        "system, or other. Framework and model names carry the exact provenance detail.",
    );
    guidance.className = "hint";
    row.append(guidance);
    const method = textControl("method", value.method, {
      required: true,
      placeholder: AUTOMATION_METHOD_SUGGESTIONS.join(", "),
    });
    method.maxLength = 500;
    method.required = true;
    const models = document.createElement("textarea");
    models.dataset.part = "models";
    models.rows = 2;
    models.placeholder = "Optional model names, one per line";
    models.value = (value.models ?? []).join("\n");
    for (const [labelText, control] of [
      ["Method", method],
      ["Framework", textControl("framework", value.framework, { placeholder: "Optional framework or tool" })],
      ["Models", models],
    ]) {
      const label = el("label", labelText);
      label.append(control);
      row.append(label);
    }
    const remove = el("button", "Remove method");
    remove.type = "button";
    remove.className = "secondary compact";
    remove.addEventListener("click", () => {
      const rows = row.parentElement;
      row.remove();
      if (rows && !rows.children.length) rows.append(methodRow());
      validate();
    });
    row.append(remove);
    return row;
  }

  function appendControl(wrapper, diagnostic, failure) {
    const field = diagnostic.field;
    const profile = FORMALIZATION_FIELDS[field];
    const draft = safeDraft(failure, field);
    wrapper.dataset.field = field;
    if (["text", "prose", "people"].includes(profile.input)) {
      const input = profile.input === "text" ? document.createElement("input") : document.createElement("textarea");
      input.name = field;
      input.dataset.inputType = profile.input;
      input.required = true;
      input.maxLength = profile.input === "text" ? 500 : profile.input === "prose" ? 10_000 : 4000;
      if (input instanceof HTMLTextAreaElement) input.rows = 3;
      input.value = Array.isArray(draft) ? draft.join("\n") : draft ?? "";
      if (!input.value.trim()) input.dataset.originallyInvalid = "true";
      wrapper.append(input);
      return;
    }
    if (profile.input === "text-list") {
      const rows = document.createElement("div");
      rows.dataset.rows = "classifications";
      const maximum = classificationMaximum(field);
      let updateAdd = () => {};
      const values = (Array.isArray(draft) && draft.length ? draft : [""]).slice(0, maximum);
      for (const value of values) {
        rows.append(classificationRow(field, value, () => updateAdd(), true));
      }
      const add = el("button", "Add another classification");
      add.type = "button";
      add.className = "secondary compact";
      updateAdd = () => {
        add.hidden = !canAddClassification(field, rows.children.length);
      };
      add.addEventListener("click", () => {
        if (canAddClassification(field, rows.children.length)) {
          rows.append(classificationRow(field, "", () => updateAdd()));
        }
        updateAdd();
        validate();
      });
      wrapper.append(rows, add);
      updateAdd();
      return;
    }
    if (profile.input === "sources" || profile.input === "methods") {
      const rows = document.createElement("div");
      rows.dataset.rows = profile.input;
      const draftRows = Array.isArray(draft) && draft.length
        ? draft : profile.input === "methods" ? [{ method: "manual" }] : [{}];
      for (const value of draftRows) {
        rows.append(profile.input === "sources" ? sourceRow(value, true) : methodRow(value));
      }
      const add = el("button", profile.input === "sources" ? "Add another source" : "Add another method");
      add.type = "button";
      add.className = "secondary compact";
      add.addEventListener("click", () => {
        rows.append(profile.input === "sources" ? sourceRow() : methodRow());
        validate();
      });
      wrapper.append(rows, add);
      return;
    }
    const repository = textControl("id", draft?.id, { required: true, placeholder: "owner/repository" });
    const revision = textControl("revision", draft?.revision, { required: true, placeholder: "40-character commit" });
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.value.trim())) {
      repository.dataset.originallyInvalid = "true";
    }
    if (!/^[0-9a-f]{40}$/i.test(revision.value.trim())) {
      revision.dataset.originallyInvalid = "true";
    }
    for (const [labelText, control] of [["Repository", repository], ["Commit", revision]]) {
      const label = el("label", labelText);
      label.append(control);
      wrapper.append(label);
    }
  }

  function rowValue(row) {
    const value = {};
    for (const control of row.querySelectorAll("[data-part]")) {
      const item = ["authors", "models"].includes(control.dataset.part)
        ? lines(control.value) : control.value.trim();
      if (Array.isArray(item) ? item.length : item) value[control.dataset.part] = item;
    }
    return value;
  }

  function edit(wrapper) {
    const field = wrapper.dataset.field;
    const profile = FORMALIZATION_FIELDS[field];
    if (profile.input === "people") {
      return { field, value: lines(wrapper.querySelector("[name]").value) };
    }
    if (profile.input === "text-list") {
      return { field, value: [...wrapper.querySelectorAll('[data-part="code"]')]
        .map((input) => input.value.trim()).filter(Boolean) };
    }
    if (profile.input === "text" || profile.input === "prose") {
      return { field, value: wrapper.querySelector("[name]").value.trim() };
    }
    if (profile.input === "sources" || profile.input === "methods") {
      const kind = profile.input === "sources" ? "source" : "method";
      return { field, value: [...wrapper.querySelectorAll(`[data-kind="${kind}"]`)].map(rowValue) };
    }
    return { field, value: {
      id: wrapper.querySelector('[data-part="id"]').value.trim(),
      revision: wrapper.querySelector('[data-part="revision"]').value.trim().toLowerCase(),
    } };
  }

  function validateClassification(wrapper, field) {
    const inputs = [...wrapper.querySelectorAll('[data-part="code"]')];
    const source = taxonomy(field);
    const values = inputs.map((input) => input.value.trim());
    let complete = inputs.length >= 1 && inputs.length <= (field.endsWith("arxiv") ? 2 : 8);
    for (const [position, input] of inputs.entries()) {
      complete = setValidity(input, classificationProblem(
        input.value.trim(), source.index, source.ready,
        values.filter((_, index) => index !== position),
      )) && complete;
    }
    return complete;
  }

  function validateField(wrapper) {
    const field = wrapper.dataset.field;
    const profile = FORMALIZATION_FIELDS[field];
    let complete = true;
    if (["text", "prose", "people"].includes(profile.input)) {
      const input = wrapper.querySelector("[name]");
      complete = setValidity(input, input.value.trim() ? "" : "Complete this field.");
    } else if (profile.input === "text-list") {
      complete = validateClassification(wrapper, field);
    } else if (profile.input === "sources") {
      const rows = [...wrapper.querySelectorAll('[data-kind="source"]')];
      complete = rows.length > 0;
      for (const row of rows) {
        for (const control of row.querySelectorAll("[data-part]")) {
          let message = "";
          if (control.dataset.part === "title" && !control.value.trim()) {
            message = "Enter a source title.";
          } else if (control.dataset.part === "relationship" && !control.value.trim()) {
            message = "Describe the source relationship.";
          }
          complete = setValidity(control, message) && complete;
        }
      }
    } else if (profile.input === "methods") {
      const rows = [...wrapper.querySelectorAll('[data-kind="method"]')];
      complete = rows.length > 0;
      for (const control of wrapper.querySelectorAll('[data-part="method"]')) {
        const message = control.value.trim() ? "" : "Describe the automation method.";
        complete = setValidity(control, message) && complete;
      }
    } else {
      for (const control of wrapper.querySelectorAll("[required]")) {
        complete = setValidity(control, control.value.trim() ? "" : "Complete this field.") && complete;
      }
    }
    let problem = "";
    if (complete) {
      try {
        normalizedRepairEdits([edit(wrapper)], FORMALIZATION_PROFILE_VERSION);
      } catch (error) {
        problem = error instanceof Error ? error.message : "Check this field.";
        complete = false;
      }
    }
    groupValidity(wrapper, problem);
    wrapper.dataset.needsAction = String(!complete);
    return complete;
  }

  function validate() {
    if (!active) return false;
    let complete = true;
    for (const wrapper of fields.querySelectorAll(".repair-field")) {
      complete = validateField(wrapper) && complete;
    }
    return complete && fields.children.length > 0;
  }

  fields.addEventListener("input", validate);
  fields.addEventListener("change", validate);
  fields.addEventListener("focusout", (event) => {
    if (event.target.matches("input, textarea, select")) {
      event.target.dataset.touched = "true";
      validate();
    }
  });

  return {
    get active() { return active; },
    clear() {
      active = false;
      attempted = false;
      intent = null;
      fields.replaceChildren();
      container.hidden = true;
      setStatus();
    },
    render(failure, restoredEdits = [], options = {}) {
      intent = options.intent ?? null;
      const restored = Object.fromEntries(
        (Array.isArray(restoredEdits) ? restoredEdits : [])
          .filter((item) => item?.field && Object.hasOwn(item, "value"))
          .map((item) => [item.field, item.value]),
      );
      const displayFailure = Object.keys(restored).length ? {
        ...failure,
        repair_draft: {
          values: { ...(failure.repair_draft?.values ?? {}), ...restored },
          origins: {
            ...(failure.repair_draft?.origins ?? {}),
            ...Object.fromEntries(Object.keys(restored).map((field) => [field, "your previous attempt"])),
          },
        },
      } : failure;
      const diagnostics = [...new Map(
        (failure?.diagnostics ?? [])
          .filter((item) => item.field && FORMALIZATION_FIELDS[item.field])
          .map((item) => [item.field, item]),
      ).values()];
      fields.replaceChildren();
      for (const diagnostic of diagnostics) {
        const profile = FORMALIZATION_FIELDS[diagnostic.field];
        const wrapper = document.createElement("div");
        wrapper.className = "repair-field";
        const id = `preflight-repair-${diagnostic.field.replaceAll(".", "-")}`;
        const label = el("label", profile.label);
        label.htmlFor = id;
        const hint = el("p", profile.description);
        const origin = displayFailure.repair_draft?.origins?.[diagnostic.field];
        if (origin) hint.append(` Palomar carried this value forward from ${origin}; confirm it.`);
        hint.className = "hint";
        wrapper.append(label);
        appendControl(wrapper, diagnostic, displayFailure);
        const first = wrapper.querySelector("input, textarea, select");
        if (first) first.id = id;
        wrapper.append(hint);
        fields.append(wrapper);
      }
      active = diagnostics.length > 0;
      attempted = false;
      container.hidden = !active;
      setStatus(active
        ? "Complete these fields, then authenticate to let Palomar prepare a pull request."
        : "");
      validate();
      return active;
    },
    payload() {
      if (!active) return null;
      attempted = true;
      if (!validate()) {
        setStatus("Complete the highlighted fields, or select the submit-anyway checkbox.");
        fields.querySelector('[data-needs-action="true"] input, [data-needs-action="true"] textarea, [data-needs-action="true"] select')?.focus();
        return null;
      }
      try {
        const edits = normalizedRepairEdits(
          [...fields.querySelectorAll(".repair-field")].map(edit),
          FORMALIZATION_PROFILE_VERSION,
        );
        setStatus();
        return JSON.stringify({
          profile_version: FORMALIZATION_PROFILE_VERSION,
          ...(intent ? { intent } : {}),
          edits,
        });
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Check the metadata fields.");
        return null;
      }
    },
  };
}
