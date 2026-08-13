/** Aggregate-only validation and rendering for the private operational dashboard. */

import { STATUSES } from "./submission.js";

const TAKEDOWN_ISSUE_FORM =
  "https://github.com/PalomarRegistry/PalomarDatabase/issues/new?template=takedown.yml";
const RESTORATION_ISSUE_FORM =
  "https://github.com/PalomarRegistry/PalomarDatabase/issues/new?template=restoration.yml";
const PRICE_SCHEDULE = "gpt-5.6-sol-2026-08-10";
const DEFINITIONS = {
  submission: "one non-test durable submissions/<id>/state.json record",
  technical_test: "a marked workflow exercise excluded from outcome, latency, and spend denominators",
  round: "one completed spend item; started rounds are reported separately",
  target: "case-folded repository plus normalized comparator configuration path; aggregate target metrics exclude historical rows without complete target identity",
  landed: "a submission with a registered event",
  pricing: "official https://developers.openai.com/api/docs/models/gpt-5.6-sol; broker estimates are not billing authority",
};
const COST_BINS = [
  ["$0–$1", 0, 1],
  ["$1–$2", 1, 2],
  ["$2–$3", 2, 3],
  ["$3–$5", 3, 5],
  ["$5–$10", 5, 10],
  ["$10+", 10, null],
];

const TOP_LEVEL_KEYS = [
  "schema_version",
  "source",
  "definitions",
  "totals",
  "submission_statuses",
  "rates",
  "latency_seconds",
  "distributions",
  "model_spend",
  "cost_model",
];


function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}


export class DashboardContractError extends TypeError {
  constructor(path, problem) {
    super(`private operational report has an invalid aggregate contract at ${path}: ${problem}`);
    this.name = "DashboardContractError";
  }
}


function fail(path, problem) {
  throw new DashboardContractError(path, problem);
}


function object(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value;
}


function exactKeys(value, expected, path) {
  object(value, path);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  const missing = wanted.filter((key) => !actual.includes(key));
  const unexpected = actual.filter((key) => !wanted.includes(key));
  const problems = [];
  if (missing.length) problems.push(`missing ${missing.join(", ")}`);
  if (unexpected.length) problems.push(`unexpected ${unexpected.join(", ")}`);
  if (problems.length) fail(path, problems.join("; "));
}


function exactText(value, expected, path) {
  if (value !== expected) fail(path, "unexpected value");
}


function timestamp(value, path, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    fail(path, "expected a UTC timestamp without fractional seconds");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().replace(".000Z", "Z") !== value) {
    fail(path, "expected a valid UTC timestamp");
  }
}


function number(value, path, { integer = false, nullable = false, maximum = Infinity } = {}) {
  if (nullable && value === null) return;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > maximum ||
    (integer && !Number.isInteger(value))
  ) fail(path, integer ? "expected a nonnegative integer" : "expected a nonnegative number");
}


function stats(value, path) {
  exactKeys(value, ["count", "min", "mean", "median", "max"], path);
  number(value.count, `${path}.count`, { integer: true });
  for (const key of ["min", "mean", "median", "max"]) {
    number(value[key], `${path}.${key}`, { nullable: true });
  }
  if (value.count === 0 && [value.min, value.mean, value.median, value.max].some((item) => item !== null)) {
    fail(path, "empty statistics must use null extrema");
  }
  if (value.count > 0 && [value.min, value.mean, value.median, value.max].some((item) => item === null)) {
    fail(path, "nonempty statistics require every extremum");
  }
  if (value.count > 0 && !(value.min <= value.mean && value.mean <= value.max && value.min <= value.median && value.median <= value.max)) {
    fail(path, "statistics are not ordered");
  }
}


function costHistogram(value, path) {
  if (!Array.isArray(value) || value.length !== COST_BINS.length) {
    fail(path, `expected exactly ${COST_BINS.length} cost bins`);
  }
  for (const [index, row] of value.entries()) {
    const rowPath = `${path}[${index}]`;
    exactKeys(row, ["label", "lower_usd", "upper_usd", "definite_count", "possible_count"], rowPath);
    const [label, lower, upper] = COST_BINS[index];
    exactText(row.label, label, `${rowPath}.label`);
    number(row.lower_usd, `${rowPath}.lower_usd`);
    number(row.upper_usd, `${rowPath}.upper_usd`, { nullable: true });
    if (row.lower_usd !== lower || row.upper_usd !== upper) {
      fail(rowPath, "cost-bin boundaries do not match the schema");
    }
    number(row.definite_count, `${rowPath}.definite_count`, { integer: true });
    number(row.possible_count, `${rowPath}.possible_count`, { integer: true });
  }
}


