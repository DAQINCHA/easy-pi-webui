import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CSS = readFileSync(join(ROOT, "public/styles.css"), "utf8");
const JS = readFileSync(join(ROOT, "public/js/app.js"), "utf8");

function parseRules() {
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(CSS))) {
    const selectors = m[1].replace(/\/\*[\s\S]*?\*\//g, " ").replace(/@(?:media|supports|layer)[^{]*/g, " ").trim();
    if (!selectors || selectors.startsWith("@")) continue;
    const body = m[2];
    const color = (body.match(/(?:^|;)\s*color:\s*([^;]+)/m) || [])[1];
    const background = (body.match(/(?:^|;)\s*background:\s*([^;]+)/m) || [])[1];
    const borderColor = (body.match(/(?:^|;)\s*border-color:\s*([^;]+)/m) || [])[1];
    for (const selector of selectors.split(",").map((s) => s.trim()).filter(Boolean)) {
      rules.push({
        selector,
        index: m.index,
        color: color ? color.trim() : "",
        background: background ? background.trim() : "",
        borderColor: borderColor ? borderColor.trim() : "",
      });
    }
  }
  return rules;
}

function specificity(selector) {
  let id = 0;
  let cls = 0;
  let typ = 0;
  const tokens = [];
  const re = /::?[a-zA-Z-]+(?:\(([^()]*)\))?|\.[a-zA-Z0-9_-]+|#[a-zA-Z0-9_-]+|[a-zA-Z][a-zA-Z0-9-]*/g;
  let m;
  while ((m = re.exec(selector))) {
    tokens.push(m[0]);
    const tok = m[0];
    if (tok.startsWith("#")) id += 1;
    else if (tok.startsWith(".")) cls += 1;
    else if (tok.startsWith("::")) typ += 1;
    else if (tok.startsWith(":")) {
      const name = tok.slice(1).split("(")[0];
      const arg = m[1];
      if (name === "where") continue;
      if (name === "is" || name === "not" || name === "has") {
        const inner = String(arg || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map(specificity);
        if (inner.length) {
          inner.sort((a, b) => b.id - a.id || b.cls - a.cls || b.typ - a.typ);
          id += inner[0].id;
          cls += inner[0].cls;
          typ += inner[0].typ;
        }
      } else {
        cls += 1;
      }
    } else typ += 1;
  }
  return { id, cls, typ, tokens };
}

function better(a, b) {
  if (a.spec.id !== b.spec.id) return a.spec.id - b.spec.id;
  if (a.spec.cls !== b.spec.cls) return a.spec.cls - b.spec.cls;
  if (a.spec.typ !== b.spec.typ) return a.spec.typ - b.spec.typ;
  return a.index - b.index;
}

function matches(selector, classes, hover, focus) {
  // Very small matcher for the session-action cases we care about.
  const parts = selector.split(/\s+/);
  const leaf = parts.at(-1);
  if (!leaf || !leaf.startsWith(".session-action")) return false;
  if (leaf.includes(":hover") && !hover) return false;
  if (leaf.includes(":focus-visible") && !focus) return false;
  if (leaf.includes(".pin") && !classes.includes("pin")) return false;
  if (leaf.includes(".on") && !classes.includes("on")) return false;
  if (selector.includes(":has(.session-item.active)") && !classes.includes("in-active-wrap")) return false;
  if (selector.includes(":not(.running)") && classes.includes("running")) return false;
  if (selector.includes(".session-wrap:hover") && !classes.includes("wrap-hover")) return false;
  if (selector.includes(":focus-within") && !classes.includes("wrap-focus")) return false;
  return true;
}

function winningProp(classes, hover, focus, prop) {
  const hits = parseRules()
    .filter((rule) => rule[prop] && matches(rule.selector, classes, hover, focus))
    .map((rule) => ({ ...rule, spec: specificity(rule.selector) }));
  assert.ok(hits.length, "no " + prop + " rule for " + classes.join(".") + " hover=" + hover);
  hits.sort(better);
  return hits.at(-1);
}

describe("sidebar session actions and list scrollbar", () => {
  it("keeps selected-row icons readable at rest, and forces black icons on yellow hover/focus", () => {
    const rest = winningProp(["in-active-wrap"], false, false, "color");
    assert.match(rest.color, /var\(--text-selected\)/);
    assert.ok(rest.spec.cls >= 5, "resting selected color should be the high-specificity :has rule, got " + JSON.stringify(rest));

    const hover = winningProp(["in-active-wrap"], true, false, "color");
    assert.equal(hover.color, "var(--accent-fg)");
    assert.match(hover.background || parseRules().find((r) => r.selector === hover.selector)?.background || "", /var\(--bg-hover\)|#111111|/);
    const hoverBg = winningProp(["in-active-wrap"], true, false, "background");
    assert.match(hoverBg.background, /var\(--bg-hover\)/);
    assert.ok(
      better({ spec: hover.spec, index: hover.index }, { spec: rest.spec, index: rest.index }) > 0,
      "selected hover must beat resting selected color: hover=" + JSON.stringify(hover) + " rest=" + JSON.stringify(rest),
    );

    const focus = winningProp(["in-active-wrap"], false, true, "color");
    assert.equal(focus.color, "var(--accent-fg)");

    const unselected = winningProp([], true, false, "color");
    assert.equal(unselected.color, "var(--accent-fg)");

    const pinOnSelected = winningProp(["in-active-wrap", "pin", "on"], true, false, "color");
    assert.equal(pinOnSelected.color, "var(--accent-fg)");

    const unselectedBg = winningProp([], true, false, "background");
    assert.match(unselectedBg.background, /var\(--bg-hover\)/);
    const grouped = CSS.match(/\.session-action:hover[^{]*\{([^}]*)\}/);
    assert.ok(grouped, "missing .session-action:hover rule");
    assert.match(grouped[1], /background:\s*var\(--bg-hover\)/);
    assert.match(grouped[1], /color:\s*var\(--accent-fg\)/);
    assert.doesNotMatch(grouped[1], /border-color:\s*var\(--ink\)/);
    assert.doesNotMatch(grouped[1], /border:\s*[^;]*var\(--ink\)/);
    const base = CSS.match(/(?:^|\n)\.session-action\s*\{([^}]*)\}/);
    assert.ok(base, "missing .session-action rule");
    assert.doesNotMatch(base[1], /border\s*:/);
    assert.doesNotMatch(base[1], /border-color\s*:/);
  });

  it("makes active-session actions visible at rest and still hides running-session actions", () => {
    const action = parseRules().filter((r) =>
      r.selector === ".session-wrap:has(.session-item.active):not(.running) .session-action",
    );
    assert.ok(action.length);
    assert.match(action[0].color, /var\(--text-selected\)/);
    assert.match(CSS, /\.session-wrap\.running \.session-action\s*\{[^}]*opacity:\s*0/);
  });

  it("keeps the running spinner readable on the selected session row", () => {
    const rules = parseRules();
    const selectedSpin = rules.filter((rule) => rule.selector === ".session-item.active .session-spin");
    assert.equal(selectedSpin.length, 1, "missing .session-item.active .session-spin rule");
    assert.match(selectedSpin[0].borderColor, /var\(--text-selected\)/);

    const base = rules.find((rule) => rule.selector === ".session-spin");
    assert.ok(base, "missing .session-spin base rule");
    assert.ok(
      better(
        { spec: specificity(selectedSpin[0].selector), index: selectedSpin[0].index },
        { spec: specificity(base.selector), index: base.index },
      ) > 0,
      "selected spinner border must win over the base --text-3 border",
    );
    // 尺寸、速度、主题不变：基础转圈仍是同一虚线边框与同一动画。
    const baseBlock = CSS.match(/(?:^|\n)\.session-spin\s*\{([^}]*)\}/);
    assert.match(baseBlock[1], /border:\s*1\.5px dashed var\(--text-3\)/);
    assert.match(baseBlock[1], /animation:\s*spin 2\.4s linear infinite/);

    // 选中行悬停/聚焦不改底色，仍是反相底，所以 --text-selected 依然是对的前景色。
    const selectedBg = rules
      .filter((rule) => rule.selector === ".session-item.active" || rule.selector === ".session-item:hover")
      .map((rule) => ({ ...rule, spec: specificity(rule.selector) }))
      .sort(better)
      .at(-1);
    assert.equal(selectedBg.selector, ".session-item.active");
    assert.match(selectedBg.background, /var\(--bg-selected\)/);
    assert.equal(
      rules.some((rule) => rule.selector === ".session-item.active:hover"),
      false,
      "active hover must not override the selected background",
    );

    const dark = CSS.slice(CSS.indexOf('html[data-theme="dark"]'), CSS.indexOf('html[data-theme="light"]'));
    const light = CSS.slice(CSS.indexOf('html[data-theme="light"]'));
    assert.match(dark, /--bg-selected:\s*#ffffff;[\s\S]*?--text-selected:\s*#000000;/);
    assert.match(light, /--bg-selected:\s*#111111;[\s\S]*?--text-selected:\s*#ffffff;/);
  });

  it("does not let standard scrollbar properties override the thin square webkit thumb", () => {
    const layout = [];
    const re = /\.session-scroll\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(CSS))) {
      // Ignore rules inside the Firefox-only @supports not selector(::-webkit-scrollbar) block.
      const before = CSS.lastIndexOf("@supports", m.index);
      const inFirefoxOnly =
        before !== -1 &&
        CSS.slice(before, m.index).includes("not selector(::-webkit-scrollbar)") &&
        !CSS.slice(before, m.index).includes("}");
      layout.push({ body: m[1], inFirefoxOnly, index: m.index });
    }
    const chromium = layout.filter((rule) => !rule.inFirefoxOnly);
    assert.ok(chromium.length, "missing .session-scroll layout rule");
    for (const rule of chromium) {
      assert.doesNotMatch(rule.body, /scrollbar-width/);
      assert.doesNotMatch(rule.body, /scrollbar-color/);
    }

    const webkit = CSS.match(/\.session-scroll::-webkit-scrollbar\s*\{[^}]*\}/)[0];
    assert.match(webkit, /width:\s*10px/);
    const hidden = CSS.match(/\.session-scroll::-webkit-scrollbar-thumb\s*\{[^}]*\}/)[0];
    assert.match(hidden, /background:\s*var\(--session-scroll-thumb\)/);
    assert.match(hidden, /border:\s*3px solid transparent/);
    assert.match(hidden, /border-radius:\s*var\(--radius\)/);
    assert.match(hidden, /background-clip:\s*content-box/);
    assert.doesNotMatch(hidden, /transition\s*:/);
    // Main-thread global thumb stays styled and visible.
    assert.match(CSS, /(?:^|\n)::-webkit-scrollbar-thumb \{ background: var\(--scroll-thumb\); border: 3px solid transparent; border-radius: var\(--radius\);/);
  });

  it("fades the thumb via a registered color on the scroller, not a fake thumb transition", () => {
    const prop = CSS.match(/@property --session-scroll-thumb\s*\{([^}]*)\}/);
    assert.ok(prop, "missing @property --session-scroll-thumb");
    assert.match(prop[1], /syntax:\s*"<color>"/);
    assert.match(prop[1], /inherits:\s*true/);
    assert.match(prop[1], /initial-value:\s*transparent/);

    const layout = CSS.match(/\.session-scroll\s*\{([^}]*)\}/);
    assert.match(layout[1], /--session-scroll-thumb:\s*transparent/);
    assert.match(layout[1], /transition:\s*--session-scroll-thumb 200ms/);
    assert.doesNotMatch(layout[1], /scrollbar-width|scrollbar-color/);
    assert.match(CSS, /\.session-scroll\.is-scrolling\s*\{[^}]*--session-scroll-thumb:\s*var\(--scroll-thumb\)/);
    assert.match(CSS, /@media \(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.session-scroll\s*\{[^}]*transition:\s*none/);

    // <color> interpolation between transparent and theme thumb colors has a mid value
    // distinct from either endpoint, so a 200ms fade is actually possible.
    function parseHex(hex) {
      const m = /^#([0-9a-f]{6})$/i.exec(hex);
      assert.ok(m, "expected #rrggbb, got " + hex);
      const n = parseInt(m[1], 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
    }
    function lerp(a, b, t) {
      return {
        r: a.r + (b.r - a.r) * t,
        g: a.g + (b.g - a.g) * t,
        b: a.b + (b.b - a.b) * t,
        a: a.a + (b.a - a.a) * t,
      };
    }
    const transparent = { r: 0, g: 0, b: 0, a: 0 };
    const thumbs = [...CSS.matchAll(/--scroll-thumb:\s*(#[0-9a-fA-F]{6})/g)].map((m) => m[1]);
    assert.ok(thumbs.length >= 2, "expected light and dark --scroll-thumb colors");
    for (const hex of thumbs) {
      const mid = lerp(transparent, parseHex(hex), 0.5);
      assert.ok(mid.a > 0.2 && mid.a < 0.8, "mid alpha should be in-between, got " + mid.a + " for " + hex);
      assert.ok(mid.r !== 0 || mid.g !== 0 || mid.b !== 0);
      const end = parseHex(hex);
      assert.ok(mid.r !== end.r || mid.a !== end.a);
    }
  });

  it("keeps the sidebar search hard offset shadow at rest, without a click outline", () => {
    const search = CSS.match(/(?:^|\n)\.search\s*\{([^}]*)\}/);
    assert.ok(search, "missing .search rule");
    assert.match(search[1], /box-shadow:\s*var\(--shadow-soft\)/);
    assert.match(search[1], /height:\s*32px/);
    assert.doesNotMatch(CSS, /\.search:focus-within[^\{]*\{[^}]*outline\s*:/);
    assert.doesNotMatch(CSS, /\.search:has\([^)]*focus-visible/);
    const dark = CSS.slice(CSS.indexOf('html[data-theme="dark"]'), CSS.indexOf('html[data-theme="light"]'));
    const light = CSS.slice(CSS.indexOf('html[data-theme="light"]'));
    assert.match(dark, /--shadow-soft:\s*3px 3px 0 var\(--shadow-color\)/);
    assert.match(light, /--shadow-soft:\s*3px 3px 0 var\(--shadow-color\)/);
    assert.match(dark, /--shadow-color:\s*#333333/);
    assert.match(light, /--shadow-color:\s*#111111/);
  });

  it("binds a single scroll listener, hides after 1s, and does not show on hover", () => {
    assert.match(JS, /const SESSION_SCROLLBAR_HIDE_MS = 1000/);
    assert.match(JS, /if \(sessionScrollbarBound \|\| !el\.sessionList\) return/);
    assert.match(JS, /sessionScrollbarBound = true/);
    assert.match(JS, /classList\.add\("is-scrolling"\)/);
    assert.match(JS, /clearTimeout\(sessionScrollbarHideTimer\)/);
    assert.match(JS, /setTimeout\(\(\) => \{\s*scroller\.classList\.remove\("is-scrolling"\)/);
    assert.match(JS, /addEventListener\("scroll", onScroll, \{ passive: true \}\)/);
    assert.doesNotMatch(JS.slice(JS.indexOf("function bindSessionListScrollbar")), /mouseenter|mouseover/);
    assert.match(JS, /bindSessionListScrollbar\(\)/);
    assert.equal((JS.match(/function bindSessionListScrollbar/g) || []).length, 1);
  });
});
