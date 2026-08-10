import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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


function spendBlock(count, lower, upper) {
  const stats = (value) => ({ count, min: value, mean: value, median: value, max: value });
  return {
    count,
    ambiguous_count: lower === upper ? 0 : count,
    lower: stats(lower),
    upper: stats(upper),
    total_lower_usd: count * lower,
    total_upper_usd: count * upper,
    histogram: [{
      label: "$1–$10",
      lower_usd: 1,
      upper_usd: 10,
      definite_count: count,
      possible_count: count,
    }],
  };
}


const REPORT = {
  schema_version: 1,
  source: {
    state_revision: "a".repeat(40),
    latest_event_at: "2026-08-10T00:00:00Z",
    pricing_schedule: "test",
  },
  definitions: {
    submission: "one record",
    round: "one spend item",
    target: "repository and comparator path",
    landed: "registered",
  },
  totals: {
    submissions: 4,
    submissions_landed: 1,
    submissions_not_landed: 3,
    submissions_active: 1,
    submissions_terminal_unlanded: 2,
    targets: 2,
    targets_landed: 1,
    targets_not_landed: 1,
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
    state_revision: "a".repeat(40),
    pricing_schedule: "test",
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


async function login(fetchImpl, membership = "active") {
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const text = String(url);
    if (text === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "ephemeral-user-token" });
    }
    if (text === "https://api.github.com/user") {
      return Response.json({ login: "maintainer" });
    }
    if (text.includes("/teams/technical-maintainers/memberships/maintainer")) {
      return Response.json({ state: membership, role: "member" });
    }
    return fetchImpl(url, init);
  };
  try {
    const begun = await worker.fetch(new Request("https://submit.example/dashboard/login"), ENV);
    assert.equal(begun.status, 303);
    const authorize = new URL(begun.headers.get("location"));
    assert.equal(authorize.searchParams.get("scope"), "read:user read:org");
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


test("dashboard login authorizes the exact active Technical Maintainers team", async () => {
  const callback = await login(() => {
    throw new Error("unexpected fetch");
  });
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get("location"), "/dashboard");
  assert.match(callback.headers.get("set-cookie"), /__Host-palomar_dashboard=/);
  assert.match(callback.headers.get("set-cookie"), /SameSite=Lax/);
});


test("nonmembers receive no dashboard session", async () => {
  const callback = await login(() => {
    throw new Error("unexpected fetch");
  }, "pending");
  assert.equal(callback.status, 403);
  assert.doesNotMatch(callback.headers.get("set-cookie") ?? "", /__Host-palomar_dashboard=[^.]/);
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
    assert.match(body, /issues\/123/);
    assert.equal(requests.length, 1);
  } finally {
    globalThis.fetch = saved;
  }
});


test("aggregate contract rejects accidental target identities", () => {
  assert.throws(() => validateDashboardReport({ ...REPORT, targets: [] }), /invalid aggregate/);
  assert.throws(() => validateDashboardReport({ ...REPORT, submissions: [] }), /invalid aggregate/);
  assert.throws(() => validateDashboardReport({ ...REPORT, owner_login: "maintainer" }), /invalid aggregate/);
  assert.throws(
    () => validateDashboardReport({ ...REPORT, totals: { ...REPORT.totals, submissions: "4" } }),
    /invalid aggregate/,
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
      new Request("https://submit.example/api/dashboard", { headers: { cookie: session } }),
      ENV,
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.operator_actions.status, "issue-chooser-fallback");
    assert.equal(
      body.operator_actions.take_down_version,
      "https://github.com/PalomarRegistry/PalomarDatabase/issues/new/choose",
    );
    assert.equal(body.operator_actions.restore_version, body.operator_actions.take_down_version);
    assert.equal(
      body.operator_actions.workflow_status,
      "https://github.com/PalomarRegistry/PalomarDatabase/issues/123",
    );
    assert.match(body.operator_actions.note, /issue-form chooser/);
    assert.equal(Object.hasOwn(body, "targets"), false);
    assert.equal(Object.hasOwn(body, "submissions"), false);
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
        headers: { cookie: `__Host-palomar_dashboard=${binding}` },
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
      new Request("https://submit.example/api/dashboard", { headers: { cookie: sessionPair } }),
      ENV,
    );
    assert.equal(expired.status, 401);
    Date.now = savedNow;

    const replacement = signedValue.endsWith("A") ? "B" : "A";
    const tampered = await worker.fetch(
      new Request("https://submit.example/api/dashboard", {
        headers: { cookie: `__Host-palomar_dashboard=${signedValue.slice(0, -1)}${replacement}` },
      }),
      ENV,
    );
    assert.equal(tampered.status, 401);

    const ambiguous = await worker.fetch(
      new Request("https://submit.example/api/dashboard", {
        headers: { cookie: `${sessionPair}; __Host-palomar_dashboard=${signedValue}` },
      }),
      ENV,
    );
    assert.equal(ambiguous.status, 401);

    const wrongCase = await worker.fetch(
      new Request("https://submit.example/api/dashboard", {
        headers: { cookie: `__host-palomar_dashboard=${signedValue}` },
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
