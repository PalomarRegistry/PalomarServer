import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  BROWSER_PREFLIGHT_POLICY,
  comparatorDeclarations,
  duplicateJsonKeys,
  formalizationDescription,
  formalizationRepairDraft,
  guidedFormalizationDiagnostics,
  inspectTree,
  validateComparator,
  validateFormalization,
  validateFormalizationRepair,
  validateToolchain,
} from "../browser/preflight.js";

const VALID_FORMALIZATION = `
version: v0.4
project:
  name: Example
  description: A formalization of the example result.
  authors: [Example Author]
  license: MIT
  responsible_maintainers: [Example Maintainer]
classification:
  arxiv: [math.LO]
  msc2020: [03B35]
sources:
  - title: Original result
    type: original-proof
    relationship: other
automation:
  methods:
    - method: manual
review:
  status: self-assessed
`;

test("portable metadata validation accepts the current minimal contract", () => {
  assert.deepEqual(validateFormalization(VALID_FORMALIZATION), []);
});

test("classification scheme keys are case-insensitive but unambiguous", () => {
  const mixedCase = VALID_FORMALIZATION
    .replace("  arxiv:", "  arXiv:")
    .replace("  msc2020:", "  MSC2020:");
  assert.deepEqual(validateFormalization(mixedCase), []);
  assert.deepEqual(formalizationRepairDraft(mixedCase).values["classification.arxiv"], [
    "math.LO",
  ]);

  const ambiguous = VALID_FORMALIZATION.replace(
    "  arxiv: [math.LO]",
    "  arxiv: [math.LO]\n  arXiv: [math.CO]",
  );
  assert.deepEqual(validateFormalization(ambiguous).map((item) => item.code), [
    "formalization.invalid_yaml",
  ]);
});

test("source contributor roles survive validation and guided repair", () => {
  const metadata = VALID_FORMALIZATION.replace(
    "    relationship: other",
    "    contributors:\n      - name: Wilhelm Magnus\n        role: problem-proposer\n" +
      "      - name: Evgenii Khukhro\n        role: editor\n    relationship: other",
  );
  assert.deepEqual(validateFormalization(metadata), []);
  assert.deepEqual(formalizationRepairDraft(metadata).values.sources[0].contributors, [
    { name: "Wilhelm Magnus", role: "problem-proposer" },
    { name: "Evgenii Khukhro", role: "editor" },
  ]);

  const invalid = metadata.replace("role: editor", "role: ''");
  assert.deepEqual(validateFormalization(invalid).map((item) => item.summary), [
    "sources entry 1 contributor 2 needs a role.",
  ]);
});

