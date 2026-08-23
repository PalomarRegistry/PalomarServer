import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import worker from "../src/index.js";
import {
  dashboardHtml,
  validateDashboardReport,
  withDashboardActions,
} from "../src/dashboard.js";


const ENV = {
  GITHUB_TOKEN: "state-token",
  SUBMISSION_TOKEN: "submission-token",
  TOKEN_PEPPER: "test-pepper-with-enough-entropy",
  OAUTH_CLIENT_ID: "client-id",
  OAUTH_CLIENT_SECRET: "client-secret",
  STATE_REPO: "PalomarRegistry/PalomarSubmissionState",
  SUBMISSION_REPO: "PalomarRegistry/PalomarSubmission",
  VERIFY_WORKFLOW: "submission.yml",
  REVIEW_WORKFLOW: "reviewer.yml",
  SITE_URL: "https://palomar-registry.org",
  INTAKE_LIMITER: { limit: async () => ({ success: true }) },
};
const TECHNICAL_MAINTAINER_ID = 477956;


function spendBlock(count, lower, upper) {
  const stats = (value) => ({ count, min: value, mean: value, median: value, max: value });
  const bins = [
    ["$0–$1", 0, 1],
    ["$1–$2", 1, 2],
    ["$2–$3", 2, 3],
    ["$3–$5", 3, 5],
    ["$5–$10", 5, 10],
    ["$10+", 10, null],
  ];
  return {
    count,
    ambiguous_count: lower === upper ? 0 : count,
    partial_count: 0,
    lower: stats(lower),
    upper: stats(upper),
    total_lower_usd: count * lower,
    total_upper_usd: count * upper,
    histogram: bins.map(([label, lowerUsd, upperUsd]) => ({
      label,
      lower_usd: lowerUsd,
      upper_usd: upperUsd,
      definite_count: lower >= lowerUsd && (upperUsd === null || upper < upperUsd) ? count : 0,
      possible_count: upper >= lowerUsd && (upperUsd === null || lower < upperUsd) ? count : 0,
    })),
  };
}


const REPORT = {
  schema_version: 1,
  source: {
    state_revision: `submissions-tree:${"a".repeat(40)}`,
    latest_event_at: "2026-08-10T00:00:00Z",
    pricing_schedule: "gpt-5.6-sol-2026-08-10",
  },
  definitions: {
    submission: "one non-test durable submissions/<id>/state.json record",
    technical_test: "a marked workflow exercise excluded from outcome, latency, and spend denominators",
    round: "one completed spend item; started rounds are reported separately",
    target: "case-folded repository plus normalized comparator configuration path; aggregate target metrics exclude historical rows without complete target identity",
    landed: "a submission with a registered event",
    pricing: "official https://developers.openai.com/api/docs/models/gpt-5.6-sol; broker estimates are not billing authority",
  },
  totals: {
    submissions: 4,
    technical_test_submissions_excluded: 0,
    submissions_landed: 1,
    submissions_not_landed: 3,
    submissions_active: 1,
    submissions_terminal_unlanded: 2,
    submissions_target_identity_incomplete: 1,
    submissions_review_attempts_inconsistent: 0,
    targets: 2,
    targets_landed: 1,
    targets_not_landed: 1,
    landed_targets_round_timing_incomplete: 0,
    landed_targets_attempt_history_incomplete: 1,
    review_rounds_started: 3,
    review_rounds_completed: 3,
    review_rounds_priced: 3,
    review_rounds_unpriced: 0,
  },
  submission_statuses: { registered: 1, "review-ready": 1, withdrawn: 2 },
  rates: {
    landed_per_submission: 0.25,
    landed_per_terminal_submission: 0.333333,
    landed_per_target: 0.5,
  },
  latency_seconds: Object.fromEntries([
    "creation_to_verification_success",
    "creation_to_review_ready",
    "creation_to_first_land",
    "creation_to_terminal",
  ].map((key) => [key, { count: 1, min: 60, mean: 60, median: 60, max: 60 }])),
  model_spend: {
    per_round: spendBlock(3, 1, 2),
    per_submission_with_review: spendBlock(2, 1.5, 3),
    per_target_with_review: spendBlock(1, 3, 6),
  },
  distributions: {
    review_rounds_completed_per_submission: [{ value: 0, count: 2 }, { value: 1, count: 2 }],
    submission_attempts_to_first_land_per_landed_target: [{ value: 2, count: 1 }],
    failed_or_abandoned_attempts_before_first_land_per_landed_target: [{ value: 1, count: 1 }],
    review_rounds_to_first_land_per_landed_target: [{ value: 2, count: 1 }],
  },
  cost_model: {
    schema_version: 1,
    state_revision: `submissions-tree:${"a".repeat(40)}`,
    pricing_schedule: "gpt-5.6-sol-2026-08-10",
    completed_review_rounds: 3,
    priced_review_rounds: 3,
    mean_model_usd_per_review_round_lower: 1,
    mean_model_usd_per_review_round_upper: 2,
  },
};


