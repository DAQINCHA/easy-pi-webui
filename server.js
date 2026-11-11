import { createServer } from "node:http";
import { accessSync, constants as fsConstants, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { execFile, execFileSync, spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PiBridge, buildEnv } from "./lib/pi-bridge.js";
import { listSessions, isSessionFile, sessionsDir, sessionRoot, messageText } from "./lib/sessions.js";
import { serveStatic } from "./lib/static.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "public");
const DATA_DIR = join(HERE, "data");
const ARCHIVE_FILE = join(DATA_DIR, "archived.json");

function readFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [name, inline] = arg.slice(2).split("=");
    if (inline !== undefined) out[name] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[name] = argv[++i];
    else out[name] = true;
  }
  return out;
}

const flags = readFlags(process.argv.slice(2));
const INITIAL_WORKSPACE = resolve(flags.workspace || process.env.PI_WORKSPACE || process.cwd());
let workspace = INITIAL_WORKSPACE;
const PORT = Number(flags.port || process.env.PORT || process.env.PI_WEBUI_PORT || 30142);
const HOST = flags.host || process.env.HOST || "127.0.0.1";

/** @type {Map<string, PiBridge>} */
const bridges = new Map();
const statusClients = new Set();
const sessionRuntime = new Map();
let piVersion = null;
let sessionCache = { at: 0, list: [] };

const ALLOWED_COMMANDS = new Set([
  "get_state",
  "get_messages",
  "get_session_stats",
  "get_available_models",
  "get_available_thinking_levels",
  "get_commands",
  "set_model",
  "set_thinking_level",
  "set_session_name",
  "compact",
  "clear_queue",
  "steer",
  "follow_up",
]);

function log(...args) {
  console.log("[pi-webui]", ...args);
}

function piVersionString() {
  if (piVersion) return piVersion;
  try {
    piVersion = execFileSync(process.env.PI_BIN || "pi", ["--version"], {
      encoding: "utf8",
      timeout: 8000,
    }).trim();
  } catch {
    piVersion = "unknown";
  }
  return piVersion;
}

function readArchive() {
  try {
    const parsed = JSON.parse(readFileSync(ARCHIVE_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeArchive(map) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(ARCHIVE_FILE, JSON.stringify(map, null, 2), "utf8");
  } catch (error) {
    log("archive write failed:", error.message);
  }
}

function getSessions() {
  const now = Date.now();
  if (now - sessionCache.at < 2500) return sessionCache.list;
  const archive = readArchive();
  const list = listSessions(workspace).map((session) => ({
    ...session,
    archived: Boolean(archive[session.file]),
  }));
  sessionCache = { at: now, list };
  return list;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        rejectPromise(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        rejectPromise(new Error("invalid JSON body"));
      }
    });
    req.on("error", rejectPromise);
  });
}

function broadcast(bridge, record, seq) {
  const payload = "id: " + seq + "\nevent: pi\ndata: " + JSON.stringify(record) + "\n\n";
  for (const res of bridge.clients) {
    try {
      res.write(payload);
    } catch {
      bridge.clients.delete(res);
    }
  }
}

function statusId(bridge) {
  return bridge.key && bridge.key.startsWith("s:") ? bridge.key.slice(2) : null;
}

function statusSnapshot() {
  const statuses = {};
  for (const [id, item] of sessionRuntime) {
    statuses[id] = {
      running: item.running,
      unread: !item.running && item.finishedAt > item.seenAt,
    };
  }
  return statuses;
}

function broadcastStatus() {
  if (!statusClients.size) return;
  const payload = "event: status\ndata: " + JSON.stringify({ statuses: statusSnapshot() }) + "\n\n";
  for (const res of statusClients) {
    try {
      res.write(payload);
    } catch {
      statusClients.delete(res);
    }
  }
}

function setRunning(bridge, running, finished = true) {
  const id = statusId(bridge);
  if (!id) return;
  const item = sessionRuntime.get(id) || { running: false, finishedAt: 0, seenAt: 0 };
  item.running = Boolean(running);
  if (!running && finished) item.finishedAt = Date.now();
  sessionRuntime.set(id, item);
  broadcastStatus();
}

