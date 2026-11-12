import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "public/sw.js"), "utf8");

describe("service worker cache policy", () => {
  it("uses a versioned cache name and does not intercept /api/*", () => {
    assert.match(source, /const CACHE_NAME = "pi-webui-v15"/);
    assert.match(source, /url\.pathname\.startsWith\("\/api\/"\)/);
    const fetchHandler = source.slice(source.indexOf('self.addEventListener("fetch"'));
    const apiGuard = fetchHandler.indexOf('url.pathname.startsWith("/api/")');
    const returnIdx = fetchHandler.indexOf("return;", apiGuard);
    assert.ok(apiGuard >= 0 && returnIdx > apiGuard);
    const between = fetchHandler.slice(apiGuard, returnIdx + 8);
    assert.match(between, /return;/);
    assert.doesNotMatch(source, /cache\.(put|add).*\/api\/(upload|file)/);
    assert.match(source, /\/api\/upload/);
    assert.match(source, /\/api\/file/);
    assert.match(source, /\/api\/sessions\/search/);
    assert.match(source, /\/api\/session\/export/);
    assert.match(source, /\/api\/session\/branch/);
  });
  it("only pre-caches the shell, not upload or file APIs", () => {
    const start = source.indexOf("const SHELL_ASSETS");
    const end = source.indexOf("];", start);
    const block = source.slice(start, end + 2);
    assert.doesNotMatch(block, /\/api\//);
    assert.match(block, /\/js\/task-status\.js/);
  });
});
