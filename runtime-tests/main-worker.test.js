import { exports } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

async function hexDigest(value) {
  return Array.from(new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  ), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

test("the real Worker serves its network-free health contract", async () => {
  const outbound = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("health check attempted outbound traffic");
  });
  const response = await exports.default.fetch(
    new Request("https://submit.palomar-registry.org/healthz"),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("vary")).toBe("authorization");
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(outbound).not.toHaveBeenCalled();
});

test("the real Worker reaches GitHub only through the mocked runtime boundary", async () => {
  const requests = [];
  const outbound = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (requests.length === 1) {
      // Includes a multibyte marker so workerd exercises the production
      // atob/TextDecoder/JSON path, not only GitHub's 404 shortcut.
      return Response.json({
        content: "eyJpZCI6ImExYjJjM2Q0ZTVmNiIsIm1hcmtlciI6Is+AIn0K",
        sha: "b".repeat(40),
      });
    }
    return new Response(null, { status: 404 });
  });

  const response = await exports.default.fetch(new Request(
    "https://submit.palomar-registry.org/api/submission",
    { headers: { authorization: `Bearer ${"a".repeat(64)}` } },
  ));

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "not found" });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("vary")).toBe("authorization");
  expect(outbound).toHaveBeenCalledTimes(2);

  const [pointer, state] = requests;
  expect(pointer.method).toBe("GET");
  // SHA-256 of the configured pepper, a colon, and the presented token. A
  // merely well-shaped digest would not prove that the pepper participated.
  expect(new URL(pointer.url).pathname).toBe(
    "/repos/PalomarRegistry/PalomarSubmissionState/contents/index/tokens/" +
      "4aa5461fb9bff995301aa447a051e407a007708d9245b0c5b443d8d50bd1d288.json",
  );
  expect(new URL(state.url).pathname).toBe(
    "/repos/PalomarRegistry/PalomarSubmissionState/contents/" +
      "submissions/a1b2c3d4e5f6/state.json",
  );
  for (const request of requests) {
    expect(request.method).toBe("GET");
    expect(new URL(request.url).origin).toBe("https://api.github.com");
    expect(request.headers.get("authorization")).toBe("Bearer runtime-test-state-token");
    expect(request.headers.get("accept")).toBe("application/vnd.github+json");
    expect(request.headers.get("user-agent")).toBe("palomar-server");
    expect(request.headers.get("x-github-api-version")).toBe("2022-11-28");
  }
});

test("the real session exchange issues only the host-prefixed credential", async () => {
  const outbound = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const value = outbound.mock.calls.length === 1
      ? { id: "a1b2c3d4e5f6" }
      : { id: "a1b2c3d4e5f6", status: "verifying" };
    return Response.json({
      content: btoa(`${JSON.stringify(value)}\n`),
      sha: "b".repeat(40),
    });
  });
  const token = "a".repeat(64);

  const response = await exports.default.fetch(new Request(
    "https://submit.palomar-registry.org/session",
    {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
      body: new URLSearchParams({ token }),
    },
  ));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(response.headers.get("set-cookie")).toBe(
    `__Host-palomar_session=${token}; Path=/; Max-Age=43200; HttpOnly; Secure; ` +
      "SameSite=Strict",
  );
  expect(outbound).toHaveBeenCalledTimes(2);
});

test("the real Worker rejects legacy and duplicate session cookies before I/O", async () => {
  const outbound = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("an ambiguous session reached durable state");
  });
  const token = "a".repeat(64);

  for (const cookie of [
    `palomar_session=${token}`,
    `__Host-palomar_session=${token}; __Host-palomar_session=${token}`,
  ]) {
    const response = await exports.default.fetch(new Request(
      "https://submit.palomar-registry.org/api/submission",
      { headers: { cookie, "sec-fetch-site": "same-origin" } },
    ));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  }
  expect(outbound).not.toHaveBeenCalled();
});

