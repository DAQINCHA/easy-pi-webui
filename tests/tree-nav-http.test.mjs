import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileFingerprint, parseSessionRecords } from "../lib/tree-nav.js";
import { searchWorkspaceSessions, exportSessionFile, parseSessionEntries, activeBranch } from "../lib/history.js";
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

function sample(id, title, extra = []) {
  return [
    { type: "session", version: 3, id, cwd: "/tmp/ws", timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "session_info", name: title },
    { type: "model_change", id: "mc1", parentId: "", timestamp: "2026-01-01T00:00:00.100Z", provider: "demo", modelId: "demo-1" },
    {
      type: "message",
      id: "u1",
      parentId: "mc1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: "请在 ubuntu 上安装 nginx" },
    },
    {
      type: "message",
      id: "tr1",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:01.500Z",
      message: { role: "toolResult", content: "ran apt" },
    },
    {
      type: "message",
      id: "a1",
      parentId: "tr1",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: { role: "assistant", content: "已经装好了" },
    },
    ...extra,
  ];
}

function commandsOf(logFile) {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8").split(/\n/).filter(Boolean).map((row) => {
    try { return JSON.parse(row); } catch { return {}; }
  });
}

function modelPrompts(logFile) {
  return commandsOf(logFile).filter((row) => row.type === "prompt" && !String(row.message || "").startsWith("/"));
}

function treePrompts(logFile) {
  return commandsOf(logFile).filter((row) => row.type === "prompt" && String(row.message || "").startsWith("/easy-pi-webui-tree"));
}

function sessionFiles(folder) {
  return readdirSync(folder).filter((name) => name.endsWith(".jsonl"));
}

function isolatedSessionDir(server) {
  const previous = process.env.PI_SESSION_DIR;
  process.env.PI_SESSION_DIR = server.envHome.sessions;
  try {
    const folder = sessionsDir(realpathSync(server.workspace));
    mkdirSync(folder, { recursive: true });
    return folder;
  } finally {
    if (previous == null) delete process.env.PI_SESSION_DIR;
    else process.env.PI_SESSION_DIR = previous;
  }
}

async function withSessionEnv(server, fn) {
  const previous = process.env.PI_SESSION_DIR;
  process.env.PI_SESSION_DIR = server.envHome.sessions;
  try {
    return await fn();
  } finally {
    if (previous == null) delete process.env.PI_SESSION_DIR;
    else process.env.PI_SESSION_DIR = previous;
  }
}