test("conflated source field failures name the actual defect", () => {
  const withContributors = (body) => VALID_FORMALIZATION.replace(
    "    relationship: other",
    `    contributors:\n${body}\n    relationship: other`,
  );

  // A blank role is a missing role, not an over-long one.
  assert.deepEqual(
    validateFormalization(withContributors("      - name: A\n        role: '   '"))
      .map((item) => item.summary),
    ["sources entry 1 contributor 1 needs a role."],
  );
  assert.deepEqual(
    validateFormalization(withContributors(`      - name: A\n        role: ${"x".repeat(201)}`))
      .map((item) => item.summary),
    ["sources entry 1 contributor 1 role must be at most 200 characters."],
  );
  // A missing name and an over-long role are reported independently.
  assert.deepEqual(
    validateFormalization(withContributors(`      - role: ${"x".repeat(201)}`))
      .map((item) => item.summary),
    [
      "sources entry 1 contributor 1 needs a name.",
      "sources entry 1 contributor 1 role must be at most 200 characters.",
    ],
  );
  assert.deepEqual(
    validateFormalization(withContributors("      - just a string")).map((item) => item.summary),
    ["sources entry 1 contributor 1 must be a mapping with a name and role."],
  );
  assert.deepEqual(
    validateFormalization(
      VALID_FORMALIZATION.replace("    relationship: other", "    contributors: nope\n    relationship: other"),
    ).map((item) => item.summary),
    ["sources entry 1 contributors must be a list."],
  );
  // A bare `contributors:` key parses to null, which the server contract
  // accepts alongside an empty list; neither carries a claim to validate.
  assert.deepEqual(
    validateFormalization(
      VALID_FORMALIZATION.replace("    relationship: other", "    contributors:\n    relationship: other"),
    ),
    [],
  );
  assert.deepEqual(
    validateFormalization(
      VALID_FORMALIZATION.replace("    relationship: other", "    contributors: []\n    relationship: other"),
    ),
    [],
  );

  // Optional bounded text: absent and empty stay acceptable, blank and
  // non-string report as missing rather than as too long.
  // Based on a source carrying no `type` of its own, so the cases below can
  // set one without colliding with the fixture's original-proof entry.
  const untyped = VALID_FORMALIZATION.replace(
    "    type: original-proof\n    relationship: other",
    "    relationship: formalizes",
  );
  assert.deepEqual(validateFormalization(untyped), []);
  for (const [field, label, maximum] of [
    ["type", "type", 200],
    ["author_endorsement", "author endorsement", 100],
    ["note", "note", 10_000],
  ]) {
    const withField = (value) => untyped.replace(
      "    relationship: formalizes",
      `    relationship: formalizes\n    ${field}: ${value}`,
    );
    assert.deepEqual(validateFormalization(withField("''")), [], `${field} accepts ""`);
    // A bare key parses to null, which the server contract reads as absent.
    assert.deepEqual(validateFormalization(withField("")), [], `${field} accepts a bare key`);
    assert.deepEqual(
      validateFormalization(withField("'   '")).map((item) => item.summary),
      [`sources entry 1 ${label} must be a nonempty string when supplied.`],
    );
    assert.deepEqual(
      validateFormalization(withField("[a, b]")).map((item) => item.summary),
      [`sources entry 1 ${label} must be a nonempty string when supplied.`],
    );
    assert.deepEqual(
      validateFormalization(withField(`"${"x".repeat(maximum + 1)}"`)).map((item) => item.summary),
      [`sources entry 1 ${label} must be at most ${maximum} characters.`],
    );
  }
});

test("preflight exposes the exact public description and Comparator result names", () => {
  assert.deepEqual(formalizationDescription(VALID_FORMALIZATION), {
    text: "A formalization of the example result.",
    origin: "project.description",
    dedicated: true,
  });
  assert.deepEqual(comparatorDeclarations(JSON.stringify({
    theorem_names: ["Example.main", "Example.corollary"],
    definition_names: ["Example.input"],
  })), ["Example.main", "Example.corollary", "Example.input"]);

  const legacy = VALID_FORMALIZATION
    .replace("  description: A formalization of the example result.\n", "")
    .replace("  name: Example\n", "  name: Example\n  short_description: Earlier summary.\n");
  assert.deepEqual(formalizationDescription(legacy), {
    text: "Earlier summary.",
    origin: "project.short_description",
    dedicated: false,
  });
});

test("YAML duplicate and merge keys are deterministic failures", () => {
  for (const source of [
    "project:\n  name: first\n  name: second\n",
    "defaults: &defaults\n  name: Example\nproject:\n  <<: *defaults\n",
  ]) {
    assert.deepEqual(validateFormalization(source).map((item) => item.code), [
      "formalization.invalid_yaml",
    ]);
  }
});

test("portable metadata findings drive safe guided prefills and a complete repair", () => {
  const incomplete = VALID_FORMALIZATION
    .replace("  name: Example\n", "")
    .replace("  authors: [Example Author]\n", "") + `
artifact:
  name: Legacy example
  authors: [Legacy Author]
`;
  assert.deepEqual(
    validateFormalization(incomplete).map((item) => item.field),
    ["project.name", "project.authors"],
  );
  const draft = formalizationRepairDraft(incomplete);
  assert.equal(draft.values["project.name"], "Legacy example");
  assert.deepEqual(draft.values["project.authors"], ["Legacy Author"]);
  assert.deepEqual(validateFormalizationRepair(incomplete, [
    { field: "project.name", value: "Corrected example" },
    { field: "project.authors", value: ["Correct Author"] },
  ]), []);
});