test("the real Worker signs and accepts one host-only dashboard session", async () => {
  const outbound = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "runtime-user-token" });
    }
    if (url === "https://api.github.com/user") {
      return Response.json({ login: "maintainer", id: 477956 });
    }
    throw new Error(`unexpected dashboard request ${url}`);
  });

  const begun = await exports.default.fetch(
    new Request("https://submit.palomar-registry.org/dashboard/login", {
      redirect: "manual",
    }),
  );
  expect(begun.status, await begun.clone().text()).toBe(303);
  const authorize = new URL(begun.headers.get("location"));
  expect(authorize.searchParams.has("scope")).toBe(false);
  const oauthCookie = begun.headers.get("set-cookie").split(";", 1)[0];
  const callback = await exports.default.fetch(new Request(
    `https://submit.palomar-registry.org/oauth/callback?code=one&state=${authorize.searchParams.get("state")}`,
    { headers: { cookie: oauthCookie }, redirect: "manual" },
  ));

  expect(callback.status).toBe(303);
  expect(callback.headers.get("location")).toBe("/dashboard");
  const cookies = callback.headers.getSetCookie();
  expect(cookies).toHaveLength(2);
  expect(cookies[0]).toContain("Max-Age=0");
  expect(cookies[1]).toMatch(/^__Host-palomar_dashboard=/);
  expect(cookies[1]).toContain("HttpOnly; Secure; SameSite=Lax");
  expect(outbound).toHaveBeenCalledTimes(2);
});

test("the real callback refuses a planted legacy intake cookie", async () => {
  const nonce = "6".repeat(64);
  const binding = "9".repeat(64);
  const nonceDigest = await hexDigest(nonce);
  const outbound = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.method === "GET") {
      // Inside its quarter of an hour, so the callback reaches the cookie
      // check rather than refusing the intake as lapsed.
      const value = {
        binding_sha256: await hexDigest(binding),
        created_at: new Date().toISOString(),
      };
      return Response.json({
        content: btoa(`${JSON.stringify(value)}\n`),
        sha: "b".repeat(40),
      });
    }
    if (request.method === "DELETE") return Response.json({ ok: true });
    throw new Error(`legacy intake reached ${request.method} ${request.url}`);
  });

  const response = await exports.default.fetch(new Request(
    `https://submit.palomar-registry.org/oauth/callback?code=c&state=${nonce}`,
    { headers: { cookie: `palomar_intake_${nonceDigest.slice(0, 16)}=${binding}` } },
  ));

  expect(response.status).toBe(400);
  expect(await response.text()).toContain("That sign-in did not begin here");
  expect(response.headers.get("set-cookie")).toBe(
    `__Host-palomar_intake_${nonceDigest.slice(0, 16)}=; ` +
      "Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
  );
  expect(outbound.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET", "DELETE"]);
});

test("the real callback rejects duplicate intake credentials before I/O", async () => {
  const outbound = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("an ambiguous intake reached a provider");
  });
  const nonce = "5".repeat(64);
  const nonceDigest = await hexDigest(nonce);
  const name = `__Host-palomar_intake_${nonceDigest.slice(0, 16)}`;

  const response = await exports.default.fetch(new Request(
    `https://submit.palomar-registry.org/oauth/callback?code=c&state=${nonce}`,
    { headers: { cookie: `${name}=${"8".repeat(64)}; ${name}=${"9".repeat(64)}` } },
  ));

  expect(response.status).toBe(400);
  expect(await response.text()).toContain("That sign-in did not begin here");
  expect(response.headers.get("set-cookie")).toBe(
    `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  );
  expect(outbound).not.toHaveBeenCalled();
});

test("the real scheduled handler runs both lifecycle maintenance reads", async () => {
  const requests = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (new URL(request.url).pathname.endsWith("/contents/index/inflight.json")) {
      return Response.json({
        content: btoa(`${JSON.stringify({ open: [] })}\n`),
        sha: "b".repeat(40),
      });
    }
    return new Response(null, { status: 404 });
  });

  await exports.default.scheduled({});

  expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
    "/repos/PalomarRegistry/PalomarSubmissionState/contents/index/inflight.json",
    "/repos/PalomarRegistry/PalomarSubmissionState/contents/pending",
  ]);
  for (const request of requests) {
    expect(request.method).toBe("GET");
    expect(request.headers.get("authorization")).toBe("Bearer runtime-test-state-token");
  }
});
