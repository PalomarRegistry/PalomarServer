import { exports } from "cloudflare:workers";
import { expect, test } from "vitest";

test("the real redirect Worker preserves a deep encoded URL and security headers", async () => {
  const response = await exports.default.fetch(
    new Request("http://www.palomarregistry.org/a%20path?value=one%20two", {
      redirect: "manual",
    }),
  );

  expect(response.status).toBe(308);
  expect(response.headers.get("location")).toBe(
    "https://palomar-registry.org/a%20path?value=one%20two",
  );
  expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await response.text()).toBe("");
});
