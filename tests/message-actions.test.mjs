import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "public/js/app.js"),
  "utf8",
);

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
  it("keeps copy and edit on user messages, and does not put regenerate or branch actions there", () => {
    const source = functionSource("userNode");
    const names = acts(source);
    assert.deepEqual(names, ["copy-user", "edit-user"]);
    assert.match(source, /data-act="copy-user"/);
    assert.match(source, /ICON\("copy"\) \+ "复制/);
    assert.match(source, /forkButton\("edit-user".*"编辑"/);
    assert.equal(source.includes("retry-user"), false);
    assert.equal(source.includes("retry-bot"), false);
    assert.equal(source.includes("alternate-bot"), false);
    assert.equal(source.includes("重新生成"), false);
    assert.equal(source.includes("另开分支"), false);
  });

  it("keeps copy, regenerate, and open-branch on assistant replies", () => {
    const source = functionSource("turnNodes");
    const names = acts(source);
    assert.deepEqual(names, ["copy-bot", "retry-bot", "alternate-bot"]);
    assert.match(source, /data-act="copy-bot"/);
    assert.match(source, /ICON\("copy"\) \+ "复制/);
    assert.match(source, /forkButton\("retry-bot".*"重新生成"/);
    assert.match(source, /forkButton\("alternate-bot".*"另开分支"/);
  });

  it("routes copy-user and copy-bot through the existing copy handler, not fork actions", () => {
    assert.match(SOURCE, /const action = event\.target\.closest\("\[data-act\]"\)/);
    const forkRoute = SOURCE.match(/if \(act === "edit-user"[\s\S]*?\) \{/);
    assert.ok(forkRoute, "missing fork action route");
    assert.doesNotMatch(forkRoute[0], /copy-user|copy-bot/);
    assert.match(SOURCE, /navigator\.clipboard\.writeText\(text\)/);
    assert.match(SOURCE, /toast\("已复制"\)/);
  });
});
