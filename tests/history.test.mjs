import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  MAX_QUERY_LENGTH,
  activeBranch,
  buildHtmlExport,
  buildMarkdownExport,
  escapeRegExp,
  exportFileName,
  exportSessionFile,
  highlightSnippet,
  listSessionFiles,
  makeExportView,
  makeSearcher,
  normalizeQuery,
  parseSessionEntries,
  resolveSessionFile,
  searchWorkspaceSessions,
  visibleText,
} from "../lib/history.js";
import { sessionsDir } from "../lib/sessions.js";
import { FileAccessError } from "../lib/files.js";

function msg(id, parentId, role, text, extra = {}, ts = "2026-01-01T00:00:00.000Z") {
  return JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: ts,
    message: {
      role,
      content: extra.content || text,
    },
  });
}

function sessionFile(header, infoName, messages) {
  const lines = [];
  if (header !== false) {
    lines.push(JSON.stringify({ type: "session", id: header?.id || "sid", cwd: header?.cwd || "/tmp/ws", timestamp: "2026-01-01T00:00:00.000Z" }));
  }
  if (infoName) lines.push(JSON.stringify({ type: "session_info", name: infoName }));
  for (const line of messages) lines.push(line);
  return lines.join("\n") + "\n";
}

describe("history search helpers", () => {
  it("normalizes whitespace and does not treat the query as a regex", () => {
    assert.equal(normalizeQuery("  你好   世界  "), "你好 世界");
    const searcher = makeSearcher("foo.*bar");
    assert.equal(searcher.test("fooXbar"), false);
    assert.equal(searcher.test("prefix foo.*bar suffix"), true);
    assert.equal(escapeRegExp("a+b?c"), "a\\+b\\?c");
    assert.equal(makeSearcher("Hello").test("say hello now"), true);
    assert.equal(makeSearcher("你好  世界").test("说：你好\n世界。"), true);
  });

  it("rejects an overly long query", () => {
    assert.throws(() => makeSearcher("汉".repeat(MAX_QUERY_LENGTH + 1)), FileAccessError);
  });

  it("extracts only visible user/assistant text, not thinking, tools, or images", () => {
    const text = visibleText({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "不要搜到的思考 SK-SECRET" },
        { type: "text", text: "可见回复" },
        { type: "toolCall", name: "bash", arguments: { command: "cat ~/.ssh/id_rsa" } },
        { type: "image", mimeType: "image/png", data: "AAAA" },
      ],
    });
    assert.equal(text, "可见回复");
    assert.doesNotMatch(text, /SK-SECRET|id_rsa|AAAA/);
  });

  it("keeps only the latest activity branch", () => {
    const parsed = parseSessionEntries(sessionFile({ id: "s1" }, "分支", [
      msg("u1", "", "user", "第一问", {}, "2026-01-01T00:00:00.000Z"),
      msg("a1", "u1", "assistant", "被放弃的回答", {}, "2026-01-01T00:00:01.000Z"),
      msg("a2", "u1", "assistant", "采用的回答", {}, "2026-01-01T00:00:02.000Z"),
    ]));
    const branch = activeBranch(parsed.messages);
    assert.deepEqual(branch.map((item) => item.text), ["第一问", "采用的回答"]);
  });

  it("uses the last file entry as the default leaf, and an explicit live leafId when provided", () => {
    const parsed = parseSessionEntries(sessionFile({ id: "s1" }, "分支", [
      msg("u1", "", "user", "第一问", {}, "2026-01-01T00:00:00.000Z"),
      msg("a2", "u1", "assistant", "后写入的回答", {}, "2026-01-01T00:00:02.000Z"),
      msg("a1", "u1", "assistant", "如果按时间会赢但写在后面", {}, "2026-01-01T00:00:03.000Z"),
    ]));
    const byFile = activeBranch(parsed.messages);
    assert.deepEqual(byFile.map((item) => item.text), ["第一问", "如果按时间会赢但写在后面"]);
    const live = activeBranch(parsed.messages, { leafId: "a2" });
    assert.deepEqual(live.map((item) => item.text), ["第一问", "后写入的回答"]);
  });

  it("walks through toolResult and control events so earlier visible text stays searchable", () => {
    const lines = [
      JSON.stringify({ type: "session", id: "s0", cwd: "/tmp/ws", timestamp: "2026-01-01T00:00:00.000Z" }),
      JSON.stringify({ type: "model_change", id: "mc", parentId: "s0", timestamp: "2026-01-01T00:00:01.000Z", modelId: "x" }),
      JSON.stringify({ type: "thinking_level_change", id: "tl", parentId: "mc", timestamp: "2026-01-01T00:00:02.000Z", thinkingLevel: "off" }),
      JSON.stringify({
        type: "message",
        id: "sys",
        parentId: "tl",
        timestamp: "2026-01-01T00:00:03.000Z",
        message: { role: "system", content: "system-only-token" },
      }),
      JSON.stringify({
        type: "message",
        id: "u1",
        parentId: "sys",
        timestamp: "2026-01-01T00:00:04.000Z",
        message: { role: "user", content: "请看一下环境" },
      }),
      JSON.stringify({
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-01-01T00:00:05.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "thinking-only-token" },
            { type: "toolCall", name: "bash", arguments: { command: "tool-args-token" } },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "r1",
        parentId: "a1",
        timestamp: "2026-01-01T00:00:06.000Z",
        message: { role: "toolResult", content: [{ type: "text", text: "tool-result-token" }] },
      }),
      JSON.stringify({
        type: "message",
        id: "a2",
        parentId: "r1",
        timestamp: "2026-01-01T00:00:07.000Z",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "..." }, { type: "text", text: "可见回复里的 visible-chain-token" }],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "a3",
        parentId: "a2",
        timestamp: "2026-01-01T00:00:08.000Z",
        message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "echo later" } }] },
      }),
    ].join("\n");
    const parsed = parseSessionEntries(lines);
    const branch = activeBranch(parsed.messages);
    const visible = branch.filter((item) => item.role === "user" || item.role === "assistant").map((item) => item.text);
    assert.ok(visible.some((text) => text.includes("visible-chain-token")));
    assert.ok(visible.some((text) => text.includes("请看一下环境")));
    assert.equal(visible.some((text) => text.includes("tool-result-token")), false);
    const md = buildMarkdownExport(makeExportView(parsed));
    assert.match(md, /visible-chain-token/);
    assert.match(md, /请看一下环境/);
    assert.doesNotMatch(md, /tool-result-token/);
    assert.doesNotMatch(md, /thinking-only-token/);
  });

  it("skips broken JSONL lines and still reads later messages", () => {
    const parsed = parseSessionEntries(
      '{"type":"session","id":"ok","cwd":"/tmp","timestamp":"2026-01-01T00:00:00.000Z"}\n' +
        "{not json\n" +
        msg("u1", "", "user", "还在") + "\n",
    );
    assert.equal(parsed.skippedBad, 1);
    assert.equal(parsed.messages[0].text, "还在");
  });

  it("highlights matches after escaping HTML", () => {
    const searcher = makeSearcher("hi");
    const html = highlightSnippet('<img alt="hi">', searcher);
    assert.match(html, /&lt;img alt=&quot;<mark>hi<\/mark>&quot;&gt;/);
    assert.doesNotMatch(html, /<img/);
  });
});

