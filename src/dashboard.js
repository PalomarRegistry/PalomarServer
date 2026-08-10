/** Aggregate-only validation and rendering for the private operational dashboard. */

import { STATUSES } from "./submission.js";

const MODERATION_ISSUE_CHOOSER =
  "https://github.com/PalomarRegistry/PalomarDatabase/issues/new/choose";
const MODERATION_IMPLEMENTATION_ISSUE =
  "https://github.com/PalomarRegistry/PalomarDatabase/issues/123";
const PRICE_SCHEDULE = "gpt-5.6-sol-2026-08-10";
const DEFINITIONS = {
  submission: "one durable submissions/<id>/state.json record",
  round: "one completed spend item; started rounds are reported separately",
  target: "case-folded repository plus normalized comparator configuration path",
  landed: "a submission with a registered event",
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


function fail() {
  throw new TypeError("private operational report has an invalid aggregate contract");
}


function object(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  return value;
}


function exactKeys(value, expected) {
  object(value);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail();
}


function exactText(value, expected) {
  if (value !== expected) fail();
}


function timestamp(value, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) fail();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().replace(".000Z", "Z") !== value) fail();
}


function number(value, { integer = false, nullable = false, maximum = Infinity } = {}) {
  if (nullable && value === null) return;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > maximum ||
    (integer && !Number.isInteger(value))
  ) fail();
}


function stats(value) {
  exactKeys(value, ["count", "min", "mean", "median", "max"]);
  number(value.count, { integer: true });
  for (const key of ["min", "mean", "median", "max"]) number(value[key], { nullable: true });
  if (value.count === 0 && [value.min, value.mean, value.median, value.max].some((item) => item !== null)) fail();
  if (value.count > 0 && [value.min, value.mean, value.median, value.max].some((item) => item === null)) fail();
  if (value.count > 0 && !(value.min <= value.mean && value.mean <= value.max && value.min <= value.median && value.median <= value.max)) fail();
}


function costHistogram(value) {
  if (!Array.isArray(value) || value.length !== COST_BINS.length) fail();
  for (const [index, row] of value.entries()) {
    exactKeys(row, ["label", "lower_usd", "upper_usd", "definite_count", "possible_count"]);
    const [label, lower, upper] = COST_BINS[index];
    exactText(row.label, label);
    number(row.lower_usd);
    number(row.upper_usd, { nullable: true });
    if (row.lower_usd !== lower || row.upper_usd !== upper) fail();
    number(row.definite_count, { integer: true });
    number(row.possible_count, { integer: true });
  }
}


function spend(value) {
  exactKeys(value, [
    "count",
    "ambiguous_count",
    "lower",
    "upper",
    "total_lower_usd",
    "total_upper_usd",
    "histogram",
  ]);
  number(value.count, { integer: true });
  number(value.ambiguous_count, { integer: true });
  if (value.ambiguous_count > value.count) fail();
  stats(value.lower);
  stats(value.upper);
  if (value.lower.count !== value.count || value.upper.count !== value.count) fail();
  number(value.total_lower_usd);
  number(value.total_upper_usd);
  if (value.total_lower_usd > value.total_upper_usd) fail();
  if (value.count > 0 && value.lower.mean > value.upper.mean) fail();
  costHistogram(value.histogram);
}


function discreteHistogram(value) {
  if (!Array.isArray(value) || value.length > 100) fail();
  for (const row of value) {
    exactKeys(row, ["value", "count"]);
    number(row.value, { integer: true });
    number(row.count, { integer: true });
    if (row.count === 0) fail();
  }
}


function escapedNumber(value) {
  return escapeHtml(value);
}


