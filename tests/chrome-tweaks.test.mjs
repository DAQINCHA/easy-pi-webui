import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CSS = readFileSync(join(ROOT, "public/styles.css"), "utf8");

function rules(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("(?:^|,)\\s*" + escaped + "\\s*(?:,[^{]*)?\\{[^}]*\\}", "gm");
  const blocks = CSS.match(re) || [];
  assert.ok(blocks.length, "missing selector " + selector);
  return blocks;
}

function baseRule(selector) {
  // Prefer the first (non-media override) block for base layout tokens.
  return rules(selector)[0];
}

describe("composer gap, workspace picker edge, and app top rule", () => {
  it("does not keep a solid covering slab above the composer, and stays in normal flow", () => {
    const shell = baseRule(".composer-shell");
    assert.match(shell, /position:\s*relative/);
    assert.doesNotMatch(shell, /position:\s*(absolute|fixed|sticky)/);
    assert.match(shell, /background:\s*transparent/);
    assert.match(shell, /padding:\s*0 24px calc\(14px \+ env\(safe-area-inset-bottom\)\)/);
    assert.doesNotMatch(shell, /background:\s*var\(--bg-chat\)/);
    assert.ok(
      rules(".composer-shell").some((block) =>
        /padding:\s*0 12px calc\(10px \+ env\(safe-area-inset-bottom\)\)/.test(block),
      ),
      "narrow-screen shell should also drop the top pad but keep the bottom safe area",
    );
  });

  it("gives only the workspace-menu open button a hard D edge, with readable hover and focus", () => {
    const btn = rules(".workspace-menu .picker-btn")[0];
    assert.match(btn, /border:\s*var\(--border-width\) solid var\(--ink\)/);
    assert.match(btn, /background:\s*var\(--paper\)/);
    assert.match(btn, /color:\s*var\(--text-1\)/);
    assert.doesNotMatch(btn, /box-shadow\s*:/);
    assert.doesNotMatch(btn, /background:\s*var\(--accent\)/);
    const hover = rules(".workspace-menu .picker-btn:hover").at(-1);
    assert.match(hover, /:focus-visible/);
    assert.match(hover, /background:\s*var\(--accent\)/);
    assert.match(hover, /color:\s*var\(--accent-fg\)/);
    assert.match(hover, /border-color:\s*var\(--ink\)/);
    assert.doesNotMatch(hover, /box-shadow\s*:/);
    assert.doesNotMatch(hover, /outline\s*:/);
    assert.doesNotMatch(CSS, /\.workspace-menu \.picker-btn:active/);
    const disabled = rules(".workspace-menu .picker-btn:disabled")[0];
    assert.match(disabled, /background:\s*var\(--accent\)/);
    assert.match(disabled, /color:\s*var\(--accent-fg\)/);
    assert.match(disabled, /border-color:\s*var\(--ink\)/);
    assert.match(disabled, /opacity:\s*1/);
    assert.match(disabled, /filter:\s*none/);
    assert.match(disabled, /pointer-events:\s*none/);
    const generic = baseRule(".picker-btn");
    assert.doesNotMatch(generic, /border:\s*var\(--border-width\) solid var\(--ink\)/);
    assert.match(baseRule(".picker-btn:disabled"), /background:\s*var\(--bg-elev-3\)/);
    assert.match(baseRule(".picker-btn:hover"), /background:\s*var\(--accent-hover\)/);
  });

  it("draws a full-width top rule on the app shell, not only the main topbar", () => {
    const app = baseRule(".app");
    assert.match(app, /border-top:\s*var\(--border-width\) solid var\(--ink\)/);
    assert.match(app, /height:\s*100dvh/);
    const topbar = baseRule(".topbar");
    assert.doesNotMatch(topbar, /border-top:\s*2px/);
    assert.match(topbar, /border-bottom:\s*var\(--border-width\) solid var\(--ink\)/);
    const mobile = CSS.slice(CSS.indexOf("@media (max-width: 900px)"));
    assert.match(mobile, /\.sidebar\s*\{[^}]*border-top:\s*var\(--border-width\) solid var\(--ink\)/);
  });
});
