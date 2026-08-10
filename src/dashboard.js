/** Aggregate-only rendering for the private operational dashboard. */

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}


function money(block) {
  if (!block?.count) return "No priced observations";
  return `$${block.lower.mean.toFixed(2)}–$${block.upper.mean.toFixed(2)} mean; ` +
    `$${block.total_lower_usd.toFixed(2)}–$${block.total_upper_usd.toFixed(2)} total`;
}


function histogram(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return "<p>None yet.</p>";
  const largest = Math.max(...rows.map((row) => row.count));
  return `<table><thead><tr><th>Value</th><th>Count</th><th></th></tr></thead><tbody>${rows.map((row) => {
    return `<tr><td>${row.value}</td><td>${row.count}</td><td><meter min="0" max="${largest}" value="${row.count}">${row.count}</meter></td></tr>`;
  }).join("")}</tbody></table>`;
}


function costHistogram(rows) {
  if (!Array.isArray(rows)) return "";
  return `<table><thead><tr><th>Spend</th><th>Definite</th><th>Possible</th></tr></thead><tbody>${rows.map((row) =>
    `<tr><td>${escapeHtml(row.label)}</td><td>${row.definite_count}</td><td>${row.possible_count}</td></tr>`
  ).join("")}</tbody></table>`;
}


function duration(value) {
  if (typeof value !== "number") return "No observations";
  if (value < 120) return `${Math.round(value)} seconds`;
  if (value < 7200) return `${(value / 60).toFixed(1)} minutes`;
  return `${(value / 3600).toFixed(1)} hours`;
}


export function dashboardHtml(report, login) {
  const totals = report.totals;
  const distributions = report.distributions;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta name="robots" content="noindex,nofollow"><title>Palomar operations</title>
<link rel="stylesheet" href="/dashboard.css">
</head><body><header><h1>Palomar operations</h1><p>Signed in as ${escapeHtml(login)}</p></header>
<p><small>Aggregate private data from State snapshot <code>${escapeHtml(report.source.state_revision)}</code>; latest included event ${escapeHtml(report.source.latest_event_at ?? "none")}.</small></p>
<section class="cards">
<div class="card"><div class="number">${totals.submissions}</div>submissions<br>${totals.submissions_landed} landed; ${totals.submissions_active} active</div>
<div class="card"><div class="number">${totals.targets}</div>targets<br>${totals.targets_landed} landed</div>
<div class="card"><div class="number">${totals.review_rounds_completed}</div>completed review rounds<br>${totals.review_rounds_unpriced} unpriced</div>
</section>
<h2>Model spend</h2><ul>
<li>Per completed round: ${money(report.model_spend.per_round)}</li>
<li>Per reviewed submission: ${money(report.model_spend.per_submission_with_review)}</li>
<li>Per reviewed target: ${money(report.model_spend.per_target_with_review)}</li>
</ul>
<h3>Spend per completed round</h3>${costHistogram(report.model_spend.per_round.histogram)}
<h3>Spend per reviewed submission</h3>${costHistogram(report.model_spend.per_submission_with_review.histogram)}
<h3>Spend per reviewed target</h3>${costHistogram(report.model_spend.per_target_with_review.histogram)}
<h2>Median elapsed time</h2><ul>
<li>Creation to verification success: ${duration(report.latency_seconds?.creation_to_verification_success?.median)}</li>
<li>Creation to review ready: ${duration(report.latency_seconds?.creation_to_review_ready?.median)}</li>
<li>Creation to landing: ${duration(report.latency_seconds?.creation_to_first_land?.median)}</li>
</ul>
<h2>Review rounds per submission</h2>${histogram(distributions.review_rounds_completed_per_submission)}
<h2>Submission attempts to first landing</h2>${histogram(distributions.submission_attempts_to_first_land_per_landed_target)}
<h2>Failed or abandoned attempts before first landing</h2>${histogram(distributions.failed_or_abandoned_attempts_before_first_land_per_landed_target)}
<h2>Review rounds to first landing</h2>${histogram(distributions.review_rounds_to_first_land_per_landed_target)}
<p><a href="/api/dashboard">Machine-readable aggregate JSON</a></p>
</body></html>`;
}


export function validateDashboardReport(report) {
  if (
    report?.schema_version !== 1 ||
    typeof report?.source?.state_revision !== "string" ||
    typeof report?.totals?.submissions !== "number" ||
    typeof report?.model_spend?.per_round !== "object" ||
    typeof report?.distributions !== "object" ||
    (Object.hasOwn(report, "submissions") || Object.hasOwn(report, "targets"))
  ) throw new TypeError("private operational report has an invalid aggregate contract");
  return report;
}