function money(block) {
  if (!block.count) return "No priced observations";
  return `$${escapeHtml(block.lower.mean.toFixed(2))}–$${escapeHtml(block.upper.mean.toFixed(2))} mean; ` +
    `$${escapeHtml(block.total_lower_usd.toFixed(2))}–$${escapeHtml(block.total_upper_usd.toFixed(2))} ` +
    `total over ${escapeHtml(block.count)} priced observations`;
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
      status: "issue-chooser-fallback",
      issue_chooser: MODERATION_ISSUE_CHOOSER,
      workflow_status: MODERATION_IMPLEMENTATION_ISSUE,
      note: (
        "Take down and restore currently open the Database issue-form chooser; " +
        "Database #123 is implementing the direct forms."
      ),
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
<div class="card"><div class="number">${escapedNumber(totals.targets)}</div>targets<br>${escapedNumber(totals.targets_landed)} landed</div>
<div class="card"><div class="number">${escapedNumber(totals.review_rounds_completed)}</div>completed review rounds<br>${escapedNumber(totals.review_rounds_unpriced)} unpriced</div>
</section>
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
<li><a href="${escapeHtml(actions.issue_chooser)}">Take down a version</a></li>
<li><a href="${escapeHtml(actions.issue_chooser)}">Restore a version</a></li>
<li><a href="${escapeHtml(actions.workflow_status)}">Workflow implementation and status (Database #123)</a></li>
</ul>
<p><small>${escapeHtml(actions.note)}</small></p>
<p><a href="/api/dashboard">Machine-readable aggregate JSON</a></p>
</main></body></html>`;
}


export function validateDashboardReport(report) {
  exactKeys(report, TOP_LEVEL_KEYS);
  if (report.schema_version !== 1) fail();

  exactKeys(report.source, ["state_revision", "latest_event_at", "pricing_schedule"]);
  if (!/^submissions-tree:[0-9a-f]{40}$/.test(report.source.state_revision)) fail();
  timestamp(report.source.latest_event_at, true);
  exactText(report.source.pricing_schedule, PRICE_SCHEDULE);

  exactKeys(report.definitions, ["submission", "round", "target", "landed"]);
  for (const [key, value] of Object.entries(DEFINITIONS)) exactText(report.definitions[key], value);

  exactKeys(report.totals, [
    "submissions",
    "submissions_landed",
    "submissions_not_landed",
    "submissions_active",
    "submissions_terminal_unlanded",
    "targets",
    "targets_landed",
    "targets_not_landed",
    "review_rounds_started",
    "review_rounds_completed",
    "review_rounds_priced",
    "review_rounds_unpriced",
  ]);
  for (const value of Object.values(report.totals)) number(value, { integer: true });

  object(report.submission_statuses);
  for (const [key, value] of Object.entries(report.submission_statuses)) {
    if (!Object.hasOwn(STATUSES, key)) fail();
    number(value, { integer: true });
  }

  exactKeys(report.rates, ["landed_per_submission", "landed_per_terminal_submission", "landed_per_target"]);
  for (const value of Object.values(report.rates)) number(value, { nullable: true, maximum: 1 });

  exactKeys(report.latency_seconds, [
    "creation_to_verification_success",
    "creation_to_review_ready",
    "creation_to_first_land",
    "creation_to_terminal",
  ]);
  for (const value of Object.values(report.latency_seconds)) stats(value);

  exactKeys(report.distributions, [
    "review_rounds_completed_per_submission",
    "submission_attempts_to_first_land_per_landed_target",
    "failed_or_abandoned_attempts_before_first_land_per_landed_target",
    "review_rounds_to_first_land_per_landed_target",
  ]);
  for (const value of Object.values(report.distributions)) discreteHistogram(value);

  exactKeys(report.model_spend, ["per_round", "per_submission_with_review", "per_target_with_review"]);
  for (const value of Object.values(report.model_spend)) spend(value);

  exactKeys(report.cost_model, [
    "schema_version",
    "state_revision",
    "pricing_schedule",
    "completed_review_rounds",
    "priced_review_rounds",
    "mean_model_usd_per_review_round_lower",
    "mean_model_usd_per_review_round_upper",
  ]);
  if (report.cost_model.schema_version !== 1) fail();
  exactText(report.cost_model.state_revision, report.source.state_revision);
  exactText(report.cost_model.pricing_schedule, PRICE_SCHEDULE);
  number(report.cost_model.completed_review_rounds, { integer: true });
  number(report.cost_model.priced_review_rounds, { integer: true });
  number(report.cost_model.mean_model_usd_per_review_round_lower, { nullable: true });
  number(report.cost_model.mean_model_usd_per_review_round_upper, { nullable: true });
  return report;
}
