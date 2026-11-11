import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

export function serveStatic(root, req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    return false;
  }
  if (pathname === "/") pathname = "/index.html";

  const full = normalize(join(root, pathname));
  if (full !== root && !full.startsWith(root + sep)) {
    res.writeHead(403).end("forbidden");
    return true;
  }

  let stat;
  try {
    stat = statSync(full);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  res.writeHead(200, {
    "content-type": MIME[extname(full).toLowerCase()] || "application/octet-stream",
    "content-length": stat.size,
    "cache-control": "no-store",
  });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  createReadStream(full).pipe(res);
  return true;
}

export function publicRoot(url) {
  return resolve(url);
}
