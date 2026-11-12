import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { searchWorkspaceSessions } from "../lib/history.js";
import { listSessions, sessionsDir, visibleSessionTitle } from "../lib/sessions.js";
import { ALTERNATE_SUFFIX, branchTitle } from "../lib/tree-nav.js";
import { startServer } from "./helpers/harness.mjs";

const STAMP = "2026-01-01T00:00:00.000Z";

function header(id = "sid") {
  return { type: "session", version: 3, id, cwd: "/tmp/ws", timestamp: STAMP };
}

function message(id, parentId, role, content, seconds = 1) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(Date.parse(STAMP) + seconds * 1000).toISOString(),
    message: { role, content },
  };
}

function info(name, id = "info", parentId = "") {
  return { type: "session_info", id, parentId, timestamp: STAMP, name };
}

function filler(start, count, parentId = "", bytes = 1800) {
  const rows = [];
  const text = "填充内容".repeat(Math.ceil(bytes / 4));
  let parent = parentId;
  for (let i = 0; i < count; i += 1) {
    const id = "f" + (start + i);
    rows.push(message(id, parent, "assistant", text + i, start + i));
    parent = id;
  }
  return rows;
}

function writeSession(file, rows) {
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

function appendSession(file, rows) {
  appendFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

const SCAN_CHUNK = 64 * 1024;

/** A message row whose JSON line (plus newline) is exactly `bytes` bytes long. */
function padRow(bytes, id = "pad", parentId = "") {
  const base = Buffer.byteLength(JSON.stringify(message(id, parentId, "assistant", "", 1)) + "\n");
  const extra = bytes - base;
  assert.ok(extra >= 0, "padding target too small: " + bytes);
  return message(id, parentId, "assistant", "x".repeat(extra), 1);
}

function infoLine(name, id, parentId) {
  return JSON.stringify(info(name, id, parentId)) + "\n";
}

/** Bytes of a session_info line before the first byte of its name value. */
function nameOffset(id, parentId) {
  return Buffer.byteLength(JSON.stringify(info("", id, parentId))) - 2;
}

/**
 * Append a session_info line whose first title byte sits one byte before
 * `boundary`, so its first (3-byte) character is split by a 64 KB read.
 */
function appendTitleAcrossBoundary(file, boundary, id, parentId, name) {
  const lineStart = boundary - 1 - nameOffset(id, parentId);
  appendFileSync(file, JSON.stringify(padRow(lineStart - statSync(file).size, "pad-" + id, parentId)) + "\n");
  assert.equal(statSync(file).size, lineStart);
  appendFileSync(file, infoLine(name, id, parentId));
}

/** Consume /api/events until a record of `type` arrives, then resolve. */
function watchEvent(base, key, type, { timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let markReady;
  const ready = new Promise((resolve) => { markReady = resolve; });
  const done = (async () => {
    const res = await fetch(base + "/api/events?key=" + encodeURIComponent(key), {
      signal: controller.signal,
      headers: { accept: "text/event-stream" },
    });
    assert.equal(res.status, 200);
    markReady();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done: ended } = await reader.read();
        if (ended) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const data = block.split("\n").find((line) => line.startsWith("data: "));
          if (!data) continue;
          let record;
          try { record = JSON.parse(data.slice(6)); } catch { continue; }
          if (record && record.type === type) return record;
        }
      }
    } catch (error) {
      throw new Error("event stream interrupted before " + type + ": " + error.message);
    }
    throw new Error("event stream closed before " + type);
  })();
  return {
    ready,
    done,
    close() {
      clearTimeout(timer);
      controller.abort();
    },
  };
}

function deepSession({ name = "自动生成的标题", manual = "" } = {}) {
  const rows = [header()];
  // The auto title is appended after the first turn, so it is already beyond
  // scanHead's 16-line window in real sessions.
  for (let i = 0; i < 20; i += 1) {
    rows.push(message("pre" + i, i ? "pre" + (i - 1) : "", i % 2 ? "assistant" : "user", "前期内容 " + i, i + 1));
  }
  rows.push(info(name, "info", "pre19"));
  // Push the title well beyond the 128 KB tail window as the conversation grows.
  rows.push(...filler(0, 200, "info"));
  if (manual) {
    rows.push(info(manual, "manual", "f199"));
    rows.push(...filler(1000, 200, "manual"));
  }
  return rows;
}

