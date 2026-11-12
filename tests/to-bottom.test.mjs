import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CSS = readFileSync(join(ROOT, "public/styles.css"), "utf8");
const JS = readFileSync(join(ROOT, "public/js/app.js"), "utf8");
const HTML = readFileSync(join(ROOT, "public/index.html"), "utf8");

function cssBlock(selector) {
  const re = new RegExp("(?:^|\\n)" + selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}");
  const match = CSS.match(re);
  assert.ok(match, "missing selector " + selector);
  return match[1];
}

describe("scroll-to-bottom button stays centered on first painted frame", () => {
  it("centers with auto margins, so the shared rise animation cannot drop translateX(-50%)", () => {
    const btn = cssBlock(".to-bottom");
    assert.match(btn, /position:\s*absolute/);
    assert.match(btn, /left:\s*0/);
    assert.match(btn, /right:\s*0/);
    assert.match(btn, /margin-left:\s*auto/);
    assert.match(btn, /margin-right:\s*auto/);
    assert.match(btn, /width:\s*32px/);
    assert.match(btn, /height:\s*32px/);
    assert.match(btn, /animation:\s*rise .2s var\(--ease\)/);
    assert.doesNotMatch(btn, /left:\s*50%;/);
    assert.doesNotMatch(btn, /transform:\s*translateX\(-50%\)/);
    assert.doesNotMatch(btn, /transition\s*:/);

    assert.match(
      CSS,
      /@keyframes rise\s*\{\s*from\s*\{\s*opacity:\s*0;\s*transform:\s*translateY\(6px\);\s*\}\s*to\s*\{\s*opacity:\s*1;\s*transform:\s*none;/,
    );
    assert.match(CSS, /\.empty\s*\{[^}]*animation:\s*rise/);
    assert.match(CSS, /\.msg\s*\{[^}]*animation:\s*rise/);
  });

  it("still toggles visibility from scroll position and scrolls on click, without new motion hooks", () => {
    assert.match(HTML, /<button class="to-bottom" id="toBottom" hidden>/);
    assert.match(JS, /el\.toBottom\.hidden = scrollNearBottom\(\)/);
    assert.match(JS, /el\.toBottom\.addEventListener\("click", \(\) => scrollBottom\(true\)\)/);
    assert.doesNotMatch(JS, /toBottom\.(style|classList|animate)/);
  });
});
