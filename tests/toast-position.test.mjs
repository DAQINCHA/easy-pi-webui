import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CSS = readFileSync(join(ROOT, "public/styles.css"), "utf8");
const JS = readFileSync(join(ROOT, "public/js/app.js"), "utf8");
const HTML = readFileSync(join(ROOT, "public/index.html"), "utf8");

function functionSource(name) {
  const start = JS.indexOf("function " + name + "(");
  assert.notEqual(start, -1, "missing function " + name);
  const brace = JS.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < JS.length; i += 1) {
    if (JS[i] === "{") depth += 1;
    else if (JS[i] === "}") {
      depth -= 1;
      if (depth === 0) return JS.slice(start, i + 1);
    }
  }
  assert.fail("unclosed function " + name);
}

function cssBlock(selector) {
  const re = new RegExp("(?:^|\\n)" + selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}");
  const match = CSS.match(re);
  assert.ok(match, "missing selector " + selector);
  return match[1];
}

describe("toast position stays over the chat composer", () => {
  it("anchors the stack 16px above the composer, centered in the chat column", () => {
    const shell = HTML.match(/<div class="composer-shell">[\s\S]*?<div class="composer-hint">/);
    assert.ok(shell, "missing composer-shell");
    assert.match(
      shell[0],
      /<div class="composer-stack">\s*<div class="toasts" id="toasts"><\/div>\s*<div class="composer" id="composer">/,
    );
    assert.equal((HTML.match(/id="toasts"/g) || []).length, 1);
    assert.doesNotMatch(HTML.slice(HTML.indexOf("</main>")), /id="toasts"/);

    const stack = cssBlock(".composer-stack");
    assert.match(stack, /position:\s*relative/);
    assert.match(stack, /max-width:\s*var\(--thread-max\)/);
    assert.match(stack, /margin:\s*0 auto/);

    const toasts = cssBlock(".toasts");
    assert.match(toasts, /position:\s*absolute/);
    assert.match(toasts, /left:\s*0/);
    assert.match(toasts, /right:\s*0/);
    assert.match(toasts, /bottom:\s*calc\(100% \+ 16px\)/);
    assert.match(toasts, /align-items:\s*center/);
    assert.match(toasts, /flex-direction:\s*column/);
    assert.match(toasts, /gap:\s*8px/);
    assert.doesNotMatch(toasts, /position:\s*fixed/);
    assert.doesNotMatch(toasts, /left:\s*50%/);
    assert.doesNotMatch(toasts, /104px/);
    assert.doesNotMatch(toasts, /transform:\s*translateX\(-50%\)/);
  });

  it("keeps the existing stack, timing, and append lifecycle, without deduping", () => {
    const src = functionSource("toast");
    assert.match(src, /el\.toasts\.appendChild\(node\)/);
    assert.match(src, /kind === "error" \? 5200 : 2800/);
    assert.match(src, /node\.style\.opacity = "0"/);
    assert.match(src, /setTimeout\(\(\) => node\.remove\(\), 220\)/);
    assert.doesNotMatch(src, /querySelector|replaceWith|dedup|throttle|maxToasts|slice\(/);
    assert.doesNotMatch(JS, /ResizeObserver/);
    assert.doesNotMatch(src, /requestAnimationFrame/);
  });
});

describe("workspace-menu pick stays busy without losing the yellow tile", () => {
  it("still disables the open-workspace button and restores it after pick", () => {
    const src = functionSource("pickWorkspace");
    assert.match(src, /if \(state\.switching\) return/);
    assert.match(src, /button\.disabled = true/);
    assert.match(src, /正在打开…/);
    assert.match(src, /button\.disabled = false/);
    assert.match(src, /button\.innerHTML = label/);
    assert.match(src, /data\.cancelled/);
    assert.match(src, /switchToWorkspace/);
  });
});