function spend(value, path) {
  exactKeys(value, [
    "count",
    "ambiguous_count",
    "partial_count",
    "lower",
    "upper",
    "total_lower_usd",
    "total_upper_usd",
    "histogram",
  ], path);
  number(value.count, `${path}.count`, { integer: true });
  number(value.ambiguous_count, `${path}.ambiguous_count`, { integer: true });
  number(value.partial_count, `${path}.partial_count`, { integer: true });
  if (value.ambiguous_count > value.count) fail(path, "ambiguous count exceeds total count");
  if (value.partial_count > value.count) fail(path, "partial count exceeds total count");
  stats(value.lower, `${path}.lower`);
  stats(value.upper, `${path}.upper`);
  if (value.lower.count !== value.count || value.upper.count !== value.count) {
    fail(path, "range statistic counts do not match spend count");
  }
  number(value.total_lower_usd, `${path}.total_lower_usd`);
  number(value.total_upper_usd, `${path}.total_upper_usd`);
  if (value.total_lower_usd > value.total_upper_usd) fail(path, "lower total exceeds upper total");
  if (value.count > 0 && value.lower.mean > value.upper.mean) fail(path, "lower mean exceeds upper mean");
  costHistogram(value.histogram, `${path}.histogram`);
}


function discreteHistogram(value, path) {
  if (!Array.isArray(value) || value.length > 100) fail(path, "expected at most 100 histogram rows");
  for (const [index, row] of value.entries()) {
    const rowPath = `${path}[${index}]`;
    exactKeys(row, ["value", "count"], rowPath);
    number(row.value, `${rowPath}.value`, { integer: true });
    number(row.count, `${rowPath}.count`, { integer: true });
    if (row.count === 0) fail(`${rowPath}.count`, "histogram rows cannot be empty");
  }
}


function escapedNumber(value) {
  return escapeHtml(value);
}


function money(block) {
  if (!block.count) return "No priced observations";
  const partial = block.partial_count ? `; ${escapeHtml(block.partial_count)} partial` : "";
  return `$${escapeHtml(block.lower.mean.toFixed(2))}–$${escapeHtml(block.upper.mean.toFixed(2))} mean; ` +
    `$${escapeHtml(block.total_lower_usd.toFixed(2))}–$${escapeHtml(block.total_upper_usd.toFixed(2))} ` +
    `total over ${escapeHtml(block.count)} priced observations${partial}`;
}


function histogram(rows) {
  if (rows.length === 0) return "<p>None yet.</p>";
  const largest = Math.max(...rows.map((row) => row.count));
  return `<table><thead><tr><th>Value</th><th>Count</th><th></th></tr></thead><tbody>${rows.map((row) => {
    return `<tr><td>${escapedNumber(row.value)}</td><td>${escapedNumber(row.count)}</td><td><meter min="0" max="${escapedNumber(largest)}" value="${escapedNumber(row.count)}">${escapedNumber(row.count)}</meter></td></tr>`;
  }).join("")}</tbody></table>`;
}


function renderCostHistogram(rows) {
  return `<table><thead><tr><th>Spend</th><th>Definite</th><th>Possible</th></tr></thead><tbody>${rows.map((row) =>
    `<tr><td>${escapeHtml(row.label)}</td><td>${escapedNumber(row.definite_count)}</td><td>${escapedNumber(row.possible_count)}</td></tr>`
  ).join("")}</tbody></table>`;
}


function duration(value) {
  if (value === null) return "No observations";
  if (value < 120) return `${escapeHtml(Math.round(value))} seconds`;
  if (value < 7200) return `${escapeHtml((value / 60).toFixed(1))} minutes`;
  return `${escapeHtml((value / 3600).toFixed(1))} hours`;
}


