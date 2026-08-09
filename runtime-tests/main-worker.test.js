import { exports } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

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
