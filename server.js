import { createServer } from "node:http";
import {
  accessSync, chmodSync, constants as fsConstants, mkdirSync, readFileSync,
  realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
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

// 每台电脑自己的配置，不放 iCloud、不放 ~/.pi，避免污染 pi 的真实设置与凭据。
const CONFIG_DIR = join(homedir(), ".config", "easy-pi-webui");
const CONFIG_FILE = join(CONFIG_DIR, "settings.json");

function readSettings() {
  let raw;
  try {
    raw = readFileSync(CONFIG_FILE, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { data: null, error: null };
    return { data: null, error: error.message };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("内容不是对象");
    return { data: parsed, error: null };
  } catch (error) {
    return { data: null, error: error.message };
  }
}

/** 原子替换；保留未知字段；配置不可读时不覆盖旧文件。 */
function saveWorkspaceSetting(path) {
  const current = readSettings();
  if (current.error) {
    return { ok: false, error: "本机配置无法读取或解析，已保留原文件：" + current.error };
  }
  const next = { ...(current.data || {}), version: 1, workspace: path };
  const tmp = join(CONFIG_DIR, ".settings-" + process.pid + "-" + Date.now() + ".tmp");
  try {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, CONFIG_FILE);
    return { ok: true, error: null };
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    return { ok: false, error: error.message };
  }
}

/** 统一绝对化 + 校验 + canonical 路径，供启动和页面切换共用。 */
function resolveWorkspace(raw) {
  const text = String(raw || "").trim();
  if (!text) return { error: "请输入目录路径" };
  const expanded = text.startsWith("~") ? join(homedir(), text.slice(1)) : text;
  const absolute = resolve(expanded);
  try {
    const stat = statSync(absolute);
    if (!stat.isDirectory()) return { error: "这不是目录：" + absolute };
    accessSync(absolute, fsConstants.R_OK | fsConstants.X_OK);
    return { path: realpathSync(absolute) };
  } catch (error) {
    return { error: "目录无法访问：" + absolute + "（" + error.message + "）" };
  }
}

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
const PORT = Number(flags.port || process.env.PORT || process.env.PI_WEBUI_PORT || 30142);
const HOST = flags.host || process.env.HOST || "127.0.0.1";

// 优先级：--workspace > PI_WORKSPACE > 本机保存 > 未选择（不再用 process.cwd() 兜底）。
// 显式覆盖只在当次生效，不回写配置；页面主动切换才保存。
let workspace = null;
let startupError = "";
{
  const settings = readSettings();
  const override = flags.workspace || process.env.PI_WORKSPACE || "";
  if (override) {
    const source = flags.workspace ? "--workspace" : "PI_WORKSPACE";
    const checked = resolveWorkspace(override);
    if (checked.path) workspace = checked.path;
    else startupError = source + " 指定的工作目录无效：" + checked.error;
  } else if (settings.error) {
    startupError = "本机配置读取失败：" + settings.error + "；请在页面重新选择工作目录";
  } else if (settings.data && settings.data.workspace) {
    const checked = resolveWorkspace(settings.data.workspace);
    if (checked.path) workspace = checked.path;
    else startupError = "保存的工作目录已失效：" + checked.error + "；请在页面重新选择工作目录";
  }
  if (startupError) log("ERROR:", startupError);
}

/** @type {Map<string, PiBridge>} */
const bridges = new Map();
const statusClients = new Set();
const sessionRuntime = new Map();
/** 自动标题子进程，退出时要一并回收。 */
const titleJobs = new Set();
let piVersion = null;
let sessionCache = { at: 0, list: [] };
let shuttingDown = false;

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
  if (!workspace) return [];
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
      errored: Boolean(item.errored),
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

function setRunning(bridge, running, finished = true, errored) {
  const id = statusId(bridge);
  if (!id) return;
  const item = sessionRuntime.get(id) || { running: false, finishedAt: 0, seenAt: 0 };
  item.running = Boolean(running);
  if (!running && finished) item.finishedAt = Date.now();
  if (errored !== undefined) item.errored = Boolean(errored);
  sessionRuntime.set(id, item);
  broadcastStatus();
}

function wire(bridge) {
  bridge.clients = new Set();
  bridge.pendingUi = new Map();
  bridge.streaming = false;
  bridge.hadError = false;

  bridge.on("record", ({ seq, record }) => {
    if (record.type === "agent_start") {
      bridge.streaming = true;
      bridge.hadError = false;
      setRunning(bridge, true, true, false);
    }
    // 模型请求失败：重试最终失败，或助手消息以 error 结束。
    // agent_start 会重置这个标记，所以自动重试成功后不会误报。
    if (record.type === "auto_retry_end") {
      bridge.hadError = record.success === false;
    }
    if (
      record.type === "message_end" &&
      record.message?.role === "assistant" &&
      (record.message.stopReason === "error" || record.message.errorMessage)
    ) {
      bridge.hadError = true;
    }
    if (record.type === "agent_settled") {
      bridge.streaming = false;
      // 用户主动停止（aborted）不算出错。
      setRunning(bridge, false, true, Boolean(bridge.hadError && !record.aborted));
    }

    if (record.type === "extension_ui_request") {
      const dialog = ["select", "confirm", "input", "editor"].includes(record.method);
      if (dialog) bridge.pendingUi.set(record.id, record);
    }
    broadcast(bridge, record, seq);

    if (record.type === "agent_settled") {
      const timer = setTimeout(() => {
        if (!shuttingDown) maybeAutoName(bridge).catch(() => {});
      }, 500);
      timer.unref?.();
    }
  });

  bridge.on("exit", ({ code, signal, intentional }) => {
    bridge.streaming = false;
    // 非预期退出（进程崩溃等）也算会话异常终止；主动回收 / 删除会话不算。
    setRunning(bridge, false, false, intentional ? undefined : true);
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
    if (shuttingDown) {
      resolveTitle("");
      return;
    }
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

    const job = { child, timer: null };
    titleJobs.add(job);

    let output = "";
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(job.timer);
      titleJobs.delete(job);
      resolveTitle(value);
    };
    job.timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      done("");
    }, 25000);
    job.timer.unref?.();

    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (output.length > 4000) output = output.slice(0, 4000);
    });
    child.on("error", () => done(""));
    child.on("close", () => done(cleanTitle(output)));
  });
}

