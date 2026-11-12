/**
 * Helpers for same-session tree navigation and official-fork "另开分支".
 * This module never writes session JSONL and never talks to the model.
 */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FileAccessError } from "./files.js";

export const TREE_COMMAND_NAME = "easy-pi-webui-tree";
export const TREE_EXTENSION_PATH = resolve(
  join(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "easy-pi-webui-tree.ts"),
);
export const ALTERNATE_SUFFIX = " · 另一分支";
export const ALTERNATE_DRAFT = "换一种方式再做一次。";
export const RETRY_WARNING = "重新生成会重新执行任务；已修改文件不会自动回滚。";
export const ENTRY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const COMMAND_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;

const KNOWN_CONTENT_TYPES = new Set(["text", "image", "image_url", "thinking", "toolCall", "tool_use"]);

export function fileFingerprint(file) {
  const st = statSync(file);
  return {
    file: resolve(file),
    size: st.size,
    mtimeMs: st.mtimeMs,
    hash: createHash("sha256").update(readFileSync(file)).digest("hex"),
  };
}

export function samePath(a, b) {
  if (!a || !b) return false;
  try {
    if (resolve(String(a)) === resolve(String(b))) return true;
  } catch { /* ignore */ }
  try {
    return realpathSync(String(a)) === realpathSync(String(b));
  } catch {
    return false;
  }
}

export function sessionBusyReason({ streaming, running, pendingUi, compacting } = {}) {
  if (streaming || running || compacting) return "当前对话还在进行，结束后再试。这样不会中断现在的任务";
  if (pendingUi) return "当前对话正在等待确认，结束后再试。这样不会中断现在的任务";
  return "";
}

export function branchTitle(originalName, suffix) {
  const base = String(originalName || "").trim() || "未命名会话";
  const tag = suffix || ALTERNATE_SUFFIX;
  if (base.endsWith(tag)) return base;
  const clipped = base.length > 80 ? base.slice(0, 80) : base;
  return clipped + tag;
}

export function reservedTreeCommand(message) {
  const text = String(message || "").trim();
  if (!text.startsWith("/")) return null;
  const space = text.search(/\s/);
  const name = (space === -1 ? text.slice(1) : text.slice(1, space)).trim();
  if (name === TREE_COMMAND_NAME || name.startsWith(TREE_COMMAND_NAME + ":")) return name;
  return null;
}

export function treeCommandMessage(invocationName, entryId) {
  const name = String(invocationName || "").trim();
  const id = String(entryId || "").trim();
  if (!COMMAND_NAME_RE.test(name)) {
    throw new FileAccessError("无效的导航命令名", 400, "bad_command");
  }
  if (!ENTRY_ID_RE.test(id)) {
    throw new FileAccessError("无效的消息编号", 400, "bad_entry");
  }
  if (name.includes(" ") || id.includes(" ") || name.includes("\n") || id.includes("\n")) {
    throw new FileAccessError("无效的导航参数", 400, "bad_command");
  }
  return "/" + name + " " + id;
}

export function resolveTreeCommand(commands, expectedPath = TREE_EXTENSION_PATH) {
  const list = Array.isArray(commands) ? commands : [];
  const matches = list.filter((item) => {
    if (!item || (item.source && item.source !== "extension")) return false;
    const name = String(item.name || "");
    if (name !== TREE_COMMAND_NAME && !name.startsWith(TREE_COMMAND_NAME + ":")) return false;
    const path = item.sourceInfo && item.sourceInfo.path;
    return samePath(path, expectedPath);
  });
  if (!matches.length) {
    throw new FileAccessError(
      "树导航扩展未加载。请重启 easy-pi-webui 服务后再试，不要把这条命令当作普通消息发送。",
      503,
      "tree_command_missing",
    );
  }
  const name = String(matches[0].name || "").trim();
  if (!COMMAND_NAME_RE.test(name)) {
    throw new FileAccessError("树导航命令名无效", 503, "tree_command_missing");
  }
  return name;
}