describe("tree navigation HTTP", () => {
  async function openAndBranch(server, file, body, headers = {}) {
    const opened = await fetch(server.base + "/api/session/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file }),
    });
    const snapshot = await opened.json().catch(() => ({}));
    assert.equal(opened.status, 200, snapshot.error || "open failed");
    const res = await fetch(server.base + "/api/session/branch", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ file, key: snapshot.key, ...body }),
    });
    const data = await res.json().catch(() => ({}));
    return { res, data, snapshot };
  }

  it("preview does not navigate or change the session file", async () => {
    const server = await startServer();
    try {
      const folder = isolatedSessionDir(server);
      const file = writeJsonl(folder, "preview.jsonl", sample("preview", "预览"));
      const before = fileFingerprint(file);
      const { res, data, snapshot } = await openAndBranch(server, file, { mode: "preview", entryId: "a1", from: "assistant" });
      assert.equal(res.status, 200, data.error);
      assert.equal(data.navigated, false);
      assert.equal(data.sent, false);
      assert.equal(data.prompt.text, "请在 ubuntu 上安装 nginx");
      assert.equal(fileFingerprint(file).hash, before.hash);
      assert.equal(fileFingerprint(file).mtimeMs, before.mtimeMs);
      assert.equal(snapshot.key, "s:preview");
      assert.equal(treePrompts(server.envHome.log).length, 0);
      assert.equal(modelPrompts(server.envHome.log).length, 0);
      assert.equal(sessionFiles(folder).length, 1);
    } finally {
      await server.stop();
    }
  });

  it("retries in the same session, keeps the old branch, and then sends the original request", async () => {
    const server = await startServer();
    try {
      const folder = isolatedSessionDir(server);
      const file = writeJsonl(folder, "retry.jsonl", sample("retry", "重试会话"));
      const before = fileFingerprint(file);
      const { res, data, snapshot } = await openAndBranch(server, file, { mode: "retry", entryId: "a1", from: "assistant" });
      assert.equal(res.status, 200, data.error);
      assert.equal(data.ok, true);
      assert.equal(data.sameSession, true);
      assert.equal(data.navigated, true);
      assert.equal(data.sent, true);
      assert.equal(data.snapshot.key, snapshot.key);
      assert.equal(data.snapshot.sessionFile === file || data.snapshot.sessionFile === realpathSync(file), true);
      assert.match(data.warning, /不会自动回滚/);
      const after = readFileSync(file, "utf8");
      assert.equal(after.includes("已经装好了"), true);
      assert.equal(after.includes("请在 ubuntu 上安装 nginx"), true);
      const parsed = parseSessionRecords(after);
      const newUser = parsed.records.filter((item) => item.type === "message" && item.message && item.message.role === "user").pop();
      assert.ok(newUser);
      assert.equal(newUser.id === "u1", false);
      assert.equal(newUser.parentId, "mc1");
      assert.equal(sessionFiles(folder).filter((name) => name !== "retry.jsonl").length, 0);
      const trees = treePrompts(server.envHome.log);
      const models = modelPrompts(server.envHome.log);
      assert.equal(trees.length, 1);
      assert.match(trees[0].message, /easy-pi-webui-tree u1/);
      assert.equal(models.length, 1);
      assert.equal(models[0].message, "请在 ubuntu 上安装 nginx");
      assert.ok(fileFingerprint(file).hash !== before.hash);

      const cwd = realpathSync(server.workspace);
      const { search, exported } = await withSessionEnv(server, async () => ({
        search: await searchWorkspaceSessions(cwd, "已经装好了"),
        exported: await exportSessionFile(file, cwd, { format: "md" }),
      }));
      // Active branch after retry is the new prompt; the old assistant reply stays in the file but is not on the active path.
      assert.equal(search.results.some((item) => item.file === file || item.file === realpathSync(file)), false);
      assert.match(exported.body, /请在 ubuntu 上安装 nginx/);
      assert.doesNotMatch(exported.body, /已经装好了/);
      const raw = parseSessionEntries(after);
      assert.equal(raw.messages.some((item) => String(item.text || "").includes("已经装好了")), true);
    } finally {
      await server.stop();
    }
  });

  it("edit-send uses the edited text, stays in the same session, and keeps the old reply in the file", async () => {
    const server = await startServer();
    try {
      const folder = isolatedSessionDir(server);
      const file = writeJsonl(folder, "edit.jsonl", sample("edit", "编辑会话"));
      const { res, data, snapshot } = await openAndBranch(server, file, {
        mode: "edit-send",
        entryId: "u1",
        from: "user",
        message: "改写成安装 apache",
      });
      assert.equal(res.status, 200, data.error);
      assert.equal(data.sameSession, true);
      assert.equal(data.snapshot.key, snapshot.key);
      const body = readFileSync(file, "utf8");
      assert.equal(body.includes("已经装好了"), true);
      assert.equal(body.includes("改写成安装 apache"), true);
      const models = modelPrompts(server.envHome.log);
      assert.equal(models.length, 1);
      assert.equal(models[0].message, "改写成安装 apache");
    } finally {
      await server.stop();
    }
  });

  it("preserves images on retry and refuses incomplete attachments", async () => {
    const server = await startServer();
    try {
      const folder = isolatedSessionDir(server);
      const withImage = sample("img", "带图", []);
      withImage[3] = {
        type: "message",
        id: "u1",
        parentId: "mc1",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "user",
          content: [
            { type: "text", text: "看这张图" },
            { type: "image", mimeType: "image/png", data: "QUFB" },
          ],
        },
      };
      const file = writeJsonl(folder, "img.jsonl", withImage);
      const { res, data } = await openAndBranch(server, file, { mode: "retry", entryId: "a1", from: "assistant" });
      assert.equal(res.status, 200, data.error);
      const models = modelPrompts(server.envHome.log);
      assert.equal(models.length, 1);
      assert.equal(models[0].message, "看这张图");
      assert.equal((models[0].images || []).length, 1);
      assert.equal(models[0].images[0].data, "QUFB");

      const incomplete = sample("badimg", "缺图");
      incomplete[3] = {
        type: "message",
        id: "u1",
        parentId: "mc1",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: [{ type: "image", mimeType: "image/png" }] },
      };
      const bad = writeJsonl(folder, "badimg.jsonl", incomplete);
      const failed = await openAndBranch(server, bad, { mode: "retry", entryId: "u1", from: "user" });
      assert.equal(failed.res.status, 400);
      assert.match(failed.data.error, /附件不完整/);
      assert.equal(modelPrompts(server.envHome.log).length, 1);
    } finally {
      await server.stop();
    }
  });

  it("refuses to send a model prompt when the tree command is missing, mis-sourced, errors, or does not move the leaf", async () => {
    async function attempt(env, expectStatus, expectCode) {
      const isolated = await startServer({ env });
      try {
        const folder = isolatedSessionDir(isolated);
        const file = writeJsonl(folder, "blocked.jsonl", sample("blocked", "阻塞"));
        const before = fileFingerprint(file);
        const { res, data } = await openAndBranch(isolated, file, { mode: "retry", entryId: "a1", from: "assistant" });
        assert.equal(res.status, expectStatus, data.error || "status");
        if (expectCode) assert.equal(data.code, expectCode);
        assert.equal(modelPrompts(isolated.envHome.log).length, 0);
        assert.equal(fileFingerprint(file).hash, before.hash);
      } finally {
        await isolated.stop();
      }
    }
    await attempt({ FAKEPI_NO_TREE_COMMAND: "1" }, 503, "tree_command_missing");
    await attempt({ FAKEPI_TREE_SOURCE: "/tmp/other-extension.ts" }, 503, "tree_command_missing");
    await attempt({ FAKEPI_TREE_ERROR: "1" }, 502, "tree_nav_failed");
    await attempt({ FAKEPI_TREE_NOMOVE: "1" }, 502, "tree_nav_failed");
  });

  it("creates an independent alternate session with official fork and does not auto-prompt", async () => {
    const server = await startServer();
    try {
      const folder = isolatedSessionDir(server);
      const file = writeJsonl(folder, "origin.jsonl", sample("origin", "整理会议"));
      const before = fileFingerprint(file);
      const namesBefore = new Set(sessionFiles(folder));
      const { res, data, snapshot } = await openAndBranch(server, file, { mode: "alternate", entryId: "a1", from: "assistant" });
      assert.equal(res.status, 200, data.error);
      assert.equal(data.newSession, true);
      assert.equal(data.sent, false);
      assert.equal(data.draft, "请在 ubuntu 上安装 nginx");
      assert.equal(data.originalUnchanged, true);
      assert.equal(fileFingerprint(file).hash, before.hash);
      assert.notEqual(data.snapshot.key, snapshot.key);
      assert.match(data.snapshot.state.sessionName || "", /另一分支/);
      assert.equal(modelPrompts(server.envHome.log).length, 0);
      const created = sessionFiles(folder).filter((name) => !namesBefore.has(name));
      assert.equal(created.length, 1);
      const newBody = readFileSync(join(folder, created[0]), "utf8");
      assert.equal(newBody.includes("请在 ubuntu 上安装 nginx"), false);
      assert.equal(newBody.includes("已经装好了"), false);
      assert.equal(readFileSync(file, "utf8").includes("已经装好了"), true);
    } finally {
      await server.stop();
    }
  });

  it("rejects untrusted origins, missing entries, reserved chat slashes, and escaping symlinks", async () => {
    const server = await startServer();
    try {
      const folder = isolatedSessionDir(server);
      const file = writeJsonl(folder, "safe.jsonl", sample("safe", "安全"));
      const opened = await fetch(server.base + "/api/session/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file }),
      });
      const snapshot = await opened.json();
      assert.equal(opened.status, 200, snapshot.error);

      const originRes = await fetch(server.base + "/api/session/branch", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: JSON.stringify({ file, key: snapshot.key, mode: "retry", entryId: "a1" }),
      });
      assert.equal(originRes.status, 403);

      const missing = await fetch(server.base + "/api/session/branch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file, key: snapshot.key, mode: "retry", entryId: "nope" }),
      });
      assert.equal(missing.status, 400);

      const reserved = await fetch(server.base + "/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: snapshot.key, message: "/easy-pi-webui-tree u1" }),
      });
      const reservedData = await reserved.json();
      assert.equal(reserved.status, 400);
      assert.equal(reservedData.code, "reserved_command");
      assert.equal(treePrompts(server.envHome.log).length, 0);

      const outside = join(server.envHome.dir, "outside.jsonl");
      writeFileSync(outside, sample("out", "外面").map(line).join("\n") + "\n");
      const link = join(folder, "escape.jsonl");
      try { symlinkSync(outside, link); } catch { /* already */ }
      const escaped = await fetch(server.base + "/api/session/branch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: link, key: snapshot.key, mode: "retry", entryId: "u1" }),
      });
      assert.equal(escaped.status, 403);
    } finally {
      await server.stop();
    }
  });

  it("refuses a live running, compacting, or waiting session without aborting it", async () => {
    async function withServer(extraEnv, filename, title, mode, expect) {
      const isolated = await startServer({ env: extraEnv });
      try {
        const folder = isolatedSessionDir(isolated);
        mkdirSync(folder, { recursive: true });
        const file = writeJsonl(folder, filename, sample(filename.replace(/\.jsonl$/, ""), title));
        const { res, data } = await openAndBranch(isolated, file, { mode, entryId: "a1", from: "assistant" });
        const before = fileFingerprint(file);
        assert.equal(res.status, 409, data.error || "expected busy");
        assert.match(data.error, expect);
        assert.equal(fileFingerprint(file).hash, before.hash);
        assert.equal(modelPrompts(isolated.envHome.log).length, 0);
      } finally {
        await isolated.stop();
      }
    }
    await withServer({ FAKEPI_IS_STREAMING: "1" }, "busy.jsonl", "进行中", "retry", /进行/);
    await withServer({ FAKEPI_IS_COMPACTING: "1" }, "compact.jsonl", "压缩中", "retry", /进行/);
    await withServer({ FAKEPI_PENDING_UI: "1" }, "wait.jsonl", "等确认", "alternate", /确认/);
  });
});
