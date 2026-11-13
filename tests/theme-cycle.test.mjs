import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const JS = readFileSync(join(ROOT, "public/js/app.js"), "utf8");
const HTML = readFileSync(join(ROOT, "public/index.html"), "utf8");
const CSS = readFileSync(join(ROOT, "public/styles.css"), "utf8");

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

function loadHelpers() {
  const start = JS.indexOf("const THEME_CYCLE");
  const end = JS.indexOf("function applyTheme", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const context = vm.createContext({});
  vm.runInContext(
    JS.slice(start, end) +
      "\nglobalThis.THEME_CYCLE = THEME_CYCLE; globalThis.THEME_LABELS = THEME_LABELS; globalThis.themePreference = themePreference; globalThis.nextTheme = nextTheme;",
    context,
  );
  return context;
}

describe("appearance menu replaces the theme cycle button", () => {
  it("keeps the light/dark/system preference helpers intact", () => {
    const ctx = loadHelpers();
    assert.deepEqual(Array.from(ctx.THEME_CYCLE), ["light", "dark", "system"]);
    assert.equal(ctx.nextTheme("light"), "dark");
    assert.equal(ctx.nextTheme("dark"), "system");
    assert.equal(ctx.nextTheme("system"), "light");
    assert.equal(ctx.nextTheme("unknown"), "system");
    assert.equal(ctx.themePreference("system"), "system");
    assert.equal(ctx.themePreference("light"), "light");
    assert.equal(ctx.themePreference("dark"), "dark");
  });

  it("opens a menu on click instead of cycling, with shirt icon and ARIA", () => {
    assert.doesNotMatch(JS, /function cycleTheme/);
    assert.match(JS, /function openAppearanceMenu\(/);
    assert.match(JS, /el\.themeBtn\.addEventListener\("click", \(\) => openAppearanceMenu\(el\.themeBtn\)\)/);
    const menu = functionSource("openAppearanceMenu");
    assert.match(menu, /labelOnly: true, label: "明暗"/);
    assert.match(menu, /labelOnly: true, label: "皮肤"/);
    assert.match(menu, /applyTheme\("light"\)/);
    assert.match(menu, /applyTheme\("dark"\)/);
    assert.match(menu, /applyTheme\("system"\)/);
    assert.match(menu, /align: "right"/);
    const btn = HTML.match(/<button[^>]*id="themeBtn"[^>]*>[\s\S]*?<\/button>/);
    assert.ok(btn);
    assert.match(btn[0], /type="button"/);
    assert.match(btn[0], /aria-haspopup="menu"/);
    assert.match(btn[0], /#i-shirt/);
    assert.match(HTML, /<symbol id="i-shirt"/);
    assert.doesNotMatch(btn[0], /i-sun|i-moon|i-monitor/);
  });

  it("applyTheme persists the preference and keeps the mode/theme attributes", () => {
    const apply = functionSource("applyTheme");
    assert.match(apply, /dataset\.mode = next/);
    assert.match(apply, /dataset\.theme = resolved/);
    assert.match(apply, /localStorage\.setItem\("piwebui\.theme", next\)/);
    assert.match(apply, /resolved === "dark" \? "#000000" : "#ffffff"/);
  });

  it("skins live in a registry, persist to piwebui.skin and set data-skin", () => {
    assert.match(JS, /const SKINS = \[/);
    const apply = functionSource("applySkin");
    assert.match(apply, /dataset\.skin = skin/);
    assert.match(apply, /localStorage\.setItem\("piwebui\.skin", skin\)/);
    assert.match(functionSource("currentSkin"), /piwebui\.skin/);
    const boot = functionSource("boot");
    assert.match(boot, /applySkin\(localStorage\.getItem\("piwebui\.skin"\)/);
    assert.doesNotMatch(CSS, /theme-mode-dark|theme-mode-light|theme-mode-system/);
  });

  it("keeps the first-load default and the system-preference listener", () => {
    assert.match(JS, /localStorage\.getItem\("piwebui\.theme"\) \|\| "system"/);
    const boot = functionSource("boot");
    assert.match(boot, /applyTheme\(theme === "light" \|\| theme === "system" \? theme : "dark"\)/);
    assert.match(boot, /dataset\.mode === "system"\) applyTheme\("system"\)/);
    const htmlBoot = HTML.slice(HTML.indexOf("<script>"), HTML.indexOf("</script>"));
    assert.match(htmlBoot, /localStorage\.getItem\("piwebui\.theme"\) \|\| "system"/);
    assert.match(htmlBoot, /dataset\.mode = mode/);
    assert.match(htmlBoot, /dataset\.skin = localStorage\.getItem\("piwebui\.skin"\) \|\| "classic"/);
    assert.match(htmlBoot, /prefers-color-scheme: dark/);
  });
});
