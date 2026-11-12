/**
 * Upload / preview / download helpers.
 * Reads accept any readable regular file; relative paths resolve from the
 * current workspace. New uploads go to the EasyPI project's own isolated
 * folder, so the absolute stored path remains readable after a switch.
 */
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENTS = 6;
export const MAX_PREVIEW_BYTES = 1 * 1024 * 1024;
export const UPLOAD_DIR_SEGMENTS = ["uploads"];

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic", ".heif"]);
const TEXT_EXT = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml",
  ".xml", ".log", ".ini", ".cfg", ".conf", ".css", ".js", ".mjs", ".cjs", ".ts",
  ".tsx", ".jsx", ".html", ".htm", ".svg", ".py", ".sh", ".bash", ".zsh", ".rb",
  ".go", ".rs", ".java", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".sql",
  ".toml", ".env", ".gitignore", ".rtf",
]);
const OFFICE_EXT = new Set([
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".pages", ".numbers", ".key", ".odt", ".ods", ".odp",
]);
const EXECUTABLE_EXT = new Set([".html", ".htm", ".svg", ".js", ".mjs", ".cjs", ".ts", ".jsx", ".tsx", ".php", ".wasm"]);

export class FileAccessError extends Error {
  constructor(message, status = 400, code = "bad_request") {
    super(message);
    this.name = "FileAccessError";
    this.status = status;
    this.code = code;
  }
}

export function isInsideRoot(rootReal, targetReal) {
  const root = rootReal.endsWith(sep) ? rootReal.slice(0, -1) : rootReal;
  return targetReal === root || targetReal.startsWith(root + sep);
}

/** Resolve existing prefixes so /var and /private/var compare equal on macOS. */
export function canonicalizePath(input) {
  const abs = resolve(String(input || ""));
  const tail = [];
  let current = abs;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    tail.unshift(basename(current));
    current = parent;
  }
  try {
    current = realpathSync(current);
  } catch {
    /* keep current */
  }
  return tail.length ? join(current, ...tail) : current;
}