function inline(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { content: btoa(binary), sha: "b".repeat(40) };
}


async function login(fetchImpl, id = TECHNICAL_MAINTAINER_ID, provider = {}) {
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const text = String(url);
    if (text === "https://github.com/login/oauth/access_token") {
      return provider.token ?? Response.json({ access_token: "ephemeral-user-token" });
    }
    if (text === "https://api.github.com/user") {
      return provider.user ?? Response.json({ login: "maintainer", id });
    }
    return fetchImpl(url, init);
  };
  try {
    const begun = await worker.fetch(new Request("https://submit.example/dashboard/login"), ENV);
    assert.equal(begun.status, 303);
    assert.equal(begun.headers.get("referrer-policy"), "no-referrer");
    const authorize = new URL(begun.headers.get("location"));
    assert.equal(authorize.searchParams.has("scope"), false);
    const oauthCookie = begun.headers.get("set-cookie").split(";", 1)[0];
    const callback = await worker.fetch(
      new Request(
        `https://submit.example/oauth/callback?code=one&state=${authorize.searchParams.get("state")}`,
        { headers: { cookie: oauthCookie } },
      ),
      ENV,
    );
    return callback;
  } finally {
    globalThis.fetch = saved;
  }
}


test("dashboard login authorizes the checked-in Technical Maintainer ids", async () => {
  const callback = await login(() => {
    throw new Error("unexpected fetch");
  });
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get("location"), "/dashboard");
  assert.equal(callback.headers.get("referrer-policy"), "no-referrer");
  assert.match(callback.headers.get("set-cookie"), /__Host-palomar_dashboard=/);
  assert.match(callback.headers.get("set-cookie"), /SameSite=Lax/);
});


test("nonmembers receive no dashboard session", async () => {
  const callback = await login(() => {
    throw new Error("unexpected fetch");
  }, 4242);
  assert.equal(callback.status, 403);
  assert.doesNotMatch(callback.headers.get("set-cookie") ?? "", /__Host-palomar_dashboard=[^.]/);
});


test("GitHub identity provider failures remain temporary service errors", async () => {
  const userFailure = await login(
    () => { throw new Error("unexpected fetch"); },
    TECHNICAL_MAINTAINER_ID,
    { user: new Response("down", { status: 503 }) },
  );
  assert.equal(userFailure.status, 503);
  assert.match(await userFailure.text(), /temporarily unavailable/);
});


test("dashboard OAuth entry and callback are address-throttled before provider I/O", async () => {
  const blocked = { ...ENV, INTAKE_LIMITER: { limit: async () => ({ success: false }) } };
  const saved = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("throttled dashboard OAuth must not reach GitHub");
  };
  try {
    const loginResponse = await worker.fetch(
      new Request("https://submit.example/dashboard/login"),
      blocked,
    );
    assert.equal(loginResponse.status, 429);
    const callbackResponse = await worker.fetch(
      new Request(`https://submit.example/oauth/callback?code=x&state=dashboard_${"a".repeat(43)}`),
      blocked,
    );
    assert.equal(callbackResponse.status, 429);
  } finally {
    globalThis.fetch = saved;
  }
});