describe("history search over isolated session files", () => {
  let dir;
  let workspace;
  const previous = process.env.PI_SESSION_DIR;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "easy-pi-history-"));
    workspace = join(dir, "ws");
    mkdirSync(workspace);
    process.env.PI_SESSION_DIR = join(dir, "sessions");
    mkdirSync(sessionsDir(workspace), { recursive: true });
  });

  after(() => {
    if (previous === undefined) delete process.env.PI_SESSION_DIR;
    else process.env.PI_SESSION_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSession(name, body) {
    const file = join(sessionsDir(workspace), name);
    writeFileSync(file, body);
    return file;
  }

  it("finds body and title hits, including Chinese, and reports no results honestly", async () => {
    const bodyFile = writeSession("body.jsonl", sessionFile({ id: "body" }, "普通标题", [
      msg("u1", "", "user", "请写一份季度报告"),
      msg("a1", "u1", "assistant", "这是可见的中文正文"),
    ]));
    writeSession("title.jsonl", sessionFile({ id: "title" }, "项目备忘录", [
      msg("u1", "", "user", "随便聊聊"),
    ]));
    writeSession("miss.jsonl", sessionFile({ id: "miss" }, "无关", [
      msg("u1", "", "user", "天气不错"),
    ]));

    const bodyHits = await searchWorkspaceSessions(workspace, "中文正文");
    assert.equal(bodyHits.results.length, 1);
    assert.equal(bodyHits.results[0].file, bodyFile);
    assert.equal(bodyHits.results[0].match, "body");
    assert.match(bodyHits.results[0].snippet, /中文正文/);
    assert.equal(bodyHits.truncated, false);
    assert.equal(bodyHits.scanned, 3);

    const titleHits = await searchWorkspaceSessions(workspace, "备忘录");
    assert.equal(titleHits.results[0].match, "title");

    const none = await searchWorkspaceSessions(workspace, "根本没有这句话");
    assert.equal(none.results.length, 0);
    assert.equal(none.total, 3);
  });

  it("finds visible text earlier in a toolResult parent chain, and ignores tool/system tokens", async () => {
    const file = writeSession("chain.jsonl", [
      JSON.stringify({ type: "session", id: "s0", cwd: "/tmp/ws", timestamp: "2026-01-01T00:00:00.000Z" }),
      JSON.stringify({ type: "model_change", id: "mc", parentId: "s0", timestamp: "2026-01-01T00:00:01.000Z", modelId: "x" }),
      JSON.stringify({
        type: "message",
        id: "sys",
        parentId: "mc",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: { role: "system", content: "system-only-token" },
      }),
      msg("u1", "sys", "user", "请看一下环境", {}, "2026-01-01T00:00:03.000Z"),
      JSON.stringify({
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-01-01T00:00:04.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "thinking-only-token" },
            { type: "toolCall", name: "bash", arguments: { command: "tool-args-token" } },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "r1",
        parentId: "a1",
        timestamp: "2026-01-01T00:00:05.000Z",
        message: { role: "toolResult", content: [{ type: "text", text: "tool-result-token" }] },
      }),
      JSON.stringify({
        type: "message",
        id: "a2",
        parentId: "r1",
        timestamp: "2026-01-01T00:00:06.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "可见回复里的 visible-chain-token" }] },
      }),
      JSON.stringify({
        type: "message",
        id: "a3",
        parentId: "a2",
        timestamp: "2026-01-01T00:00:07.000Z",
        message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "echo later" } }] },
      }),
    ].join("\n") + "\n");

    const visible = await searchWorkspaceSessions(workspace, "visible-chain-token");
    assert.equal(visible.results.some((item) => item.file === file), true);
    assert.equal((await searchWorkspaceSessions(workspace, "tool-result-token")).results.some((item) => item.file === file), false);
    assert.equal((await searchWorkspaceSessions(workspace, "thinking-only-token")).results.some((item) => item.file === file), false);
    assert.equal((await searchWorkspaceSessions(workspace, "tool-args-token")).results.some((item) => item.file === file), false);
    assert.equal((await searchWorkspaceSessions(workspace, "system-only-token")).results.some((item) => item.file === file), false);
  });

  it("does not search abandoned branches, thinking, or tool payloads", async () => {
    writeSession("secret.jsonl", sessionFile({ id: "secret" }, "安全", [
      msg("u1", "", "user", "请问一下"),
      JSON.stringify({
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hidden-thought-token" },
            { type: "toolCall", name: "bash", arguments: { command: "tool-secret-payload" } },
            { type: "text", text: "公开回答" },
          ],
        },
      }),
      msg("a2", "u1", "assistant", "活动分支没有秘密", {}, "2026-01-01T00:00:02.000Z"),
    ]));

    const hidden = await searchWorkspaceSessions(workspace, "hidden-thought-token");
    assert.equal(hidden.results.some((item) => item.file.endsWith("secret.jsonl")), false);
    const tools = await searchWorkspaceSessions(workspace, "tool-secret-payload");
    assert.equal(tools.results.some((item) => item.file.endsWith("secret.jsonl")), false);
    const kept = await searchWorkspaceSessions(workspace, "活动分支没有秘密");
    assert.equal(kept.results.some((item) => item.file.endsWith("secret.jsonl")), true);
  });

  it("scans more than the default 80-session list and reports truncation", async () => {
    const unique = "zebra-unique-phrase";
    // 90 older dummies + 1 unique oldest file, so listSessions(limit 80) would miss it if we only used that list.
    for (let i = 0; i < 90; i += 1) {
      writeSession("old-" + String(i).padStart(3, "0") + ".jsonl", sessionFile({ id: "old" + i }, "旧会话" + i, [
        msg("u1", "", "user", "占位内容 " + i),
      ]));
    }
    writeSession("zzz-unique.jsonl", sessionFile({ id: "unique" }, "深藏", [
      msg("u1", "", "user", unique),
    ]));
    // make unique older by... search lists all files regardless of 80. Just assert it is found among >80 files.
    const hits = await searchWorkspaceSessions(workspace, unique);
    assert.ok(hits.total > 80);
    assert.equal(hits.results.some((item) => item.snippet.includes(unique) || item.quote.includes(unique)), true);

    const cap = await searchWorkspaceSessions(workspace, "占位内容", { maxResults: 3 });
    assert.equal(cap.results.length, 3);
    assert.equal(cap.truncated, true);
  });

  it("labels archived sessions in results and does not hide them by default", async () => {
    const file = writeSession("archived-one.jsonl", sessionFile({ id: "arch" }, "归档备忘", [
      msg("u1", "", "user", "这是归档里的独特句子 blueberry-9"),
    ]));
    const hits = await searchWorkspaceSessions(workspace, "blueberry-9", { archive: { [file]: "now" } });
    assert.equal(hits.results.length, 1);
    assert.equal(hits.results[0].archived, true);
    assert.equal(hits.results[0].file, file);
  });

  it("rejects path traversal and escaping symlinks", async () => {
    const outside = join(dir, "outside.jsonl");
    writeFileSync(outside, sessionFile({ id: "out" }, "外面", [msg("u1", "", "user", "leak-outside")]));
    const link = join(sessionsDir(workspace), "escape.jsonl");
    symlinkSync(outside, link);

    const listed = listSessionFiles(workspace);
    assert.equal(listed.some((item) => item.file.endsWith("escape.jsonl")), false);

    assert.throws(() => resolveSessionFile(outside, workspace), FileAccessError);
    assert.throws(() => resolveSessionFile(join(sessionsDir(workspace), "../outside.jsonl"), workspace), FileAccessError);
    assert.throws(() => resolveSessionFile(link, workspace), FileAccessError);

    const hits = await searchWorkspaceSessions(workspace, "leak-outside");
    assert.equal(hits.results.length, 0);
  });
});

