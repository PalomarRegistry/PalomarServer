import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";
import { dashboardHtml, validateDashboardReport } from "../src/dashboard.js";


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


const REPORT = {
  schema_version: 1,
  source: {
    state_revision: "a".repeat(40),
    latest_event_at: "2026-08-10T00:00:00Z",
    pricing_schedule: "test",
  },
  totals: {
    submissions: 4,
    submissions_landed: 1,
    submissions_active: 1,
    targets: 2,
    targets_landed: 1,
    review_rounds_completed: 3,
    review_rounds_unpriced: 0,
  },
  model_spend: {
    per_round: { count: 3, lower: { mean: 1 }, upper: { mean: 2 }, total_lower_usd: 3, total_upper_usd: 6, histogram: [{ label: "$1–$2", definite_count: 2, possible_count: 3 }] },
    per_submission_with_review: { count: 2, lower: { mean: 1.5 }, upper: { mean: 3 }, total_lower_usd: 3, total_upper_usd: 6, histogram: [] },
    per_target_with_review: { count: 1, lower: { mean: 3 }, upper: { mean: 6 }, total_lower_usd: 3, total_upper_usd: 6, histogram: [] },
  },
  distributions: {
    review_rounds_completed_per_submission: [{ value: 0, count: 2 }, { value: 1, count: 2 }],
    submission_attempts_to_first_land_per_landed_target: [{ value: 2, count: 1 }],
    failed_or_abandoned_attempts_before_first_land_per_landed_target: [{ value: 1, count: 1 }],
    review_rounds_to_first_land_per_landed_target: [{ value: 2, count: 1 }],
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
    assert.match(await response.text(), /Palomar operations/);
    assert.equal(requests.length, 1);
  } finally {
    globalThis.fetch = saved;
  }
});


test("aggregate contract rejects accidental target identities", () => {
  assert.throws(() => validateDashboardReport({ ...REPORT, targets: [] }), /invalid aggregate/);
  assert.throws(() => validateDashboardReport({ ...REPORT, submissions: [] }), /invalid aggregate/);
  const html = dashboardHtml(REPORT, "maintainer");
  assert.match(html, /Failed or abandoned attempts/);
  assert.doesNotMatch(html, /<style/);
});