export function withDashboardActions(report) {
  return {
    ...validateDashboardReport(report),
    operator_actions: {
      status: "direct-moderation-forms",
      takedown: TAKEDOWN_ISSUE_FORM,
      restoration: RESTORATION_ISSUE_FORM,
      note: "Each form starts the reviewed one-Moderator workflow in the private Database repository.",
    },
  };
}


export function dashboardHtml(report, login) {
  const totals = report.totals;
  const distributions = report.distributions;
  const actions = report.operator_actions;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta name="robots" content="noindex,nofollow"><title>Palomar operations</title>
<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/dashboard.css">
</head><body><header><h1>Palomar operations</h1><p>Signed in as ${escapeHtml(login)}</p></header><main>
<p><small>Aggregate private data from State snapshot <code>${escapeHtml(report.source.state_revision)}</code>; latest included event ${escapeHtml(report.source.latest_event_at ?? "none")}.</small></p>
<section class="cards">
<div class="card"><div class="number">${escapedNumber(totals.submissions)}</div>submissions<br>${escapedNumber(totals.submissions_landed)} landed; ${escapedNumber(totals.submissions_active)} active</div>
<div class="card"><div class="number">${escapedNumber(totals.targets)}</div>targets<br>${escapedNumber(totals.targets_landed)} landed; ${escapedNumber(totals.submissions_target_identity_incomplete)} historical submissions excluded</div>
<div class="card"><div class="number">${escapedNumber(totals.review_rounds_completed)}</div>completed review rounds<br>${escapedNumber(totals.review_rounds_unpriced)} unpriced</div>
</section>
${totals.landed_targets_attempt_history_incomplete ? `<p><small>Retry history is omitted for ${escapedNumber(totals.landed_targets_attempt_history_incomplete)} landed target(s) with incomplete historical identity.</small></p>` : ""}
<h2>Model spend</h2><ul>
<li>Per completed round: ${money(report.model_spend.per_round)}</li>
<li>Per reviewed submission: ${money(report.model_spend.per_submission_with_review)}</li>
<li>Per reviewed target: ${money(report.model_spend.per_target_with_review)}</li>
</ul>
<h3>Spend per completed round</h3>${renderCostHistogram(report.model_spend.per_round.histogram)}
<h3>Spend per reviewed submission</h3>${renderCostHistogram(report.model_spend.per_submission_with_review.histogram)}
<h3>Spend per reviewed target</h3>${renderCostHistogram(report.model_spend.per_target_with_review.histogram)}
<h2>Median elapsed time</h2><ul>
<li>Creation to verification success: ${duration(report.latency_seconds.creation_to_verification_success.median)}</li>
<li>Creation to review ready: ${duration(report.latency_seconds.creation_to_review_ready.median)}</li>
<li>Creation to landing: ${duration(report.latency_seconds.creation_to_first_land.median)}</li>
</ul>
<h2>Review rounds per submission</h2>${histogram(distributions.review_rounds_completed_per_submission)}
<h2>Submission attempts to first landing</h2>${histogram(distributions.submission_attempts_to_first_land_per_landed_target)}
<h2>Failed or abandoned attempts before first landing</h2>${histogram(distributions.failed_or_abandoned_attempts_before_first_land_per_landed_target)}
<h2>Review rounds to first landing</h2>${histogram(distributions.review_rounds_to_first_land_per_landed_target)}
<h2>Moderator actions</h2><ul>
<li><a href="${escapeHtml(actions.takedown)}">Take down a version</a></li>
<li><a href="${escapeHtml(actions.restoration)}">Restore a version</a></li>
</ul>
<p><small>${escapeHtml(actions.note)}</small></p>
<p><a href="/api/dashboard">Machine-readable aggregate JSON</a></p>
</main></body></html>`;
}


export const SUPPORTED_DASHBOARD_SCHEMA_VERSIONS = Object.freeze([1]);


function validateDashboardReportV1(report) {
  exactKeys(report, TOP_LEVEL_KEYS, "$");
  exactText(report.schema_version, 1, "$.schema_version");

  exactKeys(report.source, ["state_revision", "latest_event_at", "pricing_schedule"], "$.source");
  if (!/^submissions-tree:[0-9a-f]{40}$/.test(report.source.state_revision)) {
    fail("$.source.state_revision", "expected submissions-tree followed by a 40-character lowercase commit hash");
  }
  timestamp(report.source.latest_event_at, "$.source.latest_event_at", true);
  exactText(report.source.pricing_schedule, PRICE_SCHEDULE, "$.source.pricing_schedule");

  exactKeys(report.definitions, [
    "submission", "technical_test", "round", "target", "landed", "pricing",
  ], "$.definitions");
  for (const [key, value] of Object.entries(DEFINITIONS)) {
    exactText(report.definitions[key], value, `$.definitions.${key}`);
  }

  exactKeys(report.totals, [
    "submissions",
    "technical_test_submissions_excluded",
    "submissions_landed",
    "submissions_not_landed",
    "submissions_active",
    "submissions_terminal_unlanded",
    "submissions_target_identity_incomplete",
    "submissions_review_attempts_inconsistent",
    "targets",
    "targets_landed",
    "targets_not_landed",
    "landed_targets_round_timing_incomplete",
    "landed_targets_attempt_history_incomplete",
    "review_rounds_started",
    "review_rounds_completed",
    "review_rounds_priced",
    "review_rounds_unpriced",
  ], "$.totals");
  for (const [key, value] of Object.entries(report.totals)) {
    number(value, `$.totals.${key}`, { integer: true });
  }

  object(report.submission_statuses, "$.submission_statuses");
  for (const [key, value] of Object.entries(report.submission_statuses)) {
    if (!Object.hasOwn(STATUSES, key)) fail(`$.submission_statuses.${key}`, "unknown submission status");
    number(value, `$.submission_statuses.${key}`, { integer: true });
  }

  exactKeys(report.rates, ["landed_per_submission", "landed_per_terminal_submission", "landed_per_target"], "$.rates");
  for (const [key, value] of Object.entries(report.rates)) {
    number(value, `$.rates.${key}`, { nullable: true, maximum: 1 });
  }

  exactKeys(report.latency_seconds, [
    "creation_to_verification_success",
    "creation_to_review_ready",
    "creation_to_first_land",
    "creation_to_terminal",
  ], "$.latency_seconds");
  for (const [key, value] of Object.entries(report.latency_seconds)) {
    stats(value, `$.latency_seconds.${key}`);
  }

  exactKeys(report.distributions, [
    "review_rounds_completed_per_submission",
    "submission_attempts_to_first_land_per_landed_target",
    "failed_or_abandoned_attempts_before_first_land_per_landed_target",
    "review_rounds_to_first_land_per_landed_target",
  ], "$.distributions");
  for (const [key, value] of Object.entries(report.distributions)) {
    discreteHistogram(value, `$.distributions.${key}`);
  }

  exactKeys(report.model_spend, ["per_round", "per_submission_with_review", "per_target_with_review"], "$.model_spend");
  for (const [key, value] of Object.entries(report.model_spend)) {
    spend(value, `$.model_spend.${key}`);
  }

  exactKeys(report.cost_model, [
    "schema_version",
    "state_revision",
    "pricing_schedule",
    "completed_review_rounds",
    "priced_review_rounds",
    "mean_model_usd_per_review_round_lower",
    "mean_model_usd_per_review_round_upper",
  ], "$.cost_model");
  exactText(report.cost_model.schema_version, 1, "$.cost_model.schema_version");
  exactText(report.cost_model.state_revision, report.source.state_revision, "$.cost_model.state_revision");
  exactText(report.cost_model.pricing_schedule, PRICE_SCHEDULE, "$.cost_model.pricing_schedule");
  number(report.cost_model.completed_review_rounds, "$.cost_model.completed_review_rounds", { integer: true });
  number(report.cost_model.priced_review_rounds, "$.cost_model.priced_review_rounds", { integer: true });
  number(report.cost_model.mean_model_usd_per_review_round_lower, "$.cost_model.mean_model_usd_per_review_round_lower", { nullable: true });
  number(report.cost_model.mean_model_usd_per_review_round_upper, "$.cost_model.mean_model_usd_per_review_round_upper", { nullable: true });
  return report;
}


export function validateDashboardReport(report) {
  object(report, "$");
  if (!SUPPORTED_DASHBOARD_SCHEMA_VERSIONS.includes(report.schema_version)) {
    fail("$.schema_version", `unsupported schema version ${String(report.schema_version)}`);
  }
  return validateDashboardReportV1(report);
}
