/** Pure browser-form decisions, kept separate so Node tests can exercise them. */

export function taxonomyIndex(data) {
  const entries = Array.isArray(data)
    ? data.map((code) => [code, ""])
    : data && typeof data === "object" ? Object.entries(data) : [];
  const codes = new Map();
  const summaries = new Map();
  const accepted = [];
  for (const [code, description] of entries) {
    if (typeof code !== "string" || !code) continue;
    const summary = typeof description === "string" ? description : "";
    codes.set(code.toUpperCase(), code);
    if (summary) summaries.set(code, summary);
    accepted.push([code, summary]);
  }
  return accepted.length ? { entries: accepted, codes, summaries } : null;
}

export function canonicalClassification(value, index) {
  return index?.codes.get(String(value ?? "").trim().toUpperCase()) ?? null;
}

export function classificationProblem(value, index, ready, otherValues = []) {
  const text = String(value ?? "").trim();
  if (!text) return "Enter a classification code.";
  const normalized = text.toUpperCase();
  if (otherValues.some((item) => String(item).trim().toUpperCase() === normalized)) {
    return "Use each classification code only once.";
  }
  if (ready && index && !canonicalClassification(text, index)) {
    return "Choose a code from the official classification.";
  }
  return "";
}

export function shouldShowDiagnostic(diagnostic, canRequestRepair, repairedFields) {
  return !(canRequestRepair && repairedFields.has(diagnostic.field));
}