test("unauthenticated dashboard navigation redirects with the shared security headers", async () => {
  const response = await worker.fetch(new Request("https://submit.example/dashboard"), ENV);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/dashboard/login");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
});


test("authenticated dashboard reads only the aggregate report", async () => {
  const callback = await login(() => {
    throw new Error("unexpected fetch");
  });
  const cookies = callback.headers.getSetCookie?.() ?? [callback.headers.get("set-cookie")];
  const session = cookies.join(";").match(/__Host-palomar_dashboard=([^;,]+)/)?.[0];
  assert.ok(session);
  const saved = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    assert.match(String(url), /contents\/reports\/dashboard\.json$/);
    return Response.json(inline(REPORT));
  };
  try {
    const response = await worker.fetch(
      new Request("https://submit.example/dashboard", { headers: { cookie: session } }),
      ENV,
    );
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /Palomar operations/);
    assert.match(body, /Take down a version/);
    assert.match(body, /Restore a version/);
    assert.match(body, /issues\/new\?template=takedown\.yml/);
    assert.match(body, /issues\/new\?template=restoration\.yml/);
    assert.doesNotMatch(body, /issues\/123/);
    assert.equal(requests.length, 1);
  } finally {
    globalThis.fetch = saved;
  }
});


test("aggregate contract rejects accidental target identities", () => {
  assert.throws(
    () => validateDashboardReport({ ...REPORT, targets: [] }),
    /at \$: unexpected targets/,
  );
  assert.throws(() => validateDashboardReport({ ...REPORT, submissions: [] }), /invalid aggregate/);
  assert.throws(() => validateDashboardReport({ ...REPORT, owner_login: "maintainer" }), /invalid aggregate/);
  assert.throws(
    () => validateDashboardReport({ ...REPORT, totals: { ...REPORT.totals, submissions: "4" } }),
    /at \$\.totals\.submissions: expected a nonnegative integer/,
  );
  assert.throws(
    () => validateDashboardReport({
      ...REPORT,
      submission_statuses: { ...REPORT.submission_statuses, "owner:maintainer": 1 },
    }),
    /invalid aggregate/,
  );
  const html = dashboardHtml(withDashboardActions(REPORT), "maintainer");
  assert.match(html, /Failed or abandoned attempts/);
  assert.doesNotMatch(html, /<style/);
});


test("aggregate contract identifies missing fields and unsupported versions", () => {
  const definitions = { ...REPORT.definitions };
  delete definitions.technical_test;
  assert.throws(
    () => validateDashboardReport({ ...REPORT, definitions }),
    /at \$\.definitions: missing technical_test/,
  );
  assert.throws(
    () => validateDashboardReport({ ...REPORT, schema_version: 2 }),
    /at \$\.schema_version: unsupported schema version 2/,
  );
});


test("the exact State-produced aggregate fixture satisfies the consumer contract", async () => {
  const text = await readFile(
    new URL("fixtures/state-dashboard.json", import.meta.url),
    "utf8",
  );
  const fixture = JSON.parse(text);
  assert.doesNotThrow(() => validateDashboardReport(fixture));
  assert.equal(Object.hasOwn(fixture, "targets"), false);
  assert.equal(Object.hasOwn(fixture, "submissions"), false);
  assert.equal(fixture.source.state_revision, `submissions-tree:${"3c13456937bf73c97fcf98c9952a96f2a048422d"}`);
});


test("the deployment validator accepts files and diagnoses invalid stdin", async () => {
  const fixture = fileURLToPath(new URL("fixtures/state-dashboard.json", import.meta.url));
  const command = fileURLToPath(new URL("../tools/validate-dashboard-report.js", import.meta.url));
  const accepted = spawnSync(process.execPath, [command, fixture], { encoding: "utf8" });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /dashboard schema 1 is compatible/);

  const definitions = { ...REPORT.definitions };
  delete definitions.technical_test;
  const rejected = spawnSync(process.execPath, [command], {
    encoding: "utf8",
    input: JSON.stringify({ ...REPORT, definitions }),
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /at \$\.definitions: missing technical_test/);
});