test("a guided arXiv prefill carries every code the policy accepts", () => {
  const many = VALID_FORMALIZATION.replace(
    "  arxiv: [math.LO]",
    "  arxiv: [math.LO, math.AG, math.GR]",
  ).replace("  msc2020: [03B35]", "  msc2020: []");
  assert.deepEqual(validateFormalization(many), []);
  assert.deepEqual(
    formalizationRepairDraft(many).values["classification.arxiv"],
    ["math.LO", "math.AG", "math.GR"],
  );
});

test("the intake repair form hides a classification add control at its limit", async () => {
  const form = await readFile(
    new URL("../public/preflight-repair-form.js", import.meta.url),
    "utf8",
  );
  assert.match(form, /add\.hidden = !canAddClassification\(field, rows\.children\.length\)/);
  assert.match(form, /onRowsChanged\(\);\s+validate\(\)/);
});

test("descriptive formalization metadata accepts bounded free text", async () => {
  const metadata = VALID_FORMALIZATION
    .replace("    type: original-proof", "    type: article")
    .replace("    relationship: other", "    relationship: extends with a new proof")
    .replace(
      "    type: article",
      "    type: article\n    note: Suggested the key lemma.\n    author_endorsement: discussed by email",
    )
    .replace("    - method: manual", "    - method: AI-assisted");
  const diagnostics = validateFormalization(metadata);
  assert.ok(!diagnostics.some((item) => item.summary.includes("type")));
  assert.ok(!diagnostics.some((item) => item.summary.includes("unsupported")));
  // A free-form relationship has the provenance meaning of `other`, so a
  // source-based result still needs one source with a substantive category.
  assert.ok(diagnostics.some((item) => item.summary.includes("source-based results need")));
  const draft = formalizationRepairDraft(metadata);
  assert.equal(draft.values.sources[0].type, "article");
  assert.equal(draft.values.sources[0].relationship, "extends with a new proof");
  assert.equal(draft.values.sources[0].note, "Suggested the key lemma.");
  assert.equal(draft.values.sources[0].author_endorsement, "discussed by email");
  assert.equal(draft.values["automation.methods"][0].method, "AI-assisted");

  const form = await readFile(
    new URL("../public/preflight-repair-form.js", import.meta.url),
    "utf8",
  );
  assert.match(form, /control\.dataset\.originallyInvalid === "true"/);
  assert.match(form, /article, paper, book, formalization/);
});

test("an unfamiliar source relationship has the provenance meaning of other", () => {
  const metadata = VALID_FORMALIZATION.replace(
    "    relationship: other",
    "    relationship: first presented in this formalization",
  );
  assert.deepEqual(validateFormalization(metadata), []);
});

test("a missing source relationship is reported as missing, not as too long", () => {
  const missing = VALID_FORMALIZATION.replace("    relationship: other\n", "");
  assert.deepEqual(validateFormalization(missing).map((item) => item.summary), [
    "sources entry 1 needs a relationship; original-proof entries must use other.",
  ]);

  const blank = VALID_FORMALIZATION.replace(
    "    relationship: other",
    '    relationship: "   "',
  );
  assert.deepEqual(validateFormalization(blank).map((item) => item.summary), [
    "sources entry 1 needs a relationship; original-proof entries must use other.",
  ]);

  const overlong = VALID_FORMALIZATION.replace(
    "    relationship: other",
    `    relationship: ${"x".repeat(501)}`,
  );
  assert.deepEqual(validateFormalization(overlong).map((item) => item.summary), [
    "sources entry 1 relationship must be at most 500 characters.",
  ]);

  // A relationship that is not a string is missing, not unreadable: reading it
  // as free text used to throw before the entry could be reported at all.
  const list = VALID_FORMALIZATION.replace("    relationship: other", "    relationship: [other]");
  assert.deepEqual(validateFormalization(list).map((item) => item.summary), [
    "sources entry 1 needs a relationship; original-proof entries must use other.",
  ]);
});

