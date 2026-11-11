import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, basename } from "node:path";

const MAX_HEAD_BYTES = 4 * 1024 * 1024;
const MAX_HEAD_LINES = 16;
const TAIL_BYTES = 128 * 1024;

export function sessionRoot() {
  return resolve(process.env.PI_SESSION_DIR || join(homedir(), ".pi", "agent", "sessions"));
}

/** pi stores sessions in a folder derived from the workspace path. */
export function workspaceSlug(cwd) {
  const trimmed = resolve(cwd).replace(/^\/+/, "").replace(/[\\/:]/g, "-");
  return "--" + trimmed + "--";
}

export function sessionsDir(cwd) {
  return join(sessionRoot(), workspaceSlug(cwd));
}

function parseEntry(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export function messageText(message) {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join(" ");
  }
  return "";
}

function cleanTitle(text) {
  const flat = String(text || "")
    .replace(/\[Image:[^\]]*\]/gi, " ")
    .replace(/\r/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > 80 ? flat.slice(0, 80) + "…" : flat;
}

/**
 * 逐行读开头，避免因为一张图片的 base64 就让整行 JSON 被截断。
 * 找到第一条用户消息和会话名就停，最多 16 行 / 4MB。
 */
function scanHead(file) {
  const result = { header: null, name: "", title: "" };
  let fd;
  try {
    fd = openSync(file, "r");
    const chunk = Buffer.alloc(64 * 1024);
    let buffer = Buffer.alloc(0);
    let bytes = 0;
    let lines = 0;

    while (bytes < MAX_HEAD_BYTES && lines < MAX_HEAD_LINES) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (!read) break;
      bytes += read;
      const piece = chunk.subarray(0, read);
      buffer = buffer.length ? Buffer.concat([buffer, piece]) : Buffer.from(piece);

      let index;
      while (lines < MAX_HEAD_LINES && (index = buffer.indexOf(10)) !== -1) {
        const line = buffer.subarray(0, index).toString("utf8");
        buffer = buffer.subarray(index + 1);
        lines += 1;

        const entry = parseEntry(line);
        if (!entry) continue;
        if (entry.type === "session") {
          result.header = entry;
        } else if (entry.type === "session_info" && typeof entry.name === "string") {
          result.name = entry.name;
        } else if (
          !result.title &&
          entry.type === "message" &&
          entry.message &&
          entry.message.role === "user"
        ) {
          result.title = cleanTitle(messageText(entry.message));
        }

        if (result.title && result.name) return result;
      }
    }
  } catch {
    /* ignore */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return result;
}

/** 标题可能由自动命名写在文件末尾附近，从尾部再查一次最新的会话名。 */
function scanTailName(file) {
  let fd;
  try {
    const size = statSync(file).size;
    if (!size) return "";
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    fd = openSync(file, "r");
    readSync(fd, buffer, 0, length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift(); // 第一行可能被截断
    let name = "";
    for (const line of lines) {
      const entry = parseEntry(line);
      if (entry && entry.type === "session_info" && typeof entry.name === "string") {
        name = entry.name;
      }
    }
    return name;
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readMeta(file) {
  const head = scanHead(file);
  if (!head.header && !head.title && !head.name) return null;

  const name = scanTailName(file) || head.name;
  const header = head.header;

  let stat;
  try {
    stat = statSync(file);
  } catch {
    return null;
  }

  return {
    file,
    id: header?.id || basename(file).replace(/\.jsonl$/, ""),
    cwd: header?.cwd || null,
    createdAt: header?.timestamp || stat.birthtime.toISOString(),
    updatedAt: stat.mtime.toISOString(),
    name: name || "",
    title: head.title || (name ? cleanTitle(name) : "新会话"),
    parentSession: header?.parentSession || null,
  };
}

export function listSessions(cwd, { limit = 80 } = {}) {
  const dir = sessionsDir(cwd);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const file = join(dir, entry.name);
    try {
      files.push({ file, mtime: statSync(file).mtimeMs });
    } catch {
      /* ignore */
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);

  const sessions = [];
  for (const item of files.slice(0, limit)) {
    const meta = readMeta(item.file);
    if (meta) sessions.push(meta);
  }
  return sessions;
}

export function isSessionFile(file, cwd) {
  if (typeof file !== "string" || !file.endsWith(".jsonl")) return false;
  const target = resolve(file);
  const root = sessionsDir(cwd);
  return target.startsWith(root + "/") || target.startsWith(root + "\\");
}