describe("session sidebar title source", () => {
  let dir;
  let workspace;
  const previous = process.env.PI_SESSION_DIR;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "easy-pi-session-title-"));
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

  const listedName = (file) => {
    const meta = listSessions(workspace).find((item) => item.file === file);
    assert.ok(meta, "session file missing from list: " + file);
    return meta.name;
  };

  it("finds an auto title after the head/tail preview windows and keeps branch suffixes", () => {
    const file = join(sessionsDir(workspace), "deep-auto.jsonl");
    writeSession(file, deepSession());

    const meta = listSessions(workspace).find((item) => item.file === file);
    assert.ok(meta);
    assert.equal(meta.name, "自动生成的标题");
    assert.equal(meta.title, "前期内容 0");
    assert.equal(visibleSessionTitle(file), "自动生成的标题");
    assert.equal(branchTitle(visibleSessionTitle(file), ALTERNATE_SUFFIX), "自动生成的标题 · 另一分支");
  });

  it("uses the latest manual name over an older auto title, including after more growth", () => {
    const file = join(sessionsDir(workspace), "deep-manual.jsonl");
    writeSession(file, deepSession({ name: "自动旧名", manual: "手动新名" }));

    let meta = listSessions(workspace).find((item) => item.file === file);
    assert.equal(meta.name, "手动新名");
    assert.equal(visibleSessionTitle(file), "手动新名");

    // Simulate a running session: the cached scan must pick up an appended
    // rename even when that line is no longer inside the tail window.
    appendSession(file, [info("再次改名", "manual-2", "f1199"), ...filler(2000, 200, "manual-2")]);
    meta = listSessions(workspace).find((item) => item.file === file);
    assert.equal(meta.name, "再次改名");
    assert.equal(visibleSessionTitle(file), "再次改名");
  });

  it("re-reads a session file that was atomically replaced by a larger one", () => {
    const file = join(sessionsDir(workspace), "replaced.jsonl");
    writeSession(file, deepSession({ name: "替换前标题" }));
    assert.equal(listedName(file), "替换前标题");

    // Same path, new inode, larger content. The new title sits near the top of
    // the file: before the previous scan watermark and outside the tail window.
    const replacement = join(sessionsDir(workspace), "replaced.tmp");
    const rows = deepSession({ name: "替换前标题" });
    rows[21] = info("替换后标题", "replaced", "pre19");
    rows.push(...filler(500, 100, "f199"));
    writeSession(replacement, rows);
    assert.ok(statSync(replacement).size > statSync(file).size);
    renameSync(replacement, file);

    assert.equal(listedName(file), "替换后标题");
    assert.equal(visibleSessionTitle(file), "替换后标题");
  });

  it("resumes a session_info line written in pieces without a stale title", () => {
    // Growth path: the cached watermark is a line boundary, so the completion
    // is scanned even though it lands beyond the tail window.
    const grown = join(sessionsDir(workspace), "pieces-grown.jsonl");
    writeSession(grown, deepSession({ name: "分段前标题" }));
    assert.equal(listedName(grown), "分段前标题");
    const line = infoLine("分段完成的标题", "pieces", "f199");
    const cut = Math.floor(line.length / 2);
    appendFileSync(grown, line.slice(0, cut));
    assert.equal(listedName(grown), "分段前标题");
    appendFileSync(grown, line.slice(cut));
    appendSession(grown, filler(300, 120, "pieces"));
    assert.equal(listedName(grown), "分段完成的标题");
    assert.equal(listedName(grown), "分段完成的标题");

    // Tail path: the file ends mid-line, and the completion only leaves the
    // 128 KB tail window once more content is appended after it.
    const tailed = join(sessionsDir(workspace), "pieces-tail.jsonl");
    const rows = [header("pieces-tail")];
    for (let i = 0; i < 20; i += 1) {
      rows.push(message("pre" + i, i ? "pre" + (i - 1) : "", i % 2 ? "assistant" : "user", "前期内容 " + i, i + 1));
    }
    rows.push(info("尾部旧标题", "i0", "pre19"));
    rows.push(...filler(0, 20, "i0"));
    writeSession(tailed, rows);
    assert.equal(listedName(tailed), "尾部旧标题");
    const tailLine = infoLine("尾部补全的标题", "i1", "f19");
    appendFileSync(tailed, tailLine.slice(0, 10));
    assert.equal(listedName(tailed), "尾部旧标题");
    appendFileSync(tailed, tailLine.slice(10));
    appendSession(tailed, filler(100, 120, "i1"));
    assert.equal(listedName(tailed), "尾部补全的标题");
    assert.equal(listedName(tailed), "尾部补全的标题");
  });

  it("reads a multibyte title split by a 64 KB scan boundary", () => {
    const file = join(sessionsDir(workspace), "chunk-boundary.jsonl");
    const title = "边".repeat(30) + "跨边界标题";
    writeSession(file, [header("boundary")]);
    // Full scan from offset 0: the title straddles the 64 KB read boundary.
    appendTitleAcrossBoundary(file, SCAN_CHUNK, "i1", "", title);
    appendSession(file, filler(0, 80, "i1")); // push it out of the 128 KB tail window
    assert.equal(listedName(file), title);

    // Appended scan from the cached watermark: same boundary, new chunk origin.
    const appendedTitle = "界".repeat(30) + "追加跨边界标题";
    const watermark = statSync(file).size;
    appendTitleAcrossBoundary(file, watermark + SCAN_CHUNK, "i2", "f79", appendedTitle);
    appendSession(file, filler(100, 80, "i2"));
    assert.equal(listedName(file), appendedTitle);
    assert.equal(listedName(file), appendedTitle);
  });

  it("keeps the unnamed first-message fallback and the new-session placeholder", () => {
    const unnamed = join(sessionsDir(workspace), "unnamed.jsonl");
    writeSession(unnamed, [
      header("unnamed"),
      ...Array.from({ length: 20 }, (_, i) =>
        message("u" + i, i ? "u" + (i - 1) : "", i === 0 ? "user" : "assistant", i === 0 ? "第一条用户消息" : "回复 " + i, i + 1),
      ),
    ]);
    const unnamedMeta = listSessions(workspace).find((item) => item.file === unnamed);
    assert.equal(unnamedMeta.name, "");
    assert.equal(unnamedMeta.title, "第一条用户消息");
    assert.equal(visibleSessionTitle(unnamed), "第一条用户消息");

    const empty = join(sessionsDir(workspace), "empty.jsonl");
    writeSession(empty, [header("empty")]);
    const emptyMeta = listSessions(workspace).find((item) => item.file === empty);
    assert.equal(emptyMeta.name, "");
    assert.equal(emptyMeta.title, "新会话");
    assert.equal(visibleSessionTitle(empty), "");
  });

  it("uses the same persisted name for sidebar list and search labels", async () => {
    const file = join(sessionsDir(workspace), "search-name.jsonl");
    writeSession(file, deepSession({ name: "可搜索的自动标题" }));

    const byTitle = await searchWorkspaceSessions(workspace, "可搜索的自动标题");
    const titleHit = byTitle.results.find((item) => item.file === file);
    assert.ok(titleHit);
    assert.equal(titleHit.match, "title");
    assert.equal(titleHit.name, "可搜索的自动标题");
    assert.equal(titleHit.title, "前期内容 0");

    const byBody = await searchWorkspaceSessions(workspace, "填充内容");
    const bodyHit = byBody.results.find((item) => item.file === file);
    assert.ok(bodyHit);
    assert.equal(bodyHit.name, "可搜索的自动标题");
  });

  it("invalidates the list cache on session_info_changed before the rename response", async () => {
    // fake-pi emits session_info_changed before replying, and holds the reply
    // back long enough that the list below cannot be saved by that response.
    const server = await startServer({ env: { FAKEPI_SET_NAME_DELAY_MS: "1500" } });
    const previousSessionDir = process.env.PI_SESSION_DIR;
    let watcher;
    try {
      process.env.PI_SESSION_DIR = server.envHome.sessions;
      const folder = sessionsDir(realpathSync(server.workspace));
      mkdirSync(folder, { recursive: true });
      const file = join(folder, "running.jsonl");
      writeSession(file, [
        header("running"),
        ...Array.from({ length: 20 }, (_, i) =>
          message("r" + i, i ? "r" + (i - 1) : "", i === 0 ? "user" : "assistant", i === 0 ? "正在运行的第一条消息" : "回复 " + i, i + 1),
        ),
      ]);

      const opened = await fetch(server.base + "/api/session/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file }),
      });
      const snapshot = await opened.json();
      assert.equal(opened.status, 200, snapshot.error);
      assert.equal(snapshot.state.sessionName || "", "");

      // Warm the 2.5s list cache with the unnamed session.
      const before = await fetch(server.base + "/api/sessions").then((res) => res.json());
      assert.equal(before.sessions.find((item) => item.file === file).name, "");

      watcher = watchEvent(server.base, snapshot.key, "session_info_changed");
      await watcher.ready;

      const renamePromise = fetch(server.base + "/api/rename", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: snapshot.key, name: "运行中的自动标题" }),
      });
      // Synchronise on the event itself instead of guessing a delay: the list
      // request below runs while the rename response is still pending, so it can
      // only be correct if the event already invalidated the cache.
      const event = await watcher.done;
      assert.equal(event.name, "运行中的自动标题");

      const during = await fetch(server.base + "/api/sessions").then((res) => res.json());
      assert.equal(during.sessions.find((item) => item.file === file).name, "运行中的自动标题");

      const renamed = await renamePromise;
      assert.equal(renamed.status, 200);
      const after = await fetch(server.base + "/api/sessions").then((res) => res.json());
      assert.equal(after.sessions.find((item) => item.file === file).name, "运行中的自动标题");
    } finally {
      watcher?.close();
      if (previousSessionDir === undefined) delete process.env.PI_SESSION_DIR;
      else process.env.PI_SESSION_DIR = previousSessionDir;
      await server.stop();
    }
  });
});