function wire(bridge) {
  bridge.clients = new Set();
  bridge.pendingUi = new Map();
  bridge.streaming = false;

  bridge.on("record", ({ seq, record }) => {
    if (record.type === "agent_start") {
      bridge.streaming = true;
      setRunning(bridge, true);
    }
    if (record.type === "agent_settled") {
      bridge.streaming = false;
      setRunning(bridge, false);
    }

    if (record.type === "extension_ui_request") {
      const dialog = ["select", "confirm", "input", "editor"].includes(record.method);
      if (dialog) bridge.pendingUi.set(record.id, record);
    }
    broadcast(bridge, record, seq);

    if (record.type === "agent_settled") {
      const timer = setTimeout(() => {
        maybeAutoName(bridge).catch(() => {});
      }, 500);
      timer.unref?.();
    }
  });

  bridge.on("exit", ({ code, signal, intentional }) => {
    bridge.streaming = false;
    setRunning(bridge, false, false);
    broadcast(
      bridge,
      { type: "bridge_exit", code: code ?? null, signal: signal ?? null, intentional: Boolean(intentional) },
      ++bridge.seq,
    );
  });
}

async function command(bridge, payload, timeout) {
  const response = await bridge.send(payload, timeout);
  if (!response.success) throw new Error(response.error || "pi command failed");
  return response;
}

const AUTO_TITLE_DISABLED = /^(0|off|false|no)$/i.test(String(process.env.PI_AUTO_TITLE || ""));

