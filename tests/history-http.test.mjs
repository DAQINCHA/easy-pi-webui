import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { sessionsDir } from "../lib/sessions.js";
import { startServer } from "./helpers/harness.mjs";

function line(obj) {
  return JSON.stringify(obj);
}

function writeJsonl(dir, name, records) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, records.map(line).join("\n") + "\n");
  return file;
}

function sample(id, title, userText, assistantText) {
  return [
    { type: "session", id, cwd: "/tmp/ws", timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "session_info", name: title },
    {
      type: "message",
      id: "u1",
      parentId: "",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: userText },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: { role: "assistant", content: assistantText },
    },
  ];
}

describe("history search and export HTTP", () => {
  let server;
  let sessionFolder;
  let keepFile;

  before(async () => {
    server = await startServer();
    process.env.PI_SESSION_DIR = server.envHome.sessions;
    sessionFolder = sessionsDir(realpathSync(server.workspace));
    mkdirSync(sessionFolder, { recursive: true });
    keepFile = writeJsonl(sessionFolder, "keep.jsonl", sample(
      "keep",
      "工作备忘",
      "请整理会议纪要",
      [{ type: "text", text: "纪要正文写在这里，含 console 代码：\n\n```js\nconsole.log('你好')\n```" }],
    ));
    writeJsonl(sessionFolder, "xss.jsonl", sample(
      "xss",
      "安全检查",
      '<script>alert(1)</script> 和 [点我](javascript:alert(1))',
      [{ type: "text", text: "正常回答" }],
    ));
  });

  after(async () => {
    if (server) await server.stop();
  });

  async function search(q, headers = {}) {
    const res = await fetch(server.base + "/api/sessions/search", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ q }),
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  it("searches current workspace bodies without spawning pi", async () => {
    const { res, data } = await search("纪要正文");
    assert.equal(res.status, 200);
    assert.equal(data.results.length, 1);
    assert.equal(data.results[0].file, keepFile);
    assert.equal(data.results[0].match, "body");
    assert.match(data.results[0].snippet, /纪要正文/);
    const log = existsSync(server.envHome.log) ? readFileSync(server.envHome.log, "utf8") : "";
    assert.equal(log.trim(), "");
  });

  it("finds visible text earlier in a toolResult parent chain via the HTTP API", async () => {
    const file = writeJsonl(sessionFolder, "chain.jsonl", [
      { type: "session", id: "s0", cwd: "/tmp/ws", timestamp: "2026-01-01T00:00:00.000Z" },
      { type: "model_change", id: "mc", parentId: "s0", timestamp: "2026-01-01T00:00:01.000Z", modelId: "x" },
      {
        type: "message",
        id: "u1",
        parentId: "mc",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: { role: "user", content: "请看一下环境" },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-01-01T00:00:03.000Z",
        message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "uname" } }] },
      },
      {
        type: "message",
        id: "r1",
        parentId: "a1",
        timestamp: "2026-01-01T00:00:04.000Z",
        message: { role: "toolResult", content: [{ type: "text", text: "http-tool-result-token" }] },
      },
      {
        type: "message",
        id: "a2",
        parentId: "r1",
        timestamp: "2026-01-01T00:00:05.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "http-visible-chain-token is here" }] },
      },
      {
        type: "message",
        id: "a3",
        parentId: "a2",
        timestamp: "2026-01-01T00:00:06.000Z",
        message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "echo later" } }] },
      },
    ]);
    const hit = await search("http-visible-chain-token");
    assert.equal(hit.res.status, 200);
    assert.equal(hit.data.results.some((item) => item.file === file), true);
    const hidden = await search("http-tool-result-token");
    assert.equal(hidden.data.results.some((item) => item.file === file), false);
  });

  it("rejects an untrusted origin and an overlong query", async () => {
    const badOrigin = await search("纪要", { origin: "https://evil.example" });
    assert.equal(badOrigin.res.status, 403);
    const long = await search("x".repeat(201));
    assert.equal(long.res.status, 400);
  });

  it("still finds a session that would fall outside the default 80-item list", async () => {
    for (let i = 0; i < 85; i += 1) {
      writeJsonl(sessionFolder, "bulk-" + String(i).padStart(3, "0") + ".jsonl", sample(
        "bulk" + i,
        "批量" + i,
        "占位会话 " + i,
        [{ type: "text", text: "占位回答" }],
      ));
    }
    const hidden = writeJsonl(sessionFolder, "hidden-old.jsonl", sample(
      "hidden",
      "旧档案",
      "只有这里有独有短语 pineapple-42",
      [{ type: "text", text: "好的" }],
    ));
    const { data } = await search("pineapple-42");
    assert.ok(data.total > 80);
    assert.equal(data.results.some((item) => item.file === hidden), true);
  });

  it("refuses symlink escape on export and does not leak outside session files", async () => {
    const outside = join(server.envHome.dir, "outside.jsonl");
    writeFileSync(outside, JSON.stringify({ type: "session", id: "out", cwd: "/", timestamp: "2026-01-01T00:00:00.000Z" }) + "\n" +
      JSON.stringify({
        type: "message",
        id: "u1",
        message: { role: "user", content: "outside-secret" },
      }) + "\n");
    const link = join(sessionFolder, "escape.jsonl");
    symlinkSync(outside, link);
    const { data } = await search("outside-secret");
    assert.equal(data.results.length, 0);
    const res = await fetch(server.base + "/api/session/export?file=" + encodeURIComponent(link) + "&format=md");
    assert.equal(res.status, 403);
  });

  it("exports markdown and offline HTML with Chinese filenames and no script", async () => {
    const mdRes = await fetch(server.base + "/api/session/export?file=" + encodeURIComponent(keepFile) + "&format=md");
    assert.equal(mdRes.status, 200);
    const mdDispo = mdRes.headers.get("content-disposition") || "";
    assert.match(mdDispo, /attachment/);
    assert.match(mdDispo, /filename\*=UTF-8''/);
    assert.match(decodeURIComponent(mdDispo), /工作备忘|会议纪要|纪要/);
    const md = await mdRes.text();
    assert.match(md, /```js\nconsole\.log\('你好'\)\n```/);
    assert.match(md, /活动分支/);
    const logAfter = existsSync(server.envHome.log) ? readFileSync(server.envHome.log, "utf8") : "";
    assert.equal(logAfter.trim(), "");

    const xssFile = join(sessionFolder, "xss.jsonl");
    const htmlRes = await fetch(server.base + "/api/session/export?file=" + encodeURIComponent(xssFile) + "&format=html");
    assert.equal(htmlRes.status, 200);
    assert.match(htmlRes.headers.get("content-type") || "", /text\/html/);
    const html = await htmlRes.text();
    assert.match(html, /Content-Security-Policy/);
    assert.doesNotMatch(html, /<script>/i);
    assert.doesNotMatch(html, /javascript:/i);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /src=["']https?:/);
    assert.doesNotMatch(html, /url\(["']?https?:/);
  });
});