export function extractPrompt(message) {
  const content = message && (message.content || (message.message && message.message.content));
  const blocks = Array.isArray(content) ? content : (typeof content === "string" ? [{ type: "text", text: content }] : []);
  const texts = [];
  const images = [];
  let unknown = false;
  let missingImage = false;
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const type = String(block.type || "");
    if (type === "text") {
      const text = String(block.text || "");
      if (text) texts.push(text);
      continue;
    }
    if (type === "image") {
      if (!block.data) { missingImage = true; continue; }
      images.push({ mimeType: block.mimeType || "image/png", data: String(block.data) });
      continue;
    }
    if (type === "image_url") {
      if (!block.data && !block.url) { missingImage = true; continue; }
      if (block.data) images.push({ mimeType: block.mimeType || "image/png", data: String(block.data) });
      else missingImage = true;
      continue;
    }
    if (type === "thinking") continue;
    if (!KNOWN_CONTENT_TYPES.has(type) && type) unknown = true;
  }
  if (typeof content === "string" && !blocks.length && content) texts.push(content);
  const text = texts.join("\n").trim();
  if (missingImage || unknown) {
    return { ok: false, text, images, reason: "这条消息的附件不完整，无法安全保留后重试。请直接复制文字后再发。" };
  }
  if (!text && !images.length) {
    return { ok: false, text: "", images: [], reason: "找不到可重新发送的原文" };
  }
  return { ok: true, text, images };
}

export function expectedLeafAfterNavigate(entry) {
  if (!entry) return "";
  const parent = entry.parentId == null ? "" : String(entry.parentId);
  return parent;
}

export function findUserEntry(entries, entryId, from) {
  const list = Array.isArray(entries) ? entries : [];
  const id = String(entryId || "");
  if (!ENTRY_ID_RE.test(id)) {
    throw new FileAccessError("无效的消息编号", 400, "bad_entry");
  }
  const byId = new Map();
  for (const item of list) {
    if (item && item.id) byId.set(String(item.id), item);
  }
  let target = byId.get(id);
  if (!target) {
    throw new FileAccessError("找不到这条消息", 400, "missing_entry");
  }
  if (roleOf(target) === "user") return target;
  if (from === "user") {
    throw new FileAccessError("只能从用户消息开始编辑或重新生成", 400, "not_user");
  }
  // Walk toward the nearest earlier user message (the prompt that produced this reply).
  let cursor = target;
  const seen = new Set();
  while (cursor && cursor.parentId && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    cursor = byId.get(String(cursor.parentId));
    if (cursor && roleOf(cursor) === "user") return cursor;
  }
  throw new FileAccessError("找不到对应的用户请求", 400, "missing_entry");
}

function roleOf(entry) {
  return String((entry && (entry.role || (entry.message && entry.message.role))) || "");
}

export function normalizeEntries(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list.map((item) => {
    if (!item || typeof item !== "object") return item;
    if (item.type === "message" || item.message) {
      return {
        id: item.id,
        parentId: item.parentId == null ? "" : item.parentId,
        type: item.type || "message",
        role: roleOf(item),
        message: item.message || { role: roleOf(item), content: item.content },
        content: item.content || (item.message && item.message.content),
      };
    }
    return {
      id: item.id,
      parentId: item.parentId == null ? "" : item.parentId,
      type: item.type,
      role: roleOf(item),
    };
  }).filter((item) => item && item.id);
}

export function fingerprintsMatch(before, after) {
  if (!before || !after) return false;
  return before.hash === after.hash && before.size === after.size;
}

export function parseSessionRecords(text) {
  const records = [];
  let header = null;
  let name = "";
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { continue; }
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "session") header = entry;
    if (entry.type === "session_info" && typeof entry.name === "string" && entry.name) name = entry.name;
    if (entry.id || entry.type === "message" || entry.parentId) records.push(entry);
  }
  return { header, name, records };
}
