import assert from "node:assert/strict";
import test from "node:test";
import worker from "../redirect/index.js";

for (const host of ["palomarregistry.org", "www.palomarregistry.org"]) {
  test(`${host} redirects a deep link to the canonical domain`, async () => {
    const response = worker.fetch(
      new Request(`https://${host}/entry.html?id=PALOMAR-2026-08-06-000123&version=2`),
    );

    assert.equal(response.status, 308);
    assert.equal(
      response.headers.get("location"),
      "https://palomar-registry.org/entry.html?id=PALOMAR-2026-08-06-000123&version=2",
    );
    assert.equal(await response.text(), "");
  });
}

test("the redirect preserves the request method and encoded URL", () => {
  const response = worker.fetch(
    new Request("https://palomarregistry.org/a%20path/?q=a%2Fb", { method: "POST" }),
  );

  assert.equal(response.status, 308);
  assert.equal(
    response.headers.get("location"),
    "https://palomar-registry.org/a%20path/?q=a%2Fb",
  );
});
