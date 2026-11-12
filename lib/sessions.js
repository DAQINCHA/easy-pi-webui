import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, basename } from "node:path";

const MAX_HEAD_BYTES = 4 * 1024 * 1024;
const MAX_HEAD_LINES = 16;
const TAIL_BYTES = 128 * 1024;
const NAME_SCAN_CHUNK = 64 * 1024;
const MAX_NAME_LINE_BYTES = 4 * 1024 * 1024;
const NAME_CACHE_LIMIT = 512;

// Session files are append-only; remember the last name scan so listing many
// sessions does not re-read every file on each refresh. Keyed by file path.
const nameCache = new Map();

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
    if (!size) return null;
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    fd = openSync(file, "r");
    readSync(fd, buffer, 0, length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift(); // 第一行可能被截断
    let name = "";
    let found = false;
    for (const line of lines) {
      const entry = parseEntry(line);
      if (entry && entry.type === "session_info" && typeof entry.name === "string") {
        name = entry.name;
        found = true;
      }
    }
    // Remember where the last complete line ends: a trailing partial line (crash
    // mid-write) must be re-scanned later from its own start, not from EOF.
    const lastBreak = buffer.lastIndexOf(10);
    const scanned = lastBreak === -1 ? 0 : start + lastBreak + 1;
    return found ? { name, scanned } : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function sessionInfoName(line) {
  const buffer = Buffer.isBuffer(line) ? line : Buffer.from(String(line), "utf8");
  // Cheap byte check first: the vast majority of lines are messages/tool output.
  if (buffer.indexOf('"session_info"') === -1) return null;
  const entry = parseEntry(buffer.toString("utf8"));
  if (!entry || entry.type !== "session_info" || typeof entry.name !== "string") return null;
  return entry.name;
}

/** Scan [start, end) for the last session_info name, returning the unread tail. */
function scanNameRange(file, start, end, initialName) {
  let name = initialName;
  let carry = Buffer.alloc(0);
  let fd;
  try {
    fd = openSync(file, "r");
    const chunk = Buffer.alloc(NAME_SCAN_CHUNK);
    let position = start;
    while (position < end) {
      const read = readSync(fd, chunk, 0, Math.min(chunk.length, end - position), position);
      if (!read) break;
      position += read;
      const piece = chunk.subarray(0, read);
      // Skip the middle of an oversized line instead of repeatedly copying it.
      if (carry.length + read > MAX_NAME_LINE_BYTES && piece.indexOf(10) === -1) {
        carry = Buffer.alloc(0);
        continue;
      }
      let buffer = carry.length ? Buffer.concat([carry, piece]) : Buffer.from(piece);
      let index;
      while ((index = buffer.indexOf(10)) !== -1) {
        const found = sessionInfoName(buffer.subarray(0, index));
        if (found !== null) name = found;
        buffer = buffer.subarray(index + 1);
      }
      carry = buffer;
      // A single oversized line (e.g. image base64) cannot be a useful name.
      // Drop it instead of keeping it in memory across refreshes.
      if (carry.length > MAX_NAME_LINE_BYTES) carry = Buffer.alloc(0);
    }
    if (carry.length) {
      const found = sessionInfoName(carry);
      if (found !== null) name = found;
    }
    return { name, scanned: position - carry.length, carry };
  } catch {
    return { name: initialName, scanned: start, carry: Buffer.alloc(0) };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function rememberName(file, entry) {
  nameCache.delete(file);
  nameCache.set(file, entry);
  if (nameCache.size > NAME_CACHE_LIMIT) {
    nameCache.delete(nameCache.keys().next().value);
  }
}

/**
 * The latest session_info name anywhere in the file, matching official
 * SessionManager.getSessionName(). Auto titles are appended after the first
 * turn, so they can sit far past the head/tail windows used for the preview.
 */
function latestSessionName(file, stat) {
  const cached = nameCache.get(file);
  if (
    cached &&
    cached.ino === stat.ino &&
    cached.size === stat.size &&
    cached.mtimeMs === stat.mtimeMs
  ) {
    return cached.name;
  }

  const tail = scanTailName(file);
  if (tail) {
    rememberName(file, {
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      name: tail.name,
      scanned: tail.scanned,
      carry: Buffer.alloc(0),
    });
    return tail.name;
  }

  // Only resume from the previous watermark when it is the same file (same
  // inode). An atomically replaced file reuses the path but not the content, so
  // its earlier lines must be scanned again.
  const appended =
    cached && cached.ino === stat.ino && stat.size >= cached.scanned && stat.size > cached.size;
  const result = appended
    ? scanNameRange(file, cached.scanned, stat.size, cached.name)
    : scanNameRange(file, 0, stat.size, "");
  rememberName(file, {
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    name: result.name,
    scanned: result.scanned,
    carry: result.carry,
  });
  return result.name;
}

function readMeta(file) {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return null;
  }
  const head = scanHead(file);
  const name = latestSessionName(file, stat);
  if (!head.header && !head.title && !name) return null;

  const header = head.header;

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

/**
 * The title shown in the session list: explicit name first, then the first
 * user message (same cleanTitle as listSessions). Empty when there is no
 * real title — callers may fall back to an unnamed label.
 * Only reads the given session file, never walks the workspace.
 */
export function visibleSessionTitle(file, { liveName } = {}) {
  const fromState = String(liveName || "").trim();
  if (fromState) return fromState;
  if (!file) return "";
  const meta = readMeta(file);
  if (!meta) return "";
  const fromFile = String(meta.name || "").trim();
  if (fromFile) return fromFile;
  const derived = String(meta.title || "").trim();
  if (derived && derived !== "新会话") return derived;
  return "";
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