describe("history export", () => {
  it("writes markdown that keeps code and explains scope, without hidden reasoning", () => {
    const parsed = parseSessionEntries(sessionFile({ id: "ex" }, "导出示例", [
      msg("u1", "", "user", "请给示例：\n\n```js\nconsole.log('你好')\n```"),
      JSON.stringify({
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hidden-reasoning" },
            { type: "text", text: "这是回答，含 [本地](./secret.md) 和 [接口](/api/file?path=/tmp/a)。" },
            { type: "toolCall", name: "bash", arguments: { command: "cat /etc/passwd" } },
          ],
        },
      }),
    ]));
    const view = makeExportView(parsed);
    const md = buildMarkdownExport(view);
    assert.match(md, /```js\nconsole\.log\('你好'\)\n```/);
    assert.match(md, /活动分支/);
    assert.match(md, /本地文件路径离线无法打开/);
    assert.match(md, /页面接口链接已去掉/);
    assert.doesNotMatch(md, /hidden-reasoning/);
    assert.doesNotMatch(md, /\/etc\/passwd/);
    assert.doesNotMatch(md, /\/api\/file\?path=/);
  });

  it("writes self-contained HTML, escapes XSS, and strips active script links", () => {
    const evilTitle = '<img src=x onerror=alert(1)>';
    const parsed = parseSessionEntries(sessionFile({ id: "xss" }, evilTitle, [
      msg("u1", "", "user", '点击 [这里](javascript:alert(1)) 和 <script>alert(2)</script>'),
    ]));
    const view = makeExportView(parsed, { generatedAt: "2026-11-12T05:00:00.000Z" });
    const html = buildHtmlExport(view);
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /script-src 'none'/);
    assert.doesNotMatch(html, /https?:\/\/[^\s"']+\.(css|js|woff2?)/);
    assert.doesNotMatch(html, /<script>/i);
    assert.doesNotMatch(html, /<img[^>]*\sonerror=/i);
    assert.doesNotMatch(html, /href=["']javascript:/i);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&lt;img src=x/);
    assert.doesNotMatch(html, /src=["']https?:/);
    const empty = buildMarkdownExport(makeExportView(parseSessionEntries(sessionFile({ id: "empty" }, "空会话", []))));
    assert.match(empty, /还没有可见的对话正文/);
    const streaming = buildMarkdownExport(makeExportView(parsed, { streaming: true }));
    assert.match(streaming, /对话还在进行/);
  });

  it("builds a Chinese-friendly download name", () => {
    const name = exportFileName("季度报告", "md");
    assert.match(name, /季度报告-20\d{2}-\d{2}-\d{2}\.md/);
  });
});
