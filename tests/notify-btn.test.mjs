import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = readFileSync(join(ROOT, "public/index.html"), "utf8");
const CSS = readFileSync(join(ROOT, "public/styles.css"), "utf8");
const JS = readFileSync(join(ROOT, "public/js/app.js"), "utf8");

function functionSource(name) {
  const start = JS.indexOf("function " + name + "(");
  assert.notEqual(start, -1, "missing function " + name);
  const sigEnd = JS.indexOf(") {", start);
  const brace = JS.indexOf("{", sigEnd);
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

function lastRule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("(?:^|,)\\s*" + escaped + "\\s*(?:,[^{]*)?\\{[^}]*\\}", "gm");
  const blocks = CSS.match(re) || [];
  assert.ok(blocks.length, "missing selector " + selector);
  return blocks[blocks.length - 1];
}

function loadNotifyHelpers(env) {
  const start = JS.indexOf('const NOTIFY_KEY = "piwebui.notify"');
  assert.notEqual(start, -1);
  const end = JS.indexOf("function writeNotifyPref", start);
  const helpers = JS.slice(start, end);
  const context = vm.createContext({
    window: env.window,
    Notification: env.window && env.window.Notification,
    localStorage: env.localStorage,
  });
  vm.runInContext(helpers, context);
  return context;
}

describe("notify button on/off state", () => {
  it("restores the piwebui.notify key and does not treat pref alone as enabled", () => {
    assert.match(JS, /const NOTIFY_KEY = "piwebui.notify"/);
    const enabled = functionSource("notifyEnabled");
    assert.match(enabled, /readNotifyPref\(\)/);
    assert.match(enabled, /notificationPermissionState\(\)\s*===\s*"granted"/);
    const update = functionSource("updateNotifyBtn");
    assert.match(update, /notifyEnabled\(\)/);
    assert.doesNotMatch(update, /const on = readNotifyPref\(\)/);
    assert.match(update, /setAttribute\("aria-pressed", on \? "true" : "false"\)/);
    assert.match(update, /notifyBtnLabel\(on\)/);
    assert.match(functionSource("toggleNotify"), /Notification\.requestPermission/);
    assert.equal((JS.match(/Notification\.requestPermission/g) || []).length, 1);
    assert.doesNotMatch(functionSource("updateNotifyBtn"), /requestPermission/);
    assert.doesNotMatch(functionSource("notifyEnabled"), /requestPermission/);
    assert.doesNotMatch(functionSource("watchNotifyPermission"), /requestPermission/);
  });

  it("computes labels from the real permission state", () => {
    const store = { "piwebui.notify": "1" };
    const localStorage = {
      getItem: (key) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
    };

    let ctx = loadNotifyHelpers({
      window: {},
      localStorage,
    });
    assert.equal(ctx.notificationPermissionState(), "unsupported");
    assert.equal(ctx.notifyEnabled(), false);

    ctx = loadNotifyHelpers({
      window: { Notification: { permission: "denied" } },
      localStorage,
    });
    assert.equal(ctx.notificationPermissionState(), "denied");
    assert.equal(ctx.notifyEnabled(), false);

    ctx = loadNotifyHelpers({
      window: { Notification: { permission: "default" } },
      localStorage,
    });
    assert.equal(ctx.notificationPermissionState(), "default");
    assert.equal(ctx.notifyEnabled(), false);

    ctx = loadNotifyHelpers({
      window: { Notification: { permission: "granted" } },
      localStorage,
    });
    assert.equal(ctx.notifyEnabled(), true);

    ctx = loadNotifyHelpers({
      window: { Notification: { permission: "granted" } },
      localStorage: { getItem: () => "0" },
    });
    assert.equal(ctx.notifyEnabled(), false);

    const label = functionSource("notifyBtnLabel");
    assert.match(label, /完成时通知：开/);
    assert.match(label, /完成时通知：关（当前浏览器不支持）/);
    assert.match(label, /完成时通知：关（权限已拒绝）/);
    assert.match(label, /完成时通知：关（尚未授权）/);
  });

  it("uses a slashed off icon and a filled on icon in the existing sprite", () => {
    const btn = HTML.match(/<button class="icon-btn" id="notifyBtn"[^>]*>[\s\S]*?<\/button>/);
    assert.ok(btn);
    assert.match(btn[0], /aria-pressed="false"/);
    assert.match(btn[0], /class="notify-icon-off"[^>]*>\s*<use href="#i-bell-off"/);
    assert.match(btn[0], /class="notify-icon-on"[^>]*>\s*<use href="#i-bell"/);
    assert.match(HTML, /<symbol id="i-bell-off"/);
    assert.match(HTML, /<symbol id="i-bell-off"[^>]*>[\s\S]*?M4 20L20 4/);
  });

  it("keeps a transparent resting on-state, and uses the same yellow hover as other icon buttons", () => {
    const off = lastRule("#notifyBtn");
    assert.match(off, /background:\s*transparent/);
    assert.match(off, /border:\s*0/);
    assert.match(off, /color:\s*var\(--text-3\)/);
    assert.doesNotMatch(off, /var\(--accent\)|var\(--bg-hover\)|#ffe600/);

    const on = lastRule("#notifyBtn.on");
    assert.match(on, /background:\s*transparent/);
    assert.match(on, /color:\s*var\(--text-1\)/);
    assert.doesNotMatch(on, /var\(--accent\)|var\(--bg-hover\)|#ffe600/);

    const hover = lastRule("#notifyBtn:hover");
    assert.match(hover, /#notifyBtn\.on:hover/);
    assert.doesNotMatch(hover, /:focus-visible/);
    assert.match(hover, /background:\s*var\(--bg-hover\)/);
    assert.match(hover, /color:\s*var\(--accent-fg\)/);
    assert.doesNotMatch(hover, /color-mix\(/);

    assert.match(lastRule("#notifyBtn .notify-icon-on"), /display:\s*none/);
    assert.match(lastRule("#notifyBtn.on .notify-icon-on"), /display:\s*block/);
    assert.match(lastRule("#notifyBtn.on .notify-icon-on"), /fill:\s*currentColor/);
    assert.match(lastRule("#notifyBtn.on .notify-icon-off"), /display:\s*none/);
  });
});