async function maybeAutoName(bridge) {
  if (shuttingDown || AUTO_TITLE_DISABLED || bridge.autoNameTried) return;
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
  const [state, messages, stats, models, levels, commands, forks] = await Promise.all([
    command(bridge, { type: "get_state" }),
    command(bridge, { type: "get_messages" }),
    command(bridge, { type: "get_session_stats" }),
    command(bridge, { type: "get_available_models" }),
    command(bridge, { type: "get_available_thinking_levels" }),
    command(bridge, { type: "get_commands" }),
    // 老版本 pi / 异常时不要让整个快照失败。
    command(bridge, { type: "get_fork_messages" }).catch(() => ({ data: { messages: [] } })),
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
    // 只给前端 entryId + 纯文本，不带图片 / base64。
    forkMessages: (forks.data?.messages || []).map((item) => ({ entryId: item.entryId, text: item.text })),
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

// 未选择工作区时只允许「看状态 / 选目录」，其余 session 入口一律拒绝，
// 保证不会在未选择态 spawn pi 或发起模型请求。
const SAFE_WITHOUT_WORKSPACE = new Set([
  "/api/bootstrap",
  "/api/sessions",
  "/api/session-events",
  "/api/workspace",
  "/api/workspace/pick",
]);

async function handleApi(req, res, url) {
  const path = url.pathname;

  if (shuttingDown) return json(res, 503, { error: "服务正在退出" });
  if (!workspace && !SAFE_WITHOUT_WORKSPACE.has(path)) {
    return json(res, 400, { error: "请先选择工作目录" });
  }

  if (req.method === "GET" && path === "/api/bootstrap") {
    return json(res, 200, {
      workspace,
      needsWorkspace: !workspace,
      workspaceError: startupError || null,
      sessionsDir: workspace ? sessionsDir(workspace) : null,
      sessionRoot: sessionRoot(),
      // 未选择时不调用 pi --version，避免起任何 pi 子进程。
      piVersion: workspace ? piVersionString() : null,
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
      item.errored = false;
      broadcastStatus();
    }
    return json(res, 200, { ok: true });
  }

  if (path === "/api/workspace") {
    const checked = resolveWorkspace(body.path);
    if (!checked.path) return json(res, 400, { error: checked.error });

    // 页面主动切换才持久化；CLI/环境覆盖只在当次生效，不回写配置。
    const save = saveWorkspaceSetting(checked.path);
    workspace = checked.path;
    startupError = "";
    sessionCache.at = 0;
    log("workspace switched", workspace, save.ok ? "(saved)" : "(not saved)");
    // 明确反馈「工作区已切换，但保存失败」，且不记录配置正文。
    if (!save.ok) log("ERROR: 工作区设置保存失败：", save.error);
    return json(res, 200, {
      workspace,
      needsWorkspace: false,
      saved: save.ok,
      saveError: save.ok ? null : save.error,
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
          "/usr/bin/osascript",
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

  // ------------------------------------------------------------------
  // fork 语义实测结论（2026-11-11，pi 1.5.0，隔离 session-dir 的一次性 RPC 会话）：
  // 1. get_fork_messages 只返回「当前分支」的用户消息 [{entryId, text}]，按时间顺序；
  //    fork 之后再取，列表会缩短为新分支上的用户消息（不是全部历史）。
  // 2. fork {entryId} 一定会新建会话文件并换掉 sessionId / sessionFile（实测磁盘多出一个
  //    .jsonl），get_messages 变成「该消息之前」的历史，被 fork 的那条及其回答都不在里面；
  //    返回的 data.text 就是被移除的那条用户消息原文，可直接回填输入框。
  // 3. data.cancelled === false；扩展可通过 session_before_fork 取消（本次没造出该场景），
  //    按 cancelled === true 处理；无效 entryId 返回 success:false / "Invalid entry ID for forking"。
  // 4. 带图片的用户消息：get_fork_messages.text 和 fork 返回的 text 都只剩文字，图片会丢，
  //    所以前端对带图消息禁用编辑 / 重新生成。
  // 结论按实测写，实现不按猜测；实验会话用完即删，没有动用户已有会话。
  // ------------------------------------------------------------------
  if (path === "/api/fork") {
    const bridge = bridgeFor(body.key);
    const entryId = String(body.entryId || "");
    if (!entryId) return json(res, 400, { error: "missing entryId" });
    const response = await bridge.send({ type: "fork", entryId }, 60000);
    if (!response.success) return json(res, 400, { error: response.error || "fork failed" });
    if (response.data?.cancelled) return json(res, 400, { error: "fork cancelled" });

    // fork 必然换 sessionId：迁移 bridges 的 key，复用同一 bridge 实例，不新建 pi 进程。
    const state = await command(bridge, { type: "get_state" });
    const newId = state.data?.sessionId;
    if (newId && "s:" + newId !== bridge.key) {
      bridges.delete(bridge.key);
      bridge.key = "s:" + newId;
      bridges.set(bridge.key, bridge);
      log("fork migrated session key", bridge.key);
    }
    if (state.data?.sessionFile) bridge.sessionFile = state.data.sessionFile;
    sessionCache.at = 0;

    return json(res, 200, {
      text: response.data?.text || "",
      snapshot: await snapshot(bridge),
    });
  }

  // 每轮结束后前端要拿到最新的 entryId（新用户消息会产生新 entry），
  // 又不值得为此拉整份快照，单独给一个轻量入口。
  if (path === "/api/fork-messages") {
    const bridge = bridgeFor(body.key);
    const response = await command(bridge, { type: "get_fork_messages" });
    return json(res, 200, {
      forkMessages: (response.data?.messages || []).map((item) => ({ entryId: item.entryId, text: item.text })),
    });
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
  log("workspace", workspace || "(未选择，等待页面选择)");
  if (workspace) log("pi", piVersionString());
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

function childAlive(child) {
  return Boolean(child && child.exitCode === null && child.signalCode === null);
}

/** 只对本应用自己 spawn 的子进程：先给 stdin.end() 的自然退出留时间，再 TERM -> KILL。 */
function terminateChild(child) {
  if (!childAlive(child)) return Promise.resolve();
  return new Promise((resolveTerminate) => {
    let settled = false;
    const timers = [];
    const done = () => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      resolveTerminate();
    };
    child.once("exit", done);
    timers.push(setTimeout(() => {
      if (childAlive(child)) {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }
    }, 400));
    timers.push(setTimeout(() => {
      if (childAlive(child)) {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }
    }, 1600));
    timers.push(setTimeout(done, 2600));
  });
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutdown", signal || "requested");

  // 有界兜底：即使有子进程不配合也保证退出；正常路径会提前 process.exit。
  const hardExit = setTimeout(() => process.exit(0), 6000);

  // 1. 先拒绝新任务（handleApi 已有守卫），停止接受新连接。
  try { server.close(); } catch { /* ignore */ }

  // 2. 清会话回收定时器。
  clearInterval(sweeper);

  // 3. 关闭 SSE：server.close() 不会主动断长连接，必须逐个 end。
  for (const res of statusClients) {
    try { res.end(); } catch { /* ignore */ }
  }
  statusClients.clear();
  for (const bridge of bridges.values()) {
    for (const res of bridge.clients) {
      try { res.end(); } catch { /* ignore */ }
    }
    bridge.clients.clear();
  }

  // 4. 清理 pool 中全部 pi、自动标题进程及其计时器。
  for (const bridge of bridges.values()) bridge.dispose();
  for (const job of titleJobs) clearTimeout(job.timer);

  const children = [];
  for (const bridge of bridges.values()) if (bridge.child) children.push(bridge.child);
  for (const job of titleJobs) if (job.child) children.push(job.child);

  // 5. 确认真实退出后再结束。
  await Promise.all(children.map(terminateChild));
  clearTimeout(hardExit);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));