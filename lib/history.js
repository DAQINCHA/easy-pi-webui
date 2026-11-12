/**
 * 当前工作区会话的只读历史：正文搜索与导出。
 * 不 spawn pi、不发模型请求、不读工作区以外的会话文件。
 */
import { createReadStream, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { canonicalizePath, contentDisposition, FileAccessError, isInsideRoot, safeBasename } from "./files.js";
import { messageText, sessionsDir } from "./sessions.js";

export const MAX_QUERY_LENGTH = 200;
export const MAX_RESULTS = 50;
export const MAX_SESSION_FILES = 2000;
export const MAX_SCAN_BYTES = 64 * 1024 * 1024;
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_LINE_BYTES = 4 * 1024 * 1024;
export const SCAN_TIME_MS = 4000;
export const SNIPPET_RADIUS = 48;

export function normalizeQuery(query) {
  return String(query || "").replace(/\s+/g, " ").trim();
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function makeSearcher(query) {
  const normalized = normalizeQuery(query);
  if (!normalized) return null;
  if (normalized.length > MAX_QUERY_LENGTH) {
    const error = new FileAccessError("搜索词过长", 400, "query_too_long");
    throw error;
  }
  const pattern = escapeRegExp(normalized).split(" ").join("\\s+");
  return {
    query: normalized,
    re: new RegExp(pattern, "i"),
    test(text) {
      return this.re.test(String(text || ""));
    },
  };
}

export function visibleText(message) {
  return messageText(message || {}).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function messageHasImages(message) {
  const content = message && message.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => block && (block.type === "image" || block.type === "image_url"));
}

export function messageHasTools(message) {
  const content = message && message.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    const type = block && block.type;
    return type === "toolCall" || type === "tool_use" || type === "toolcall" || type === "toolResult" || type === "tool_result";
  });
}

function parseLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return { ok: true, empty: true };
  try {
    return { ok: true, entry: JSON.parse(trimmed) };
  } catch {
    return { ok: false };
  }
}

export function isSearchableMessage(item) {
  return Boolean(item && item.searchable && (item.role === "user" || item.role === "assistant"));
}

function extractEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const id = entry.id || "";
  const parentId = entry.parentId || "";
  const timestamp = entry.timestamp || "";
  if (entry.type === "session") {
    return {
      kind: "header",
      id: entry.id || "",
      cwd: entry.cwd || null,
      timestamp: entry.timestamp || "",
      parentSession: entry.parentSession || null,
      graph: false,
      searchable: false,
    };
  }
  if (entry.type === "session_info") {
    return {
      kind: "info",
      name: typeof entry.name === "string" ? entry.name : "",
      id,
      parentId,
      timestamp,
      graph: Boolean(id || parentId),
      searchable: false,
    };
  }
  if (entry.type === "message" && entry.message) {
    const message = entry.message;
    const role = message.role;
    const searchable = role === "user" || role === "assistant";
    return {
      kind: "message",
      id: entry.id || message.id || "",
      parentId: entry.parentId || message.parentId || "",
      timestamp: entry.timestamp || message.timestamp || "",
      role,
      text: searchable ? visibleText(message) : "",
      hasImages: searchable && messageHasImages(message),
      hasTools: messageHasTools(message),
      searchable,
      graph: true,
    };
  }
  // model_change / thinking_level_change 等也会出现在 parentId 链上，
  // 必须作为图节点保留，否则活动分支会断成只剩最后一条消息。
  if (id || parentId) {
    return {
      kind: entry.type || "other",
      id,
      parentId,
      timestamp,
      role: "",
      text: "",
      searchable: false,
      graph: true,
    };
  }
  return { kind: "other", graph: false, searchable: false };
}

