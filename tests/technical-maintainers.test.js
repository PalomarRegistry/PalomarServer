import assert from "node:assert/strict";
import test from "node:test";

import { isTechnicalMaintainer } from "../src/technical-maintainers.js";


test("numeric GitHub ids, not mutable logins, carry maintainer authority", () => {
  assert.equal(isTechnicalMaintainer({ id: 477956, login: "renamed-account" }), true);
  assert.equal(isTechnicalMaintainer({ id: 1, login: "kim-em" }), false);
  assert.equal(isTechnicalMaintainer({ id: "477956", login: "kim-em" }), false);
});