test("machine dashboard includes only aggregate data and stable operator links", async () => {
  const callback = await login(() => {
    throw new Error("unexpected fetch");
  });
  const cookies = callback.headers.getSetCookie?.() ?? [callback.headers.get("set-cookie")];
  const session = cookies.join(";").match(/__Host-palomar_dashboard=([^;,]+)/)?.[0];
  const saved = globalThis.fetch;
  globalThis.fetch = async () => Response.json(inline(REPORT));
  try {
    const response = await worker.fetch(
      new Request("https://submit.example/api/dashboard", {
        headers: { cookie: session, "sec-fetch-site": "same-origin" },
      }),
      ENV,
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.operator_actions.status, "direct-moderation-forms");
    assert.equal(
      body.operator_actions.takedown,
      "https://github.com/PalomarRegistry/PalomarDatabase/issues/new?template=takedown.yml",
    );
    assert.equal(
      body.operator_actions.restoration,
      "https://github.com/PalomarRegistry/PalomarDatabase/issues/new?template=restoration.yml",
    );
    assert.match(body.operator_actions.note, /one-Moderator workflow/);
    assert.equal(Object.hasOwn(body, "targets"), false);
    assert.equal(Object.hasOwn(body, "submissions"), false);
  } finally {
    globalThis.fetch = saved;
  }
});


test("machine dashboard requires same-origin and reports malformed aggregates as JSON", async () => {
  const callback = await login(() => {
    throw new Error("unexpected fetch");
  });
  const cookies = callback.headers.getSetCookie?.() ?? [callback.headers.get("set-cookie")];
  const session = cookies.join(";").match(/__Host-palomar_dashboard=([^;,]+)/)?.[0];
  const saved = globalThis.fetch;
  globalThis.fetch = async () => Response.json(inline({ ...REPORT, owner_login: "maintainer" }));
  try {
    const crossSite = await worker.fetch(
      new Request("https://submit.example/api/dashboard", {
        headers: { cookie: session, "sec-fetch-site": "cross-site" },
      }),
      ENV,
    );
    assert.equal(crossSite.status, 403);

    const malformed = await worker.fetch(
      new Request("https://submit.example/api/dashboard", {
        headers: { cookie: session, "sec-fetch-site": "same-origin" },
      }),
      ENV,
    );
    assert.equal(malformed.status, 503);
    assert.deepEqual(await malformed.json(), { error: "operational report needs repair" });
  } finally {
    globalThis.fetch = saved;
  }
});


test("malformed stored dashboard JSON returns the typed unavailable response", async () => {
  const callback = await login(() => {
    throw new Error("unexpected fetch");
  });
  const cookies = callback.headers.getSetCookie?.() ?? [callback.headers.get("set-cookie")];
  const session = cookies.join(";").match(/__Host-palomar_dashboard=([^;,]+)/)?.[0];
  const saved = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ content: btoa("{"), sha: "b".repeat(40) });
  try {
    const response = await worker.fetch(
      new Request("https://submit.example/api/dashboard", {
        headers: { cookie: session, "sec-fetch-site": "same-origin" },
      }),
      ENV,
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "operational report needs repair" });
  } finally {
    globalThis.fetch = saved;
  }
});


test("State provider failures are not diagnosed as malformed reports", async () => {
  const callback = await login(() => {
    throw new Error("unexpected fetch");
  });
  const cookies = callback.headers.getSetCookie?.() ?? [callback.headers.get("set-cookie")];
  const session = cookies.join(";").match(/__Host-palomar_dashboard=([^;,]+)/)?.[0];
  const saved = globalThis.fetch;
  globalThis.fetch = async () => new Response("upstream", { status: 503 });
  try {
    const response = await worker.fetch(
      new Request("https://submit.example/api/dashboard", {
        headers: { cookie: session, "sec-fetch-site": "same-origin" },
      }),
      ENV,
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "operational report is temporarily unavailable",
    });
  } finally {
    globalThis.fetch = saved;
  }
});


