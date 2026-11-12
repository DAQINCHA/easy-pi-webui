import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  FileAccessError,
  MAX_FILE_BYTES,
  classifyFile,
  forbiddenRoots,
  resolveWorkspaceFile,
  safeBasename,
  saveUpload,
} from "../lib/files.js";

function tempWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "epw-ws-"));
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "hello.txt"), "你好世界");
  writeFileSync(join(dir, "sub", "note.md"), "# hi");
  return dir;
}

describe("safeBasename", () => {
  it("keeps Chinese names and strips path components", () => {
    assert.equal(safeBasename("报告.PDF"), "报告.PDF");
    assert.equal(safeBasename("../../etc/passwd"), "passwd");
    assert.equal(safeBasename("foo/bar/baz.txt"), "baz.txt");
    assert.equal(safeBasename("a\\b\\c.doc"), "c.doc");
  });
  it("neutralizes dangerous characters and empty names", () => {
    assert.equal(safeBasename('<>:"|?*.doc'), "_______.doc");
    assert.equal(safeBasename("."), "file");
    assert.equal(safeBasename(".."), "file");
    assert.equal(safeBasename(""), "file");
    assert.ok(safeBasename("a\u0000b.txt").includes("b.txt") || safeBasename("a\u0000b.txt") === "ab.txt");
  });
  it("keeps hidden file names", () => {
    assert.equal(safeBasename(".gitignore"), ".gitignore");
  });
});

describe("classifyFile", () => {
  it("labels office formats honestly and treats html/svg as text not executable preview kind image", () => {
    assert.equal(classifyFile("a.pdf").office, true);
    assert.equal(classifyFile("a.pdf").preview, "none");
    assert.match(classifyFile("a.docx").note, /不能解析/);
    assert.equal(classifyFile("x.svg").preview, "text");
    assert.equal(classifyFile("x.svg").untrusted, true);
    assert.equal(classifyFile("pic.png").preview, "image");
    assert.equal(classifyFile("notes.md").preview, "text");
  });
});

describe("resolveWorkspaceFile", () => {
  it("accepts relative and absolute paths inside the workspace", () => {
    const ws = tempWorkspace();
    const rel = resolveWorkspaceFile(ws, "hello.txt");
    assert.equal(readFileSync(rel.path, "utf8"), "你好世界");
    const abs = resolveWorkspaceFile(ws, join(ws, "sub", "note.md"));
    assert.equal(abs.relativePath.replace(/\\/g, "/"), "sub/note.md");
  });
  it("rejects lexical traversal", () => {
    const ws = tempWorkspace();
    assert.throws(() => resolveWorkspaceFile(ws, "../outside.txt"), FileAccessError);
    assert.throws(() => resolveWorkspaceFile(ws, join(ws, "..", "nope")), FileAccessError);
  });
  it("rejects encoded traversal once decoded", () => {
    const ws = tempWorkspace();
    const decoded = decodeURIComponent("%2e%2e/%2e%2e/etc/passwd");
    assert.throws(() => resolveWorkspaceFile(ws, decoded), FileAccessError);
  });
  it("rejects symlinks that escape the workspace", () => {
    const ws = tempWorkspace();
    const outside = join(tmpdir(), "epw-outside-" + Date.now());
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(ws, "link.txt"));
    assert.throws(() => resolveWorkspaceFile(ws, "link.txt"), (error) => {
      return error instanceof FileAccessError && error.code === "outside";
    });
  });
  it("rejects missing files and forbidden roots", () => {
    const ws = tempWorkspace();
    assert.throws(() => resolveWorkspaceFile(ws, "missing.bin"), (error) => error.code === "not_found");
    assert.throws(
      () => resolveWorkspaceFile(ws, "hello.txt", { denyRoots: [ws] }),
      (error) => error instanceof FileAccessError && error.code === "forbidden",
    );
  });
});

describe("saveUpload", () => {
  it("stores unique names and does not overwrite same original name", () => {
    const ws = tempWorkspace();
    const a = saveUpload(ws, "同名.txt", Buffer.from("one"));
    const b = saveUpload(ws, "同名.txt", Buffer.from("two"));
    assert.notEqual(a.path, b.path);
    assert.equal(readFileSync(a.path, "utf8"), "one");
    assert.equal(readFileSync(b.path, "utf8"), "two");
    assert.equal(a.name, "同名.txt");
    assert.match(a.relativePath, /^\.easy-pi-webui\/uploads\//);
  });
  it("rejects oversized buffers", () => {
    const ws = tempWorkspace();
    const huge = Buffer.alloc(MAX_FILE_BYTES + 1);
    assert.throws(() => saveUpload(ws, "big.bin", huge), (error) => error.status === 413);
  });
});
