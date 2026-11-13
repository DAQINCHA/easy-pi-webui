import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = readFileSync(join(ROOT, "public/js/app.js"), "utf8");
const HTML = readFileSync(join(ROOT, "public/index.html"), "utf8");
const CSS = readFileSync(join(ROOT, "public/styles.css"), "utf8");

function functionSource(name) {
  const start = SOURCE.indexOf("function " + name + "(");
  assert.notEqual(start, -1, "missing function " + name);
  const sigEnd = SOURCE.indexOf(") {", start);
  assert.notEqual(sigEnd, -1, "missing body for " + name);
  const brace = SOURCE.indexOf("{", sigEnd);
  let depth = 0;
  for (let i = brace; i < SOURCE.length; i += 1) {
    const ch = SOURCE[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return SOURCE.slice(start, i + 1);
    }
  }
  assert.fail("unclosed function " + name);
}

function acts(source) {
  return [...source.matchAll(/data-act="([^"]+)"|forkButton\("([^"]+)"/g)].map((match) => match[1] || match[2]);
}

describe("message action buttons", () => {
  it("keeps copy, full-request copy and edit on user messages, adds create-branch, and does not put regenerate or clone there", () => {
    const source = functionSource("userNode");
    const names = acts(source);
    assert.deepEqual(names, ["copy-user", "copy-user-full", "edit-user", "branch-user"]);
    assert.match(source, /data-act="copy-user"/);
    assert.ok(source.includes('ICON("copy") + "复制内容</button>'));
    assert.ok(source.includes('data-act="copy-user-full"'));
    assert.ok(source.includes('ICON("copy") + "复制完整请求</button>'));
    assert.match(source, /forkButton\("edit-user".*"编辑内容"[\s\S]*"edit"\)/);
    assert.match(source, /forkButton\("branch-user".*"创建分支"[\s\S]*"branch"\)/);
    assert.match(source, /aria-label="复制内容"/);
    assert.ok(!source.includes('ICON("copy") + "复制</button>'));
    assert.doesNotMatch(source, /forkButton\("edit-user".*"编辑",/);
    assert.equal(source.includes("retry-user"), false);
    assert.equal(source.includes("retry-bot"), false);
    assert.equal(source.includes("clone-bot"), false);
    assert.equal(source.includes("alternate-bot"), false);
    assert.equal(source.includes("重新生成"), false);
    assert.equal(source.includes("另开分支"), false);
    assert.equal(source.includes("另开方案"), false);
  });

  it("keeps copy and regenerate on assistant replies, and only shows create-branch on the last completed reply", () => {
    const source = functionSource("turnNodes");
    const names = acts(source);
    assert.deepEqual(names, ["copy-bot", "retry-bot", "clone-bot"]);
    assert.match(source, /data-act="copy-bot"/);
    assert.ok(source.includes('ICON("copy") + "复制内容</button>'));
    assert.match(source, /forkButton\("retry-bot".*"重新生成"[\s\S]*"refresh"\)/);
    assert.match(source, /forkButton\("clone-bot".*"创建分支"[\s\S]*"branch"\)/);
    assert.match(source, /aria-label="复制内容"/);
    assert.match(source, /ctx\.canClone && ctx\.regenEntryId/);
    assert.equal(source.includes("alternate-bot"), false);
    assert.equal(source.includes("另开分支"), false);
    const ctx = functionSource("turnContext");
    assert.match(ctx, /ownsLastAssistant/);
    assert.match(ctx, /lastMessageIsAssistant/);
    assert.match(ctx, /canClone: Boolean\(ownsLastAssistant && lastMessageIsAssistant && !streaming && !isTurnLocked\(\)\)/);
  });

  it("routes copy-user and copy-bot through the existing copy handler, not fork actions", () => {
    assert.match(SOURCE, /const action = event\.target\.closest\("\[data-act\]"\)/);
    const route = SOURCE.match(/if \(act === "edit-user"[^\n]+\) \{/);
    assert.ok(route, "missing fork action route");
    assert.match(route[0], /branch-user/);
    assert.match(route[0], /clone-bot/);
    assert.doesNotMatch(route[0], /copy-user|copy-bot/);
    assert.match(SOURCE, /navigator\.clipboard\.writeText\(text\)/);
    assert.match(SOURCE, /toast\("已复制"\)/);
    assert.match(SOURCE, /act === "copy-user-full"/);
    assert.match(SOURCE, /userVisibleText\(node\)/);
    const handle = functionSource("handleForkAction");
    assert.match(handle, /runSessionBranch\("fork", entryId, "user"\)/);
    assert.match(handle, /runSessionBranch\("clone", entryId, "assistant"\)/);
    assert.doesNotMatch(handle, /copy-user|copy-bot/);
  });

  it("has no leftover user-visible 另开分支 or 另开方案 copy", () => {
    assert.equal(SOURCE.includes("另开分支"), false);
    assert.equal(SOURCE.includes("另开方案"), false);
    assert.equal(SOURCE.includes("已另开"), false);
  });

  it("puts shared linear icons on every message action and keeps copy feedback from dropping the icon", () => {
    const fork = functionSource("forkButton");
    assert.match(fork, /icon \? ICON\(icon\) : ""/);
    assert.match(fork, /aria-label="' \+ escapeHtml\(label\) \+ '"/);
    assert.match(fork, /disabled \? " disabled" : ""/);
    assert.match(HTML, /symbol id="i-copy"/);
    assert.match(HTML, /symbol id="i-edit"/);
    assert.match(HTML, /symbol id="i-refresh"/);
    assert.match(HTML, /symbol id="i-branch"/);
    assert.match(SOURCE, /const ICON = \(name\) => '<svg aria-hidden="true">/);
    assert.match(CSS, /\.action svg\s*\{\s*width:\s*13px;\s*height:\s*13px;/);

    const copyHandler = SOURCE.slice(SOURCE.indexOf('const action = event.target.closest("[data-act]")'));
    const end = copyHandler.indexOf("el.messages.addEventListener(");
    const body = copyHandler.slice(0, end > 0 ? end : 1200);
    assert.match(body, /toast\("已复制"\)/);
    assert.match(body, /toast\("复制失败", "error"\)/);
    assert.doesNotMatch(body, /textContent\s*=\s*"复制"/);
    assert.doesNotMatch(body, /textContent\s*=\s*"已复制"/);
    assert.match(SOURCE, /data-copy[\s\S]{0,400}textContent = "已复制"[\s\S]{0,120}textContent = "复制"/);
  });
});