test("parallel dashboard OAuth starts use different host-only cookies", async () => {
  const first = await worker.fetch(new Request("https://submit.example/dashboard/login"), ENV);
  const second = await worker.fetch(new Request("https://submit.example/dashboard/login"), ENV);
  const firstName = first.headers.get("set-cookie").split("=", 1)[0];
  const secondName = second.headers.get("set-cookie").split("=", 1)[0];
  assert.match(firstName, /^__Host-palomar_dashboard_oauth_[A-Za-z0-9_-]{16}$/);
  assert.notEqual(firstName, secondName);
});


test("an OAuth binding cannot be replayed as a dashboard session", async () => {
  const begun = await worker.fetch(new Request("https://submit.example/dashboard/login"), ENV);
  const binding = begun.headers.get("set-cookie").split(";", 1)[0].split("=", 2)[1];
  const saved = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("an OAuth binding must fail before State I/O");
  };
  try {
    const response = await worker.fetch(
      new Request("https://submit.example/api/dashboard", {
        headers: {
          cookie: `__Host-palomar_dashboard=${binding}`,
          "sec-fetch-site": "same-origin",
        },
      }),
      ENV,
    );
    assert.equal(response.status, 401);
  } finally {
    globalThis.fetch = saved;
  }
});


test("expired, tampered, and ambiguous dashboard sessions fail before State I/O", async () => {
  const callback = await login(() => {
    throw new Error("unexpected fetch");
  });
  const cookies = callback.headers.getSetCookie?.() ?? [callback.headers.get("set-cookie")];
  const sessionPair = cookies.join(";").match(/__Host-palomar_dashboard=([^;,]+)/)?.[0];
  assert.ok(sessionPair);
  const signedValue = sessionPair.slice(sessionPair.indexOf("=") + 1);
  const savedFetch = globalThis.fetch;
  const savedNow = Date.now;
  globalThis.fetch = async () => {
    throw new Error("invalid sessions must fail before State I/O");
  };
  try {
    const expiredAt = savedNow() + 16 * 60_000;
    Date.now = () => expiredAt;
    const expired = await worker.fetch(
      new Request("https://submit.example/api/dashboard", {
        headers: { cookie: sessionPair, "sec-fetch-site": "same-origin" },
      }),
      ENV,
    );
    assert.equal(expired.status, 401);
    Date.now = savedNow;

    const [signedBody, signature] = signedValue.split(".");
    const replacement = signature.startsWith("A") ? "B" : "A";
    const tamperedValue = `${signedBody}.${replacement}${signature.slice(1)}`;
    const tampered = await worker.fetch(
      new Request("https://submit.example/api/dashboard", {
        headers: {
          cookie: `__Host-palomar_dashboard=${tamperedValue}`,
          "sec-fetch-site": "same-origin",
        },
      }),
      ENV,
    );
    assert.equal(tampered.status, 401);

    const ambiguous = await worker.fetch(
      new Request("https://submit.example/api/dashboard", {
        headers: {
          cookie: `${sessionPair}; __Host-palomar_dashboard=${signedValue}`,
          "sec-fetch-site": "same-origin",
        },
      }),
      ENV,
    );
    assert.equal(ambiguous.status, 401);

    const wrongCase = await worker.fetch(
      new Request("https://submit.example/api/dashboard", {
        headers: {
          cookie: `__host-palomar_dashboard=${signedValue}`,
          "sec-fetch-site": "same-origin",
        },
      }),
      ENV,
    );
    assert.equal(wrongCase.status, 401);
  } finally {
    Date.now = savedNow;
    globalThis.fetch = savedFetch;
  }
});


test("dashboard stylesheet reuses the reviewed site palette", async () => {
  const css = await readFile(new URL("../public/dashboard.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}/i);
  assert.match(css, /var\(--line\)/);
  assert.match(css, /var\(--dim\)/);
});