function clip(value, limit) {
  const text = String(value || "");
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

function cleanTitle(raw) {
  const lines = String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const line = lines[0] || "";
  let title = line
    .replace(/^#{1,6}\s*/, "")
    .replace(/^好的[，,、]?\s*/, "")
    .replace(/^(会话)?标题\s*[:：]\s*/, "")
    .replace(/^["'“”‘’`「」]+|["'“”‘’`「」]+$/g, "")
    .replace(/[。.!！?？,，;；:：\s]+$/, "")
    .trim();
  if (!title) return "";
  const chars = Array.from(title);
  return chars.length > 24 ? chars.slice(0, 24).join("") : title;
}

function generateTitle(userText, assistantText, cwd = workspace) {
  return new Promise((resolveTitle) => {
    const prompt = [
      "给下面这段对话起一个简短标题。",
      "要求：6 到 12 个汉字（英文不超过 40 个字符），只输出标题本身，不要引号、不要标点结尾、不要解释。",
      "",
      "用户：" + clip(userText, 700),
      assistantText ? "助手：" + clip(assistantText, 700) : "",
    ].join("\n");

    const args = [
      "--print",
      "--no-session",
      "--no-tools",
      "--no-extensions",
      "--no-context-files",
    ];
    if (process.env.PI_TITLE_MODEL) args.push("--model", process.env.PI_TITLE_MODEL);
    args.push("--", prompt);

    let child;
    try {
      child = spawn(process.env.PI_BIN || "pi", args, {
        cwd,
        env: buildEnv(),
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolveTitle("");
      return;
    }

    let output = "";
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveTitle(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      done("");
    }, 25000);
    timer.unref?.();

    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (output.length > 4000) output = output.slice(0, 4000);
    });
    child.on("error", () => done(""));
    child.on("close", () => done(cleanTitle(output)));
  });
}

async function maybeAutoName(bridge) {
  if (AUTO_TITLE_DISABLED || bridge.autoNameTried) return;
  bridge.autoNameTried = true;
  try {
    const first = await command(bridge, { type: "get_state" });
    if (first.data?.sessionName) return;

    const messages = (await command(bridge, { type: "get_messages" })).data?.messages || [];
    const users = messages.filter((message) => message.role === "user");
    if (users.length !== 1) return;

    const userText = messageText(users[0])
      .replace(/\[Image:[^\]]*\]/gi, " ")
      .trim();
    const assistant = messages.find(
      (message) => message.role === "assistant" && messageText(message).trim(),
    );
    const assistantText = assistant ? messageText(assistant) : "";
    if (!userText && !assistantText.trim()) return;

    const title = await generateTitle(userText || "（用户发来一张图片）", assistantText, bridge.cwd);
    if (!title) return;

    // 生成期间用户可能自己改了名，再确认一次
    const current = await command(bridge, { type: "get_state" });
    if (current.data?.sessionName) return;

    await bridge.send({ type: "set_session_name", name: title }, 15000);
    sessionCache.at = 0;
    log("auto title:", title);
  } catch (error) {
    log("auto title skipped:", error.message);
  }
}

async function snapshot(bridge) {
  const [state, messages, stats, models, levels, commands] = await Promise.all([
    command(bridge, { type: "get_state" }),
    command(bridge, { type: "get_messages" }),
    command(bridge, { type: "get_session_stats" }),
    command(bridge, { type: "get_available_models" }),
    command(bridge, { type: "get_available_thinking_levels" }),
    command(bridge, { type: "get_commands" }),
  ]);

  if (state.data?.sessionFile) bridge.sessionFile = state.data.sessionFile;

  return {
    key: bridge.key,
    workspace,
    sessionsDir: sessionsDir(workspace),
    sessionFile: bridge.sessionFile,
    state: state.data || {},
    messages: messages.data?.messages || [],
    stats: stats.data || {},
    models: models.data?.models || [],
    thinkingLevels: levels.data?.levels || ["off"],
    commands: commands.data?.commands || [],
    pendingUi: [...bridge.pendingUi.values()],
    sessions: getSessions(),
  };
}

async function openBridge(sessionFile) {
  if (sessionFile) {
    for (const existing of bridges.values()) {
      if (existing.sessionFile === sessionFile && !existing.exited) return existing;
    }
  }

  const bridge = new PiBridge({ cwd: workspace, sessionFile: sessionFile || null });
  wire(bridge);
  bridge.start();

  let state;
  try {
    state = await command(bridge, { type: "get_state" }, 30000);
  } catch (error) {
    bridge.dispose();
    throw error;
  }

  const sessionId = state.data?.sessionId;
  if (!sessionId) {
    bridge.dispose();
    throw new Error("pi did not report a session id");
  }

  bridge.key = "s:" + sessionId;
  if (state.data?.sessionFile) bridge.sessionFile = state.data.sessionFile;

  const duplicate = bridges.get(bridge.key);
  if (duplicate && !duplicate.exited) {
    bridge.dispose();
    return duplicate;
  }

  bridges.set(bridge.key, bridge);
  log("session ready", bridge.key, bridge.sessionFile || "(unsaved)");
  return bridge;
}

function bridgeDispose(key) {
  const bridge = bridges.get(key);
  if (!bridge) return;
  bridge.dispose();
  bridges.delete(key);
}

function bridgeFor(key) {
  const bridge = bridges.get(key);
  if (!bridge) throw new Error("unknown session: " + key);
  return bridge;
}

function routeCommand(name, payload) {
  const allowed = {
    "set_model": ["provider", "modelId"],
    "set_thinking_level": ["level"],
    "set_session_name": ["name"],
    "compact": [],
    "abort": [],
    "clear_queue": [],
    "steer": ["message", "images"],
    "follow_up": ["message", "images"],
  }[name];
  if (!allowed) throw new Error("unsupported command");
  const out = { type: name };
  for (const field of allowed) {
    if (payload[field] !== undefined) out[field] = payload[field];
  }
  return out;
}

async function handleApi(req, res, url) {
  const path = url.pathname;

  if (req.method === "GET" && path === "/api/bootstrap") {
    return json(res, 200, {
      workspace,
      sessionsDir: sessionsDir(workspace),
      sessionRoot: sessionRoot(),
      piVersion: piVersionString(),
      sessions: getSessions(),
    });
  }

  if (req.method === "GET" && path === "/api/sessions") {
    return json(res, 200, { sessions: getSessions() });
  }

  if (req.method === "GET" && path === "/api/session-events") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 2000\n\n");
    res.write("event: status\ndata: " + JSON.stringify({ statuses: statusSnapshot() }) + "\n\n");
    statusClients.add(res);
    const ping = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* ignore */
      }
    }, 15000);
    ping.unref?.();
    req.on("close", () => {
      clearInterval(ping);
      statusClients.delete(res);
    });
    return undefined;
  }

  if (req.method === "GET" && path === "/api/events") {
    const bridge = bridgeFor(url.searchParams.get("key") || "");
    const since = Number(url.searchParams.get("since") || req.headers["last-event-id"] || 0);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 2000\n\n");

    if (since > 0) {
      for (const item of bridge.eventsSince(since)) {
        res.write("id: " + item.seq + "\nevent: pi\ndata: " + JSON.stringify(item.record) + "\n\n");
      }
    }

    res.write("event: hello\ndata: " + JSON.stringify({ seq: bridge.seq }) + "\n\n");
    bridge.clients.add(res);

    const ping = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* ignore */
      }
    }, 15000);
    ping.unref?.();

    req.on("close", () => {
      clearInterval(ping);
      bridge.clients.delete(res);
    });
    return undefined;
  }

  if (req.method !== "POST") return json(res, 404, { error: "not found" });

  const body = await readBody(req);

  if (path === "/api/session/seen") {
    const id = String(body.key || "").replace(/^s:/, "");
    const item = sessionRuntime.get(id);
    if (item) {
      item.seenAt = Date.now();
      broadcastStatus();
    }
    return json(res, 200, { ok: true });
  }

  if (path === "/api/workspace") {
    const raw = String(body.path || "").trim();
    if (!raw) return json(res, 400, { error: "请输入目录路径" });
    const expanded = raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw;
    const next = resolve(expanded);
    let stat;
    try {
      stat = statSync(next);
    } catch {
      return json(res, 400, { error: "目录不存在：" + next });
    }
    if (!stat.isDirectory()) return json(res, 400, { error: "这不是目录：" + next });
    try {
      accessSync(next, fsConstants.R_OK | fsConstants.X_OK);
    } catch {
      return json(res, 400, { error: "没有权限访问：" + next });
    }
    workspace = next;
    sessionCache.at = 0;
    log("workspace switched", workspace);
    return json(res, 200, {
      workspace,
      sessionsDir: sessionsDir(workspace),
      sessions: getSessions(),
      piVersion: piVersionString(),
    });
  }

  if (path === "/api/workspace/pick") {
    if (process.platform !== "darwin") {
      return json(res, 501, { error: "当前系统暂不支持打开系统目录选择框" });
    }
    try {
      const picked = await new Promise((resolvePick, rejectPick) => {
        execFile(
          "osascript",
          ["-e", 'POSIX path of (choose folder with prompt "选择 pi 的工作目录")'],
          { timeout: 180000, maxBuffer: 1024 * 1024 },
          (error, stdout, stderr) => {
            if (error) {
              rejectPick(Object.assign(error, { stderr }));
              return;
            }
            resolvePick(String(stdout || "").trim());
          },
        );
      });
      const chosen = picked.replace(/\/+$/, "") || "/";
      if (!chosen) return json(res, 200, { cancelled: true });
      return json(res, 200, { path: chosen });
    } catch (error) {
      const text = String(error.stderr || error.message || "");
      if (error.killed) return json(res, 500, { error: "选择超时，请重试" });
      if (text.includes("-128") || /cancel/i.test(text)) return json(res, 200, { cancelled: true });
      return json(res, 500, { error: "无法打开系统选择框：" + text.trim() });
    }
  }

  if (path === "/api/archive") {
    if (!isSessionFile(body.file, workspace)) return json(res, 400, { error: "invalid session file" });
    const target = resolve(body.file);
    const archive = readArchive();
    if (body.archived) archive[target] = new Date().toISOString();
    else delete archive[target];
    writeArchive(archive);
    sessionCache.at = 0;
    return json(res, 200, { archived: Boolean(body.archived) });
  }

  if (path === "/api/session/delete") {
    if (!isSessionFile(body.file, workspace)) return json(res, 400, { error: "invalid session file" });
    const target = resolve(body.file);
    const archive = readArchive();
    if (archive[target]) {
      delete archive[target];
      writeArchive(archive);
    }
    const doomed = [];
    for (const [key, bridge] of bridges) {
      if (bridge.sessionFile === target) doomed.push(key);
    }
    for (const key of doomed) {
      sessionRuntime.delete(key.replace(/^s:/, ""));
      bridgeDispose(key);
    }
    if (doomed.length) {
      broadcastStatus();
      await new Promise((done) => setTimeout(done, 300));
    }
    try {
      unlinkSync(target);
    } catch (error) {
      if (error.code !== "ENOENT") {
        return json(res, 500, { error: "删除失败：" + error.message });
      }
    }
    sessionCache.at = 0;
    log("deleted session", target);
    return json(res, 200, { deleted: true });
  }

  if (path === "/api/session/new") {
    const bridge = await openBridge(null);
    return json(res, 200, await snapshot(bridge));
  }

  if (path === "/api/session/open") {
    if (!isSessionFile(body.file, workspace)) return json(res, 400, { error: "invalid session file" });
    const bridge = await openBridge(resolve(body.file));
    return json(res, 200, await snapshot(bridge));
  }

  if (path === "/api/session/snapshot") {
    const bridge = bridgeFor(body.key);
    return json(res, 200, await snapshot(bridge));
  }

  if (path === "/api/chat") {
    const bridge = bridgeFor(body.key);
    const message = String(body.message || "");
    if (!message.trim() && !(body.images || []).length) {
      return json(res, 400, { error: "empty message" });
    }
    const payload = { type: "prompt", message };
    if (body.images?.length) payload.images = body.images;
    if (body.behavior) payload.streamingBehavior = body.behavior;
    const started = await bridge.send(payload);
    if (!started.success) return json(res, 400, { error: started.error || "prompt rejected" });
    return json(res, 200, { disposition: started.data?.disposition || "started" });
  }

  if (path === "/api/command") {
    const bridge = bridgeFor(body.key);
    const name = String(body.command?.type || "");
    if (!ALLOWED_COMMANDS.has(name)) {
      return json(res, 400, { error: "command not allowed: " + name });
    }
    const response = await bridge.send(routeCommand(name, body.command), name === "compact" ? 180000 : 60000);
    return json(res, 200, { success: response.success, data: response.data || null, error: response.error || null });
  }

  if (path === "/api/abort") {
    const bridge = bridgeFor(body.key);
    const response = await bridge.send({ type: "abort" }, 180000);
    return json(res, 200, { success: response.success, error: response.error || null });
  }

  if (path === "/api/ui") {
    const bridge = bridgeFor(body.key);
    const id = String(body.id || "");
    bridge.pendingUi.delete(id);
    const response = await bridge.respondUi(id, body.payload || {});
    return json(res, 200, { success: response.success });
  }

  if (path === "/api/rename") {
    const bridge = bridgeFor(body.key);
    const name = String(body.name || "").slice(0, 120);
    const response = await bridge.send({ type: "set_session_name", name });
    sessionCache.at = 0;
    if (!response.success) return json(res, 400, { error: response.error || "rename failed" });
    return json(res, 200, { success: true });
  }

  if (path === "/api/stats") {
    const bridge = bridgeFor(body.key);
    const response = await command(bridge, { type: "get_session_stats" });
    return json(res, 200, response.data || {});
  }

  return json(res, 404, { error: "not found" });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    if (serveStatic(PUBLIC_DIR, req, res)) return;
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
  } catch (error) {
    if (!res.headersSent) json(res, 400, { error: String(error.message || error) });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  log("listening on http://" + HOST + ":" + PORT);
  log("workspace", workspace);
  log("pi", piVersionString());
});

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, bridge] of bridges) {
    const idle = now - bridge.lastActivity > 15 * 60 * 1000;
    if (idle && !bridge.streaming && bridge.clients.size === 0) {
      log("dispose idle session", key);
      bridge.dispose();
      bridges.delete(key);
    }
  }
}, 60000);
sweeper.unref?.();

function shutdown() {
  for (const bridge of bridges.values()) bridge.dispose();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);