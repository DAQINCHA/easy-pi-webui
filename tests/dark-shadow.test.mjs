import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "public/styles.css"),
  "utf8",
);

function themeBlock(name) {
  const start = CSS.indexOf(`html[data-theme="${name}"]`);
  assert.notEqual(start, -1, "missing theme " + name);
  const next = name === "dark"
    ? CSS.indexOf('html[data-theme="light"]', start + 1)
    : CSS.indexOf("\n* {", start + 1);
  assert.ok(next > start, "could not bound theme " + name);
  return CSS.slice(start, next);
}

function decls(block, prop) {
  const re = new RegExp(`--${prop}\\s*:\\s*([^;]+);`, "g");
  const out = [];
  let m;
  while ((m = re.exec(block))) out.push(m[1].trim());
  return out;
}

function hex(value) {
  const m = /^#([0-9a-f]{6})$/i.exec(value);
  assert.ok(m, "expected #rrggbb, got " + value);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const SHADOW_PROPS = [
  "shadow-pop",
  "shadow-composer",
  "shadow-soft",
  "shadow-accent",
  "shadow-accent-strong",
  "shadow-raised",
  "shadow-card",
  "shadow-modal",
  "shadow-drawer",
];

describe("dark theme hard shadows stay quiet gray", () => {
  it("uses a deep-gray hard offset in dark, not white", () => {
    const dark = themeBlock("dark");
    const color = decls(dark, "shadow-color");
    assert.equal(color.length, 1);
    const [r, g, b] = hex(color[0]);
    assert.ok(r <= 0x40 && g <= 0x40 && b <= 0x40, "shadow-color should be deep gray, got " + color[0]);
    assert.ok(r >= 0x22 && g >= 0x22 && b >= 0x22, "shadow-color should stay visible against black, got " + color[0]);

    for (const prop of SHADOW_PROPS) {
      const values = decls(dark, prop);
      assert.equal(values.length, 1, prop);
      const value = values[0];
      assert.match(value, /var\(--shadow-color\)/);
      assert.doesNotMatch(value, /#fff(?:fff)?\b/i);
      assert.doesNotMatch(value, /var\(--ink\)/);
      // hard offset, no blur: Npx Npx 0  or  Npx 0 0 (drawer)
      assert.match(value, /^\d+px(?:\s+\d+px|\s+0)\s+0\s+var\(--shadow-color\)$/);
    }
  });

  it("leaves light-theme shadows as #111 hard offsets", () => {
    const light = themeBlock("light");
    const color = decls(light, "shadow-color");
    assert.equal(color.length, 1);
    assert.equal(color[0].toLowerCase(), "#111111");
    for (const prop of SHADOW_PROPS) {
      const values = decls(light, prop);
      assert.equal(values.length, 1, prop);
      const value = values[0];
      assert.ok(
        /#111111/i.test(value) || /var\(--shadow-color\)/.test(value),
        prop + " should stay #111 in light, got " + value,
      );
      assert.doesNotMatch(value, /#fff(?:fff)?\b/i);
      assert.match(value, /\d+px(?:\s+\d+px)?\s+0\s+/);
    }
  });

  it("does not leave hardcoded ink or white box-shadows, and keeps dark borders visible", () => {
    for (const line of CSS.split("\n")) {
      for (const m of line.matchAll(/(?:box-shadow|drop-shadow)\s*:[^;]+/g)) {
        assert.doesNotMatch(m[0], /var\(--ink\)/);
        assert.doesNotMatch(m[0], /#fff(?:fff)?\b/i);
      }
    }
    const dark = themeBlock("dark");
    assert.match(dark, /--border:\s*#ffffff/);
    assert.match(dark, /--border-strong:\s*#ffffff/);
    assert.match(dark, /--border-soft:\s*#ffffff/);
    assert.match(dark, /--focus-ring:\s*#ffe600/);
    assert.match(dark, /--ink:\s*#ffffff/);
  });
});
