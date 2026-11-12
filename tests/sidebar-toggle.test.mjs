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
  return match ? match[1] : "";
}

function durationMs(value) {
  const ms = String(value).match(/(\d+(?:\.\d+)?)ms/);
  if (ms) return Number(ms[1]);
  const sec = String(value).match(/(\d+(?:\.\d+)?)s/);
  return sec ? Number(sec[1]) * 1000 : NaN;
}

describe("sidebar open and close motion", () => {
  it("animates the desktop grid track on toggle, without display:none or content crush", () => {
    assert.match(CSS, /--sidebar-toggle-ms:\s*200ms/);
    const tokenMs = durationMs((CSS.match(/--sidebar-toggle-ms:\s*([^;]+)/) || [])[1]);
    assert.ok(tokenMs >= 180 && tokenMs <= 220, "duration should stay in the 180-220ms range, got " + tokenMs);

    const hiddenApp = cssBlock(".app.sidebar-hidden");
    assert.match(hiddenApp, /grid-template-columns:\s*0px minmax\(0,\s*1fr\)/);
    const restApp = cssBlock(".app");
    assert.match(restApp, /grid-template-columns:\s*var\(--sidebar-w\) minmax\(0,\s*1fr\)/);
    assert.doesNotMatch(restApp, /transition\s*:/);

    const animApp = cssBlock(".app.sidebar-animating");
    assert.match(animApp, /transition:\s*grid-template-columns var\(--sidebar-toggle-ms\) var\(--ease\)/);
    assert.doesNotMatch(animApp, /--ease-spring/);

    const slot = cssBlock(".sidebar-slot");
    assert.match(slot, /overflow:\s*hidden/);
    const sidebar = cssBlock(".sidebar");
    assert.match(sidebar, /width:\s*var\(--sidebar-w\)/);
    assert.match(sidebar, /min-width:\s*var\(--sidebar-w\)/);
    assert.doesNotMatch(sidebar, /display:\s*none/);
    assert.doesNotMatch(CSS, /\.app\.sidebar-hidden \.sidebar\s*\{[^}]*display:\s*none/);
    assert.match(HTML, /<div class="sidebar-slot" id="sidebarSlot">[\s\S]*id="sidebar"[\s\S]*<\/aside>\s*<\/div>/);
  });

  it("keeps the closing panel paintable until the track finishes, then drops pointer and focus targets", () => {
    const hidden = cssBlock(".app.sidebar-hidden .sidebar");
    assert.match(hidden, /visibility:\s*hidden/);
    assert.match(hidden, /pointer-events:\s*none/);
    const midClose = cssBlock(".app.sidebar-animating.sidebar-hidden .sidebar");
    assert.match(midClose, /visibility:\s*visible/);

    const sync = functionSource("syncSidebarAvailability");
    assert.match(sync, /sidebarVisible\(\)/);
    assert.match(sync, /removeAttribute\("inert"\)/);
    assert.match(sync, /setAttribute\("inert", ""\)/);
    assert.match(functionSource("syncNavToggle"), /syncSidebarAvailability\(\)/);
    assert.match(functionSource("finishSidebarToggle"), /classList\.remove\("sidebar-animating"\)/);
    assert.match(functionSource("finishSidebarToggle"), /syncSidebarAvailability\(\)/);
  });

  it("preserves overlay, persistence, and close paths, and does not animate first load or resize", () => {
    const toggle = functionSource("toggleSidebar");
    assert.match(toggle, /innerWidth <= 900[\s\S]*sidebar-open/);
    assert.match(toggle, /sidebar-hidden/);
    assert.match(toggle, /localStorage\.setItem\("piwebui\.sidebar"/);
    assert.match(toggle, /beginSidebarToggle\(\)/);
    assert.doesNotMatch(functionSource("boot"), /sidebar-animating|beginSidebarToggle/);
    assert.match(functionSource("boot"), /classList\.add\("sidebar-hidden"\)/);

    assert.match(JS, /scrim[\s\S]{0,180}remove\("sidebar-open"\)[\s\S]{0,80}beginSidebarToggle\(\)/);
    assert.match(JS, /innerWidth <= 900[\s\S]{0,120}remove\("sidebar-open"\)[\s\S]{0,80}beginSidebarToggle\(\)/);

    const begin = functionSource("beginSidebarToggle");
    assert.match(begin, /classList\.add\("sidebar-animating"\)/);
    assert.match(begin, /clearTimeout\(sidebarToggleTimer\)/);
    assert.match(begin, /SIDEBAR_TOGGLE_MS \+ 40/);
    assert.doesNotMatch(begin, /classList\.remove\("sidebar-animating"\)/);

    const resize = JS.slice(JS.indexOf('window.addEventListener("resize"'));
    assert.match(resize, /finishSidebarToggle\(\)/);

    const mobile = CSS.slice(CSS.indexOf("@media (max-width: 900px)"));
    const mobileEnd = mobile.indexOf("@media (max-width: 520px)");
    const mobileCss = mobile.slice(0, mobileEnd);
    assert.match(mobileCss, /\.sidebar-slot\s*\{\s*display:\s*contents/);
    assert.match(mobileCss, /transform:\s*translateX\(-102%\)/);
    assert.match(mobileCss, /\.app\.sidebar-open \.sidebar[\s\S]*transform:\s*translateX\(0\)/);
    assert.match(mobileCss, /\.app\.sidebar-animating\s*\{\s*transition:\s*none/);
    assert.match(mobileCss, /\.app\.sidebar-open \.scrim/);
    assert.match(mobileCss, /display:\s*block/);
  });

  it("skips the toggle motion when the user prefers reduced motion", () => {
    const begin = functionSource("beginSidebarToggle");
    assert.match(functionSource("prefersReducedSidebarMotion"), /prefers-reduced-motion:\s*reduce/);
    assert.match(begin, /prefersReducedSidebarMotion\(\)[\s\S]*finishSidebarToggle\(\)/);
    assert.match(
      CSS,
      /prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\.app\.sidebar-animating,\s*\.app\.sidebar-animating \.sidebar\s*\{\s*transition:\s*none/,
    );
  });
});