export function activeBranch(messages, options = {}) {
  const list = Array.isArray(messages)
    ? messages.filter((item) => item && item.graph !== false && (item.id || item.kind === "message"))
    : [];
  if (!list.length) return [];
  const byId = new Map();
  for (const item of list) {
    if (item.id) byId.set(item.id, item);
  }
  if (!byId.size) return list.slice();

  // Default leaf is the last appended graph entry, matching pi SessionManager._buildIndex
  // on reload. A live leafId from RPC can override this while a process is running.
  let leaf = list[list.length - 1];
  if (options.leafId && byId.has(options.leafId)) leaf = byId.get(options.leafId);

  const path = [];
  const seen = new Set();
  let current = leaf;
  while (current && !seen.has(current.id || current)) {
    path.push(current);
    seen.add(current.id || current);
    current = current.parentId ? byId.get(current.parentId) : null;
  }
  path.reverse();
  return path;
}

export function parseSessionEntries(text, options = {}) {
  const maxLine = options.maxLineBytes || MAX_LINE_BYTES;
  const lines = String(text || "").split(/\n/);
  const messages = [];
  const result = { header: null, name: "", messages, skippedBad: 0, truncated: false };
  for (const line of lines) {
    if (Buffer.byteLength(line, "utf8") > maxLine) {
      result.skippedBad += 1;
      result.truncated = true;
      continue;
    }
    const parsed = parseLine(line);
    if (parsed.empty) continue;
    if (!parsed.ok) {
      result.skippedBad += 1;
      continue;
    }
    const item = extractEntry(parsed.entry);
    if (!item) continue;
    if (item.kind === "header") result.header = item;
    if (item.kind === "info" && item.name) result.name = item.name;
    if (item.kind !== "header" && item.graph !== false && (item.id || item.kind === "message" || item.kind === "info")) {
      messages.push(item);
    }
  }
  return result;
}

