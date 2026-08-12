/**
 * The palette, checked rather than eyeballed.
 *
 * The stylesheet is the source of truth: these read the custom properties out
 * of it, so a colour cannot be changed without this noticing. Two of the
 * original colours failed — form-control borders at 1.36:1, and white text on
 * the dark-mode button at 2.20:1 — and neither is visible to someone who is
 * only looking.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

function luminance(hex) {
  const channels = hex.replace("#", "").match(/../g).map((pair) => {
    const value = parseInt(pair, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

/** The custom properties of one `:root` block, in source order. */
function palette(css, index) {
  const blocks = [...css.matchAll(/:root\s*\{([^}]*)\}/g)];
  const values = {};
  for (const [, name, value] of blocks[index][1].matchAll(/(--[a-z-]+):\s*(#[0-9a-f]{6})/gi)) {
    values[name] = value;
  }
  return values;
}

const css = await readFile(new URL("../public/style.css", import.meta.url), "utf8");
const light = palette(css, 0);
const dark = { ...light, ...palette(css, 1) };

for (const [mode, colours] of [["light", light], ["dark", dark]]) {
  test(`${mode} text meets WCAG AA`, () => {
    for (const token of ["--ink", "--dim", "--accent", "--caution", "--attention"]) {
      const ratio = contrast(colours[token], colours["--page"]);
      assert.ok(ratio >= 4.5, `${mode} ${token} is ${ratio.toFixed(2)}:1 on the page, needs 4.5`);
    }
  });

  test(`${mode} form controls meet WCAG AA for non-text contrast`, () => {
    for (const token of ["--field", "--attention"]) {
      const ratio = contrast(colours[token], colours["--page"]);
      assert.ok(ratio >= 3, `${mode} ${token} is ${ratio.toFixed(2)}:1, needs 3`);
    }
  });

  test(`${mode} button text meets WCAG AA against the button`, () => {
    const ratio = contrast(colours["--accent-ink"], colours["--accent"]);
    assert.ok(ratio >= 4.5, `${mode} button text is ${ratio.toFixed(2)}:1, needs 4.5`);
  });
}

test("no colour is hard-coded past the palette", () => {
  const body = css.slice(css.lastIndexOf(":root", css.indexOf("* { box-sizing")) );
  const rules = body.slice(body.indexOf("* { box-sizing"));
  const literals = [...rules.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((match) => match[0]);
  assert.deepEqual(literals, [], `colours outside the palette cannot be contrast-checked: ${literals}`);
});
