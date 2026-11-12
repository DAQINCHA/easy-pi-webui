#!/usr/bin/env node
/**
 * Minimal pi --mode rpc stand-in for tests. Never talks to a model.
 * Logs JSONL commands to FAKEPI_LOG when set.
 * Simulates --extension tree command and official fork; does not execute TypeScript extensions.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] || "" : "";
}

function loadEntries(file) {
  const entries = [];
  let id = "";
  let name = "";
  let model = null;
  let thinkingLevel = "";
  let leafId = "";
  if (!file || !existsSync(file)) {
    return { id, name, model, thinkingLevel, entries, leafId };
  }
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { continue; }
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "session" && entry.id && !id) id = entry.id;
    if (entry.type === "session_info" && typeof entry.name === "string") name = entry.name;
    if (entry.type === "model_change") model = { provider: entry.provider, modelId: entry.modelId || entry.model };
    if (entry.type === "thinking_level_change") thinkingLevel = entry.thinkingLevel || entry.level || thinkingLevel;
    if (entry.type !== "session") entries.push(entry);
    if (entry.id && entry.type !== "session") leafId = entry.id;
  }
  return { id, name, model, thinkingLevel, entries, leafId };
}

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write("fake-pi 0.0.0-test\n");
  process.exit(0);
}

if (process.argv.includes("--print")) {
  process.stdout.write("测试标题\n");
  process.exit(0);
}

const extensionPath = argValue("--extension") || "";
let sessionFile = argValue("--session") || process.env.FAKEPI_SESSION_FILE || "";
const loaded = loadEntries(sessionFile);
let sessionId = loaded.id || process.env.FAKEPI_SESSION_ID || "fake-session-1";
const logFile = process.env.FAKEPI_LOG || "";
let sessionName = loaded.name || "";
let sessionModel = loaded.model || null;
let sessionThinking = loaded.thinkingLevel || "off";
let entries = loaded.entries;
let leafId = loaded.leafId;
let nextSeq = 1;

function logCommand(record) {
  if (!logFile) return;
  mkdirSync(dirname(logFile), { recursive: true });
  appendFileSync(logFile, JSON.stringify(record) + "\n");
}

function reply(id, data = {}) {
  process.stdout.write(JSON.stringify({ type: "response", id, success: true, data }) + "\n");
}

function fail(id, error) {
  process.stdout.write(JSON.stringify({ type: "response", id, success: false, error: String(error) }) + "\n");
}

function event(record) {
  process.stdout.write(JSON.stringify(record) + "\n");
}

function byIdMap() {
  const map = new Map();
  for (const entry of entries) {
    if (entry && entry.id) map.set(String(entry.id), entry);
  }
  return map;
}

function pathEntries(fromLeaf = leafId) {
  const byId = byIdMap();
  const path = [];
  const seen = new Set();
  let current = fromLeaf ? String(fromLeaf) : "";
  while (current && !seen.has(current)) {
    seen.add(current);
    const item = byId.get(current);
    if (!item) break;
    path.push(item);
    current = item.parentId ? String(item.parentId) : "";
  }
  path.reverse();
  return path;
}

function roleOf(entry) {
  return String((entry && (entry.role || (entry.message && entry.message.role))) || "");
}

function messageOf(entry) {
  if (!entry) return null;
  if (entry.message) return entry.message;
  if (entry.type === "message" && entry.content) return { role: roleOf(entry), content: entry.content };
  return null;
}

function textOf(entry) {
  const message = messageOf(entry);
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block && block.type === "text").map((block) => block.text || "").join("\n").trim();
}

function appendEntry(entry) {
  entries.push(entry);
  if (entry.id) leafId = entry.id;
  if (sessionFile) {
    mkdirSync(dirname(sessionFile), { recursive: true });
    appendFileSync(sessionFile, JSON.stringify(entry) + "\n");
  }
}

function treeCommands() {
  if (process.env.FAKEPI_NO_TREE_COMMAND === "1" || !extensionPath) return [];
  const path = process.env.FAKEPI_TREE_SOURCE || extensionPath;
  return [{
    name: process.env.FAKEPI_TREE_NAME || "easy-pi-webui-tree",
    description: "Internal WebUI tree navigation",
    source: "extension",
    sourceInfo: { path, basename: "easy-pi-webui-tree.ts" },
  }];
}

function handleTree(id, invocation, entryId) {
  if (process.env.FAKEPI_TREE_ERROR === "1") {
    event({ type: "extension_error", error: "navigate failed", command: invocation });
    return reply(id, { disposition: "handled" });
  }
  if (process.env.FAKEPI_TREE_NOMOVE === "1" || process.env.FAKEPI_TREE_CANCEL === "1") {
    return reply(id, { disposition: "handled" });
  }
  const entry = byIdMap().get(String(entryId));
  if (!entry) {
    event({ type: "extension_error", error: "unknown entry", command: invocation });
    return reply(id, { disposition: "handled" });
  }
  leafId = entry.parentId ? String(entry.parentId) : "";
  return reply(id, { disposition: "handled" });
}

function handleFork(id, entryId) {
  const entry = byIdMap().get(String(entryId));
  if (!entry) return fail(id, "unknown entry");
  const prefixLeaf = entry.parentId ? String(entry.parentId) : "";
  const path = pathEntries(prefixLeaf);
  const newId = "fork-" + randomUUID();
  const dir = sessionFile ? dirname(sessionFile) : process.cwd();
  const newFile = join(dir, newId + ".jsonl");
  const header = {
    type: "session",
    version: 3,
    id: newId,
    cwd: process.cwd(),
    timestamp: new Date().toISOString(),
    parentSession: sessionId,
  };
  const lines = [JSON.stringify(header), ...path.map((item) => JSON.stringify(item))];
  mkdirSync(dir, { recursive: true });
  writeFileSync(newFile, lines.join("\n") + "\n");
  sessionId = newId;
  sessionFile = newFile;
  entries = path.slice();
  leafId = prefixLeaf;
  return reply(id, { text: textOf(entry), sessionId, sessionFile });
}

function handle(record) {
  if (!record || typeof record !== "object") return;
  logCommand(record);
  const id = record.id || "unknown";
  switch (record.type) {
    case "get_state":
      return reply(id, {
        sessionId,
        sessionFile,
        thinkingLevel: sessionThinking || "off",
        sessionName,
        model: sessionModel || undefined,
        isStreaming: process.env.FAKEPI_IS_STREAMING === "1",
        isCompacting: process.env.FAKEPI_IS_COMPACTING === "1",
      });
    case "get_messages":
      return reply(id, {
        messages: pathEntries().map(messageOf).filter(Boolean),
      });
    case "get_entries":
      return reply(id, { leafId, entries });
    case "get_tree":
      return reply(id, { leafId, entries: pathEntries() });
    case "get_session_stats":
      return reply(id, {});
    case "get_available_models":
      return reply(id, { models: [] });
    case "get_available_thinking_levels":
      return reply(id, { levels: ["off"] });
    case "get_commands":
      return reply(id, { commands: treeCommands() });
    case "get_fork_messages":
      return reply(id, {
        messages: pathEntries()
          .filter((item) => roleOf(item) === "user")
          .map((item) => ({ entryId: item.id, text: textOf(item) })),
      });
    case "fork":
      return handleFork(id, record.entryId);
    case "prompt": {
      const text = String(record.message || "");
      const match = text.match(/^\/([A-Za-z0-9:_-]+)\s+([A-Za-z0-9._-]+)\s*$/);
      if (match && (match[1] === "easy-pi-webui-tree" || match[1].startsWith("easy-pi-webui-tree:"))) {
        return handleTree(id, match[1], match[2]);
      }
      const content = [];
      if (text) content.push({ type: "text", text });
      for (const image of record.images || []) {
        content.push({ type: "image", mimeType: image.mimeType || "image/png", data: image.data });
      }
      const newId = "n" + (nextSeq++);
      appendEntry({
        type: "message",
        id: newId,
        parentId: leafId || "",
        timestamp: new Date().toISOString(),
        message: { role: "user", content: content.length ? content : text },
      });
      return reply(id, { disposition: "started" });
    }
    case "steer":
    case "follow_up":
    case "abort":
      return reply(id, { disposition: "started" });
    case "set_model":
      sessionModel = { provider: record.provider, modelId: record.modelId };
      return reply(id, {});
    case "set_thinking_level":
      sessionThinking = record.level || record.thinkingLevel || sessionThinking;
      return reply(id, {});
    case "set_session_name":
      sessionName = record.name || sessionName;
      if (sessionFile && record.name) {
        try { appendFileSync(sessionFile, JSON.stringify({ type: "session_info", name: record.name }) + "\n"); } catch { /* ignore */ }
      }
      return reply(id, {});
    case "compact":
      return reply(id, { disposition: "started" });
    default:
      return reply(id, {});
  }
}

if (process.env.FAKEPI_IS_STREAMING === "1") {
  event({ type: "agent_start" });
}
if (process.env.FAKEPI_PENDING_UI === "1") {
  event({
    type: "extension_ui_request",
    id: "fake-ui-1",
    method: "confirm",
    title: "确认",
  });
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line));
  } catch {
    process.stderr.write("fake-pi: bad json\n");
  }
});