test("a padded source type still names the entry an original proof", () => {
  const padded = VALID_FORMALIZATION.replace(
    "    type: original-proof",
    '    type: "  original-proof  "',
  );
  assert.deepEqual(validateFormalization(padded), []);

  assert.deepEqual(
    validateFormalization(padded.replace("    relationship: other", "    relationship: formalizes"))
      .map((item) => item.summary),
    [
      "sources original-proof entries must use relationship other.",
      "sources original proofs may use only background or other relationships.",
    ],
  );
});

test("guided repair is offered only when it covers every blocking finding", () => {
  const metadata = {
    code: "formalization.invalid_field",
    field: "project.name",
    summary: "project.name is required",
  };
  assert.deepEqual(guidedFormalizationDiagnostics([
    metadata,
    { code: "license.missing", summary: "No license file", advisory: true },
  ]), [metadata]);
  assert.deepEqual(guidedFormalizationDiagnostics([
    metadata,
    { code: "comparator.invalid_json", summary: "Invalid Comparator configuration" },
  ]), []);
});

test("the JSON scanner finds duplicate keys only within their object", () => {
  assert.deepEqual(
    duplicateJsonKeys('{"outer":{"name":"one","name":"two"},"name":"three"}'),
    ["name"],
  );
  assert.deepEqual(duplicateJsonKeys('{"left":{"name":"one"},"right":{"name":"two"}}'), []);
  assert.deepEqual(duplicateJsonKeys('{"items":[{"name":"one","name":"two"}]}'), ["name"]);
});

test("Comparator validation remains strict JSON with duplicate detection", () => {
  assert.deepEqual(
    validateComparator('{"challenge_module":"A","challenge_module":"B"}')
      .map((item) => item.code),
    ["comparator.duplicate_key"],
  );
});

test("toolchain release candidates sort before the matching release", () => {
  assert.deepEqual(validateToolchain("leanprover/lean4:v4.28.0"), []);
  assert.deepEqual(validateToolchain("leanprover/lean4:v4.28.0-rc1").map((item) => item.code), [
    "toolchain.unsupported",
  ]);
});

test("tree inspection binds required files to the selected project", () => {
  const blob = (path, size = 10) => ({ path, type: "blob", mode: "100644", size, sha: path });
  const entries = [
    blob("LICENSE"),
    blob("proof/lakefile.lean"),
    blob("proof/lake-manifest.json"),
    blob("proof/formalization.yaml"),
    blob("proof/comparator.json"),
    blob("proof/lean-toolchain"),
  ];
  const result = inspectTree(entries, {
    project: "proof",
    comparator: "proof/comparator.json",
    metadata: "",
  });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.files.formalization.path, "proof/formalization.yaml");
});

test("a missing conventional license remains advisory in the browser", () => {
  const blob = (path) => ({ path, type: "blob", mode: "100644", size: 10, sha: path });
  const result = inspectTree([
    blob("lakefile.toml"),
    blob("formalization.yaml"),
    blob("comparator.json"),
    blob("lean-toolchain"),
  ], { project: "", comparator: "comparator.json", metadata: "" });
  const license = result.diagnostics.find((item) => item.code === "license.missing");
  assert.equal(license?.advisory, true);
});

test("the shipped policy remains within the browser payload contract", () => {
  assert.equal(BROWSER_PREFLIGHT_POLICY.schema_version, 1);
  assert.ok(JSON.stringify(BROWSER_PREFLIGHT_POLICY).length < 25_000);
});

test("the lazy browser bundle stays below its compressed page-weight budget", async () => {
  const bundle = await readFile(new URL("../public/preflight.js", import.meta.url));
  assert.ok(gzipSync(bundle).byteLength < 100 * 1024);
});
