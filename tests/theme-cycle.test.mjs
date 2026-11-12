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
      "\nglobalThis.THEME_CYCLE = THEME_CYCLE; globalThis.THEME_LABELS = THEME_LABELS; globalThis.themePreference = themePreference; globalThis.nextTheme = nextTheme; globalThis.themeButtonCopy = themeButtonCopy;",
    context,
  );
  return context;
}

describe("theme button cycles persisted preference", () => {
  it("cycles light → dark → system → light, not the resolved appearance", () => {
    const ctx = loadHelpers();
    assert.deepEqual(Array.from(ctx.THEME_CYCLE), ["light", "dark", "system"]);
    assert.equal(ctx.nextTheme("light"), "dark");
    assert.equal(ctx.nextTheme("dark"), "system");
    assert.equal(ctx.nextTheme("system"), "light");
    assert.equal(ctx.nextTheme("unknown"), "system");
    assert.equal(ctx.themePreference("system"), "system");
    assert.equal(ctx.themePreference("light"), "light");
    assert.equal(ctx.themePreference("dark"), "dark");
    const apply = functionSource("applyTheme");
    assert.match(apply, /dataset\.mode = next/);
    assert.match(apply, /dataset\.theme = resolved/);
    assert.match(apply, /localStorage\.setItem\("piwebui.theme", next\)/);
    assert.match(apply, /resolved === "dark" \? "#000000" : "#ffffff"/);
    assert.match(functionSource("cycleTheme"), /nextTheme\(document\.documentElement\.dataset\.mode\)/);
    assert.doesNotMatch(functionSource("cycleTheme"), /dataset\.theme|resolvedTheme/);
  });

  it("labels the current preference and the next click, and drops menu ARIA", () => {
    const ctx = loadHelpers();
    assert.equal(ctx.themeButtonCopy("light"), "外观：浅色，点击切换为深色");
    assert.equal(ctx.themeButtonCopy("dark"), "外观：深色，点击切换为跟随系统");
    assert.equal(ctx.themeButtonCopy("system"), "外观：跟随系统，点击切换为浅色");
    const apply = functionSource("applyTheme");
    assert.match(apply, /themeButtonCopy\(next\)/);
    assert.match(apply, /removeAttribute\("aria-haspopup"\)/);
    assert.match(apply, /removeAttribute\("aria-expanded"\)/);
    assert.match(JS, /el\.themeBtn\.addEventListener\("click", cycleTheme\)/);
    assert.doesNotMatch(JS, /openThemeMenu/);
    const btn = HTML.match(/<button[^>]*id="themeBtn"[^>]*>[\s\S]*?<\/button>/);
    assert.ok(btn);
    assert.match(btn[0], /type="button"/);
    assert.doesNotMatch(btn[0], /aria-haspopup|aria-expanded/);
    assert.match(btn[0], /theme-mode-light[\s\S]*#i-sun/);
    assert.match(btn[0], /theme-mode-dark[\s\S]*#i-moon/);
    assert.match(btn[0], /theme-mode-system[\s\S]*#i-monitor/);
    assert.match(CSS, /html\[data-mode="light"\] \.theme-mode-light/);
    assert.match(CSS, /html\[data-mode="dark"\] \.theme-mode-dark/);
    assert.match(CSS, /html\[data-mode="system"\] \.theme-mode-system/);
  });

  it("keeps the first-load default and the system-preference listener", () => {
    const boot = functionSource("boot");
    assert.match(JS, /localStorage\.getItem\("piwebui\.theme"\) \|\| "system"/);
    assert.match(boot, /applyTheme\(theme === "light" \|\| theme === "system" \? theme : "dark"\)/);
    assert.match(boot, /dataset\.mode === "system"\) applyTheme\("system"\)/);
    const htmlBoot = HTML.slice(HTML.indexOf("<script>"), HTML.indexOf("</script>"));
    assert.match(htmlBoot, /localStorage\.getItem\("piwebui\.theme"\) \|\| "system"/);
    assert.match(htmlBoot, /dataset\.mode = mode/);
    assert.match(htmlBoot, /prefers-color-scheme: dark/);
  });
});
