import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = readFileSync(join(ROOT, "public/index.html"), "utf8");
const CSS = readFileSync(join(ROOT, "public/styles.css"), "utf8");

function ruleBlocks(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("[^{}]*" + escaped + "[^{}]*\\{[^}]*\\}", "g");
  return CSS.match(re) || [];
}

function lastMatchingBlock(selector) {
  const blocks = ruleBlocks(selector);
  assert.ok(blocks.length, "missing selector " + selector);
  return blocks[blocks.length - 1];
}

describe("sidebar brand mark stays black on the yellow tile", () => {
  it("puts the yellow tile on a wrapper, not on the filtered img", () => {
    const brand = HTML.match(/<a class="brand"[^>]*>[\s\S]*?<\/a>/);
    assert.ok(brand, "missing .brand link");
    const markup = brand[0];
    assert.match(markup, /<span class="brand-mark">\s*<img\b[^>]*src="icons\/mark\.svg"/);
    assert.doesNotMatch(markup, /<img[^>]*class="[^"]*brand-mark/);
  });

  it("does not filter the tile itself, and blackens only the child svg image", () => {
    const tile = lastMatchingBlock(".brand-mark");
    // The tile rule may be `.brand-mark { ... }` — ensure this block is the container, not the img rule
    const tileOnly = [...CSS.matchAll(/\.brand-mark\s*\{[^}]*\}/g)].map((m) => m[0]);
    assert.ok(tileOnly.length, "missing .brand-mark container rule");
    const lastTile = tileOnly[tileOnly.length - 1];
    assert.match(lastTile, /background:\s*var\(--brand-tile\)/);
    assert.doesNotMatch(lastTile, /filter:\s*brightness\(0\)/);
    assert.match(lastTile, /filter:\s*none/);

    const img = lastMatchingBlock(".brand-mark img");
    assert.match(img, /filter:\s*brightness\(0\)/);
    assert.match(img, /\.brand\s+\.brand-mark\s+img/);
  });

  it("has no later rule that undoes the child-image blackening", () => {
    const imgBlocks = [...CSS.matchAll(/[^{}]*\.brand-mark\s+img[^{}]*\{[^}]*\}/g)];
    assert.ok(imgBlocks.length, "missing .brand-mark img rule");
    const last = imgBlocks[imgBlocks.length - 1][0];
    assert.match(last, /filter:\s*brightness\(0\)/);
    assert.doesNotMatch(last, /filter:\s*none/);
    assert.doesNotMatch(last, /filter:\s*invert\(/);
  });
});