export function safeBasename(name) {
  let base = String(name || "").replace(/\\/g, "/").split("/").pop() || "";
  base = base.replace(/\0/g, "").replace(/[\u0000-\u001f\u007f]/g, "");
  base = base.replace(/[<>:"|?*]/g, "_").trim();
  if (!base || /^\.+$/.test(base)) base = "file";
  const ext = extname(base);
  const stem = base.slice(0, base.length - ext.length) || "file";
  const max = 180;
  if ([...base].length > max) {
    const clipped = Array.from(stem).slice(0, Math.max(1, max - Array.from(ext).length)).join("");
    base = clipped + ext;
  }
  return base;
}

export function classifyFile(name) {
  const ext = extname(String(name || "")).toLowerCase();
  const office = OFFICE_EXT.has(ext);
  const image = IMAGE_EXT.has(ext) && ext !== ".svg";
  const text = TEXT_EXT.has(ext);
  const untrusted = EXECUTABLE_EXT.has(ext);
  let preview = "none";
  if (image) preview = "image";
  else if (text) preview = "text";
  let note = "";
  if (office) {
    note = "本界面不能解析 PDF / Office 等内容，需要 pi 用工具读取，或下载后用本机应用打开。";
  } else if (untrusted && text) {
    note = "此格式可能包含可执行内容，预览只显示文本，不会在页面里运行。";
  }
  return { ext, office, image, text, untrusted, preview, note };
}

export function resolveWorkspaceRoot(workspace) {
  const text = String(workspace || "").trim();
  if (!text) throw new FileAccessError("请先选择工作目录", 400, "no_workspace");
  let real;
  try {
    real = realpathSync(text);
    if (!statSync(real).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new FileAccessError("工作目录无法访问", 400, "no_workspace");
  }
  return real;
}

/**
 * Resolve a user-supplied path to a real, readable regular file.
 * Relative paths resolve from the selected workspace (normal `..` handling);
 * absolute paths may name any regular file the service OS user can read.
 * Symlinks are followed and the real path is normalized. No workspace
 * containment, deny list, or per-file grant applies to reads.
 */
export function resolveWorkspaceFile(workspace, rawPath, { allowMissing = false } = {}) {
  const wsReal = resolveWorkspaceRoot(workspace);
  const raw = String(rawPath || "").trim();
  if (!raw || raw.includes("\0")) throw new FileAccessError("无效的文件路径", 400, "invalid_path");

  const abs = canonicalizePath(isAbsolute(raw) ? resolve(raw) : resolve(wsReal, raw));
  const display = (real) => {
    const rel = relative(wsReal, real);
    return isInsideRoot(wsReal, real) && rel ? rel : basename(real);
  };

  if (existsSync(abs)) {
    let real;
    try {
      real = realpathSync(abs);
    } catch {
      throw new FileAccessError("文件无法访问", 404, "not_found");
    }
    const stat = statSync(real);
    if (!stat.isFile()) throw new FileAccessError("这不是文件", 400, "not_file");
    try {
      accessSync(real, fsConstants.R_OK);
    } catch {
      throw new FileAccessError("文件无法读取", 403, "not_readable");
    }
    return { path: real, root: wsReal, exists: true, stat, relativePath: display(real) };
  }

  if (!allowMissing) throw new FileAccessError("找不到这个文件", 404, "not_found");
  return { path: abs, root: wsReal, exists: false, stat: null, relativePath: display(abs) };
}

/** Canonical project uploads folder; any symlink redirection is rejected. */
export function resolveProjectUploads(projectRoot) {
  let root;
  try {
    root = realpathSync(projectRoot);
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new FileAccessError("项目目录无法访问", 500, "project_root");
  }
  // The canonical candidate must be exactly the project's own uploads subtree,
  // so a symlinked uploads directory (or a symlinked project root resolving
  // elsewhere) cannot widen the read scope.
  const expected = join(root, ...UPLOAD_DIR_SEGMENTS);
  const dir = canonicalizePath(expected);
  if (dir !== expected) {
    throw new FileAccessError("上传目录无效", 500, "upload_dir");
  }
  return { root, dir };
}

export function ensureUploadDir(projectRoot) {
  const { root, dir } = resolveProjectUploads(projectRoot);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dirReal = realpathSync(dir);
  if (dirReal !== dir) {
    throw new FileAccessError("上传目录无效", 500, "upload_dir");
  }
  return { root, dir: dirReal };
}

export function saveUpload(projectRoot, originalName, buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || []);
  if (buffer.length > MAX_FILE_BYTES) {
    throw new FileAccessError("文件过大（上限 20MB）", 413, "too_large");
  }
  const { root, dir } = ensureUploadDir(projectRoot);
  const displayName = safeBasename(originalName);
  const storedName = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}-${displayName}`;
  const dest = join(dir, storedName);
  if (!isInsideRoot(dir, dest)) throw new FileAccessError("上传文件名无效", 400, "invalid_path");

  const fd = openSync(dest, "wx", 0o600);
  try {
    writeSync(fd, buffer);
  } catch (error) {
    try { closeSync(fd); } catch { /* ignore */ }
    try { unlinkSync(dest); } catch { /* ignore */ }
    throw error;
  }
  closeSync(fd);

  let real;
  try {
    real = realpathSync(dest);
  } catch (error) {
    try { unlinkSync(dest); } catch { /* ignore */ }
    throw error;
  }
  if (!isInsideRoot(dir, real) || !isInsideRoot(root, real)) {
    try { unlinkSync(real); } catch { /* ignore */ }
    throw new FileAccessError("上传路径越界", 500, "outside");
  }

  const info = classifyFile(displayName);
  return {
    path: real,
    name: displayName,
    storedName,
    size: buffer.length,
    relativePath: relative(root, real).replace(/\\/g, "/"),
    preview: info.preview,
    note: info.note,
    office: info.office,
  };
}

export function contentDisposition(filename, kind = "attachment") {
  const raw = safeBasename(filename);
  const ascii = raw.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "file";
  const encoded = encodeURIComponent(raw).replace(/['()]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function previewPayload(filePath, info, { limit = MAX_PREVIEW_BYTES } = {}) {
  const classify = info || classifyFile(filePath);
  const stat = statSync(filePath);
  if (classify.preview === "none") {
    return { preview: "none", note: classify.note || "此格式不在本界面预览，请下载后查看。" };
  }
  if (classify.preview === "image") {
    if (stat.size > MAX_FILE_BYTES) throw new FileAccessError("图片过大，请下载查看", 413, "too_large");
    return { preview: "image", note: classify.note || "" };
  }
  if (stat.size > limit) {
    return { preview: "none", note: "文件超过 1MB，预览已省略，请下载后查看。" };
  }
  const buf = readFileSync(filePath);
  if (buf.includes(0)) {
    return { preview: "none", note: "这是二进制文件，本界面不预览，请下载后查看。" };
  }
  const text = buf.toString("utf8");
  return { preview: "text", text, note: classify.note || "" };
}

export function fileHeaders({ mode, filename, mediaType }) {
  const download = mode === "download";
  const untrusted = EXECUTABLE_EXT.has(extname(String(filename || "")).toLowerCase());
  const type = download || untrusted || !mediaType ? "application/octet-stream" : mediaType;
  const disposition = contentDisposition(filename || "file", download || untrusted ? "attachment" : "inline");
  return {
    "content-type": type,
    "content-disposition": disposition,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    "x-frame-options": "DENY",
  };
}

export function imageMediaType(name) {
  const ext = extname(String(name || "")).toLowerCase();
  return {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".heic": "image/heic",
    ".heif": "image/heif",
  }[ext] || "application/octet-stream";
}

export function parseFilenameHeader(value) {
  if (!value) return "file";
  try {
    return safeBasename(decodeURIComponent(String(value)));
  } catch {
    return safeBasename(String(value));
  }
}

export function isTrustedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  if (!host) return false;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return parsed.host === host;
}

export async function readRawBody(req, limit = MAX_FILE_BYTES) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (error) => {
      if (done) return;
      done = true;
      req.removeAllListeners("data");
      req.on("data", () => {});
      rejectBody(error);
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        fail(new FileAccessError("文件过大（上限 20MB）", 413, "too_large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolveBody(Buffer.concat(chunks));
    });
    req.on("error", (error) => fail(error));
  });
}