async function readSessionEntries(file, options = {}) {
  const maxFile = options.maxFileBytes || MAX_FILE_BYTES;
  const maxLine = options.maxLineBytes || MAX_LINE_BYTES;
  const messages = [];
  const result = { header: null, name: "", messages, skippedBad: 0, truncated: false, bytes: 0 };
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return result;
  }
  if (!size) return result;
  if (size > maxFile) result.truncated = true;

  const stream = createReadStream(file, { encoding: "utf8", end: Math.max(0, Math.min(size, maxFile) - 1) });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let bytes = 0;
  try {
    for await (const line of rl) {
      bytes += Buffer.byteLength(line, "utf8") + 1;
      result.bytes = bytes;
      if (Buffer.byteLength(line, "utf8") > maxLine) {
        result.skippedBad += 1;
        result.truncated = true;
        continue;
      }
      const parsed = parseLine(line);
      if (parsed.empty) continue;
      if (!parsed.ok) {
        result.skippedBad += 1;
        continue;
      }
      const item = extractEntry(parsed.entry);
      if (!item) continue;
      if (item.kind === "header") result.header = item;
      if (item.kind === "info" && item.name) result.name = item.name;
      if (item.kind !== "header" && item.graph !== false && (item.id || item.kind === "message" || item.kind === "info")) {
        messages.push(item);
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return result;
}

export function resolveSessionFile(file, cwd) {
  if (typeof file !== "string" || !file.endsWith(".jsonl")) {
    throw new FileAccessError("无效的会话文件", 400, "invalid_session");
  }
  const root = sessionsDir(cwd);
  let rootReal;
  try {
    rootReal = canonicalizePath(root);
  } catch {
    throw new FileAccessError("无效的会话目录", 403, "forbidden");
  }
  const real = canonicalizePath(file);
  if (!isInsideRoot(rootReal, real)) {
    throw new FileAccessError("会话不在当前工作区", 403, "forbidden");
  }
  try {
    const st = statSync(real);
    if (!st.isFile()) throw new FileAccessError("无效的会话文件", 400, "invalid_session");
  } catch (error) {
    if (error instanceof FileAccessError) throw error;
    throw new FileAccessError("找不到这个会话", 404, "not_found");
  }
  return { file: resolve(file), real, root: rootReal };
}

export function listSessionFiles(cwd, { limit = MAX_SESSION_FILES } = {}) {
  const dir = sessionsDir(cwd);
  let rootReal;
  try {
    rootReal = canonicalizePath(dir);
  } catch {
    return [];
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (!entry.name.endsWith(".jsonl")) continue;
    const lexical = join(dir, entry.name);
    let real;
    try {
      real = canonicalizePath(lexical);
      if (!isInsideRoot(rootReal, real)) continue;
      const st = statSync(real);
      if (!st.isFile()) continue;
      files.push({ file: lexical, real, mtime: st.mtimeMs, size: st.size, updatedAt: st.mtime.toISOString() });
    } catch {
      /* skip unreadable or escaping entries */
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, limit);
}

export function extractSnippet(text, searcher) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!searcher) return value.slice(0, SNIPPET_RADIUS * 2);
  const match = searcher.re.exec(value);
  if (!match) return value.slice(0, SNIPPET_RADIUS * 2);
  const start = Math.max(0, match.index - SNIPPET_RADIUS);
  const end = Math.min(value.length, match.index + match[0].length + SNIPPET_RADIUS);
  let snippet = value.slice(start, end);
  if (start > 0) snippet = "…" + snippet;
  if (end < value.length) snippet += "…";
  return snippet;
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

export function highlightSnippet(text, searcher) {
  const value = String(text || "");
  if (!searcher) return escapeHtml(value);
  const re = new RegExp(searcher.re.source, "gi");
  let last = 0;
  let out = "";
  let match;
  while ((match = re.exec(value))) {
    out += escapeHtml(value.slice(last, match.index));
    out += "<mark>" + escapeHtml(match[0]) + "</mark>";
    last = match.index + match[0].length;
    if (match[0].length === 0) re.lastIndex += 1;
  }
  out += escapeHtml(value.slice(last));
  return out;
}

function sessionLabel(parsed, fallbackFile) {
  const name = parsed.name || "";
  const first = (parsed.messages || []).find((item) => item.role === "user" && item.text);
  const title = first ? first.text.slice(0, 80) : name || basename(fallbackFile || "").replace(/\.jsonl$/, "") || "未命名会话";
  return { name, title };
}

export async function searchWorkspaceSessions(cwd, query, options = {}) {
  const searcher = makeSearcher(query);
  if (!searcher) {
    return { query: "", results: [], scanned: 0, total: 0, truncated: false, truncatedReason: "" };
  }
  const started = Date.now();
  const timeLimit = options.timeLimitMs || SCAN_TIME_MS;
  const byteLimit = options.maxScanBytes || MAX_SCAN_BYTES;
  const resultLimit = options.maxResults || MAX_RESULTS;
  const archive = options.archive || {};
  const pinned = options.pinned || {};
  const files = listSessionFiles(cwd, { limit: options.maxFiles || MAX_SESSION_FILES });
  const listed = files.length;
  const results = [];
  let scanned = 0;
  let bytes = 0;
  let truncated = false;
  let truncatedReason = "";

  for (const item of files) {
    if (Date.now() - started > timeLimit) {
      truncated = true;
      truncatedReason = "time";
      break;
    }
    if (bytes >= byteLimit) {
      truncated = true;
      truncatedReason = "bytes";
      break;
    }
    scanned += 1;
    let parsed;
    try {
      parsed = await readSessionEntries(item.file, options);
    } catch {
      continue;
    }
    bytes += parsed.bytes || item.size || 0;
    const branch = activeBranch(parsed.messages);
    const visible = branch.filter(isSearchableMessage);
    const labels = sessionLabel({ ...parsed, messages: visible }, item.file);
    const titleText = (labels.name + " " + labels.title).trim();
    const bodyText = visible.map((msg) => msg.text).filter(Boolean).join("\n");
    const titleHit = searcher.test(titleText);
    const bodyHit = !titleHit && searcher.test(bodyText);
    if (!titleHit && !bodyHit) continue;

    let snippet = "";
    let messageIndex = -1;
    let quote = "";
    if (titleHit) {
      snippet = extractSnippet(titleText, searcher) || labels.title;
    } else {
      for (let i = 0; i < visible.length; i += 1) {
        if (searcher.test(visible[i].text)) {
          messageIndex = i;
          snippet = extractSnippet(visible[i].text, searcher);
          quote = visible[i].text.slice(0, 200);
          break;
        }
      }
    }
    results.push({
      file: item.file,
      id: (parsed.header && parsed.header.id) || basename(item.file).replace(/\.jsonl$/, ""),
      name: labels.name,
      title: labels.title,
      updatedAt: item.updatedAt,
      archived: Boolean(archive[item.file]),
      pinned: Boolean(pinned[item.file]),
      match: titleHit ? "title" : "body",
      snippet,
      messageIndex,
      quote,
    });
    if (results.length >= resultLimit) {
      if (scanned < listed) {
        truncated = true;
        truncatedReason = truncatedReason || "results";
      }
      break;
    }
  }

  if (!truncated && listed >= (options.maxFiles || MAX_SESSION_FILES)) {
    // Directory listing itself was capped.
    truncated = true;
    truncatedReason = truncatedReason || "files";
  }

  return {
    query: searcher.query,
    results,
    scanned,
    total: listed,
    truncated,
    truncatedReason,
  };
}

export function exportFileName(title, ext) {
  const date = new Date();
  const stamp = date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
  const stem = safeBasename((title || "会话") + "-" + stamp);
  const suffix = ext.startsWith(".") ? ext : "." + ext;
  return stem.endsWith(suffix) ? stem : stem + suffix;
}

function rewriteOneLink(label, href) {
  const url = String(href || "").trim();
  if (/^(javascript|vbscript|data):/i.test(url)) return label || "";
  if (/^https?:/i.test(url) || /^mailto:/i.test(url)) return "[" + label + "](" + url + ")";
  if (/\/api\//i.test(url)) return label + "（页面接口链接已去掉，离线无效）";
  return label + "（本地文件路径离线无法打开）";
}

function rewriteExportText(text) {
  const input = String(text || "");
  let out = "";
  let i = 0;
  while (i < input.length) {
    if (input[i] === "[") {
      const mid = input.indexOf("](", i);
      if (mid > i) {
        let depth = 1;
        let j = mid + 2;
        while (j < input.length && depth > 0) {
          if (input[j] === "(") depth += 1;
          else if (input[j] === ")") depth -= 1;
          if (depth > 0) j += 1;
        }
        if (depth === 0) {
          out += rewriteOneLink(input.slice(i + 1, mid), input.slice(mid + 2, j));
          i = j + 1;
          continue;
        }
      }
    }
    out += input[i];
    i += 1;
  }
  return out;
}

function safeHref(url) {
  const value = String(url || "").trim();
  if (/^https?:/i.test(value) || /^mailto:/i.test(value)) return value;
  return "";
}

export function renderSafeMarkdown(src) {
  const text = rewriteExportText(src);
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  let html = "";
  let i = 0;
  const flushPara = (buf) => {
    const body = buf.join("\n").trim();
    if (body) html += "<p>" + renderInline(body) + "</p>";
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```[ \t]*([\w-]*)\s*$/);
    if (fence) {
      const lang = fence[1] || "";
      const chunk = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        chunk.push(lines[i]);
        i += 1;
      }
      html += "<pre><code" + (lang ? ' data-lang="' + escapeHtml(lang) + '"' : "") + ">" + escapeHtml(chunk.join("\n")) + "</code></pre>";
      i += 1;
      continue;
    }
    if (/^(\s*)- /.test(line) || /^\s*\d+\. /.test(line)) {
      const ordered = /^\s*\d+\. /.test(line);
      const items = [];
      while (i < lines.length && (ordered ? /^\s*\d+\. /.test(lines[i]) : /^(\s*)- /.test(lines[i]))) {
        items.push(lines[i].replace(/^\s*(?:- |\d+\. )/, ""));
        i += 1;
      }
      const tag = ordered ? "ol" : "ul";
      html += "<" + tag + ">" + items.map((item) => "<li>" + renderInline(item) + "</li>").join("") + "</" + tag + ">";
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const tag = "h" + (heading[1].length + 2);
      html += "<" + tag + ">" + renderInline(heading[2]) + "</" + tag + ">";
      i += 1;
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const buf = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !/^```/.test(lines[i]) && !/^(\s*)- /.test(lines[i]) && !/^\s*\d+\. /.test(lines[i]) && !/^#{1,3}\s+/.test(lines[i])) {
      buf.push(lines[i]);
      i += 1;
    }
    flushPara(buf);
  }
  return html || "<p></p>";
}

function renderInline(src) {
  const value = String(src || "");
  let out = "";
  let i = 0;
  while (i < value.length) {
    if (value[i] === "`") {
      const end = value.indexOf("`", i + 1);
      if (end > i) {
        out += "<code>" + escapeHtml(value.slice(i + 1, end)) + "</code>";
        i = end + 1;
        continue;
      }
    }
    if (value.startsWith("**", i)) {
      const end = value.indexOf("**", i + 2);
      if (end > i) {
        out += "<strong>" + renderInline(value.slice(i + 2, end)) + "</strong>";
        i = end + 2;
        continue;
      }
    }
    if (value[i] === "[") {
      const mid = value.indexOf("](", i);
      if (mid > i) {
        let depth = 1;
        let end = mid + 2;
        while (end < value.length && depth > 0) {
          if (value[end] === "(") depth += 1;
          else if (value[end] === ")") depth -= 1;
          if (depth > 0) end += 1;
        }
        if (depth === 0) {
          const label = value.slice(i + 1, mid);
          const href = safeHref(value.slice(mid + 2, end));
          if (href) out += '<a href="' + escapeHtml(href) + '" rel="noreferrer noopener">' + escapeHtml(label) + "</a>";
          else out += escapeHtml(label);
          i = end + 1;
          continue;
        }
      }
    }
    out += escapeHtml(value[i]);
    i += 1;
  }
  return out;
}

export function buildMarkdownExport(view) {
  const lines = [];
  lines.push("# " + (view.title || "未命名会话"));
  if (view.name && view.name !== view.title) lines.push("");
  if (view.name && view.name !== view.title) lines.push("会话名：" + view.name);
  lines.push("");
  lines.push(view.scopeNote);
  if (view.warning) {
    lines.push("");
    lines.push("> " + view.warning);
  }
  lines.push("");
  if (!view.messages.length) {
    lines.push("这个会话还没有可见的对话正文。");
  }
  for (const message of view.messages) {
    const who = message.role === "user" ? "你" : "助手";
    const when = formatTime(message.timestamp);
    lines.push("## " + who + (when ? " · " + when : ""));
    lines.push("");
    const body = rewriteExportText(message.text || "").trim();
    lines.push(body || "（没有可见正文）");
    if (message.hasImages) {
      lines.push("");
      lines.push("（原对话中有图片，离线文档无法附带，不能当作已打包。）");
    }
    lines.push("");
  }
  return lines.join("\n").trim() + "\n";
}

export function buildHtmlExport(view) {
  const title = view.title || "未命名会话";
  const generated = view.generatedAt || new Date().toISOString();
  const sections = view.messages.length
    ? view.messages.map((message) => {
      const who = message.role === "user" ? "你" : "助手";
      const when = formatTime(message.timestamp);
      let body = renderSafeMarkdown(message.text || "（没有可见正文）");
      if (message.hasImages) {
        body += "<p class=\"note\">原对话中有图片，离线文档无法附带，不能当作已打包。</p>";
      }
      return (
        '<section class="msg ' + escapeHtml(message.role) + '">' +
        "<h2>" + escapeHtml(who) + (when ? " <span>" + escapeHtml(when) + "</span>" : "") + "</h2>" +
        '<div class="body">' + body + "</div>" +
        "</section>"
      );
    }).join("\n")
    : '<p class="empty">这个会话还没有可见的对话正文。</p>';

  const warning = view.warning ? '<p class="warn">' + escapeHtml(view.warning) + "</p>" : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; script-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none';">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0 auto; max-width: 720px; padding: 32px 20px 64px; font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #222; }
  header { margin-bottom: 28px; padding-bottom: 16px; border-bottom: 1px solid #d8d8d8; }
  h1 { font-size: 1.6rem; margin: 0 0 8px; }
  .meta, .note, .warn, .empty, footer { color: #555; font-size: 0.92rem; }
  .warn { background: #fff6e5; border: 1px solid #e8d2a0; padding: 8px 12px; border-radius: 8px; }
  section.msg { margin: 22px 0; }
  section.msg h2 { font-size: 0.92rem; margin: 0 0 8px; color: #555; }
  section.msg h2 span { font-weight: 400; }
  section.user .body { background: #f3f6fb; border-radius: 12px; padding: 10px 14px; }
  pre { overflow: auto; padding: 12px; border-radius: 8px; background: #111; color: #f5f5f5; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
  p code { background: rgba(127,127,127,.15); padding: 0 .25em; border-radius: 4px; }
  a { color: inherit; text-decoration: underline; }
  footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #d8d8d8; }
  @media (prefers-color-scheme: dark) {
    body { color: #eee; background: #151515; }
    .meta, .note, .warn, .empty, footer { color: #bbb; }
    section.user .body { background: #222831; }
    .warn { background: #3a2e14; border-color: #8a732e; }
    header, footer { border-color: #333; }
  }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  ${view.name && view.name !== title ? "<p class=\"meta\">会话名：" + escapeHtml(view.name) + "</p>" : ""}
  <p class="meta">${escapeHtml(view.scopeNote)}</p>
  <p class="note">导出时间：${escapeHtml(formatTime(generated) || generated)}</p>
  ${warning}
</header>
<main>
${sections}
</main>
<footer>由 Easy-Pi WebUI 导出。本文不包含隐藏的思考过程、工具原始输出或密钥。文中的本地文件路径在离线打开时无法访问，也不含任何服务凭证。</footer>
</body>
</html>
`;
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return y + "-" + m + "-" + d + " " + hh + ":" + mm;
}

export function makeExportView(parsed, options = {}) {
  const branch = activeBranch(parsed.messages || []).filter(isSearchableMessage);
  const labels = sessionLabel({ ...parsed, messages: branch }, options.file || "");
  const visible = branch.filter((item) => item.text || item.hasImages);
  const scopeNote = "范围：当前会话的活动分支（重新生成后被放弃的对话不会包含在内）。默认只导出你和助手的可见正文，不含思考过程和工具原始输出。";
  let warning = "";
  if (options.streaming) warning = "导出时对话还在进行，以下是到目前为止已经保存的内容，不一定是最终回复。";
  else if (!visible.length) warning = "";
  return {
    id: (parsed.header && parsed.header.id) || "",
    name: rewriteExportText(labels.name),
    title: rewriteExportText(labels.title).replace(/\s+/g, " ").trim() || labels.title,
    createdAt: (parsed.header && parsed.header.timestamp) || "",
    messages: visible,
    scopeNote,
    warning,
    generatedAt: options.generatedAt || new Date().toISOString(),
  };
}

export async function exportSessionFile(file, cwd, { format = "md", streaming = false, generatedAt } = {}) {
  const resolved = resolveSessionFile(file, cwd);
  const parsed = await readSessionEntries(resolved.real);
  const view = makeExportView(parsed, { file: resolved.file, streaming, generatedAt });
  const fmt = format === "html" ? "html" : "md";
  const body = fmt === "html" ? buildHtmlExport(view) : buildMarkdownExport(view);
  const filename = exportFileName(view.title, fmt === "html" ? ".html" : ".md");
  const type = fmt === "html" ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8";
  return {
    filename,
    type,
    body,
    headers: {
      "content-type": type,
      "content-disposition": contentDisposition(filename, "attachment"),
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'; sandbox",
    },
  };
}
