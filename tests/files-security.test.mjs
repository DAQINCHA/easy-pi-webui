import assert from "node:assert/strict";
import {
  mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  MAX_FILE_BYTES,
  UPLOAD_DIR_SEGMENTS,
  classifyFile,
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

function tempProject() {
  const dir = mkdtempSync(join(tmpdir(), "epw-project-"));
  const project = join(dir, "project");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "sibling.txt"), "project sibling");
  return { dir, project };
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
  it("resolves relative traversal normally", () => {
    const ws = tempWorkspace();
    const name = "epw-rel-outside-" + Date.now() + ".txt";
    writeFileSync(join(tmpdir(), name), "sibling");
    assert.equal(readFileSync(resolveWorkspaceFile(ws, "../" + name).path, "utf8"), "sibling");
    assert.equal(readFileSync(resolveWorkspaceFile(ws, "sub/../hello.txt").path, "utf8"), "你好世界");
  });
  it("resolves encoded traversal once decoded", () => {
    const ws = tempWorkspace();
    const name = "epw-encoded-" + Date.now() + ".txt";
    writeFileSync(join(tmpdir(), name), "encoded");
    const decoded = decodeURIComponent("%2e%2e%2f" + encodeURIComponent(name));
    assert.equal(readFileSync(resolveWorkspaceFile(ws, decoded).path, "utf8"), "encoded");
  });
  it("follows workspace symlinks to external files", () => {
    const ws = tempWorkspace();
    const outside = join(tmpdir(), "epw-outside-" + Date.now() + ".txt");
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(ws, "link.txt"));
    const got = resolveWorkspaceFile(ws, "link.txt");
    assert.equal(got.path, realpathSync(outside));
    assert.equal(readFileSync(got.path, "utf8"), "secret");
  });
  it("accepts absolute paths outside the workspace", () => {
    const ws = tempWorkspace();
    const name = "epw-abs-outside-" + Date.now() + ".txt";
    const outside = join(tmpdir(), name);
    writeFileSync(outside, "outside");
    const got = resolveWorkspaceFile(ws, outside);
    assert.equal(got.path, realpathSync(outside));
    assert.equal(got.relativePath, name);
    assert.equal(readFileSync(got.path, "utf8"), "outside");
  });
  it("rejects invalid, missing, and directory paths", () => {
    const ws = tempWorkspace();
    assert.throws(() => resolveWorkspaceFile(ws, ""), (error) => error.code === "invalid_path");
    assert.throws(() => resolveWorkspaceFile(ws, "bad\0name"), (error) => error.code === "invalid_path");
    assert.throws(() => resolveWorkspaceFile(ws, "missing.bin"), (error) => error.code === "not_found");
    assert.throws(() => resolveWorkspaceFile(ws, "sub"), (error) => error.code === "not_file");
  });
});

describe("saveUpload", () => {
  it("stores unique names under the project uploads root, not the workspace", () => {
    const ws = tempWorkspace();
    const { project } = tempProject();
    const uploads = join(realpathSync(project), ...UPLOAD_DIR_SEGMENTS);
    const a = saveUpload(project, "同名.txt", Buffer.from("one"));
    const b = saveUpload(project, "同名.txt", Buffer.from("two"));
    assert.notEqual(a.path, b.path);
    assert.equal(readFileSync(a.path, "utf8"), "one");
    assert.equal(readFileSync(b.path, "utf8"), "two");
    assert.equal(a.name, "同名.txt");
    assert.ok(a.path.startsWith(uploads + "/"));
    assert.ok(!a.path.startsWith(realpathSync(ws) + "/"));
    assert.match(a.relativePath, /^uploads\//);
  });
  it("rejects an uploads symlink that points back at the project root", () => {
    const { project } = tempProject();
    symlinkSync(project, join(project, ...UPLOAD_DIR_SEGMENTS));
    assert.throws(() => saveUpload(project, "x.txt", Buffer.from("x")), (error) => error.code === "upload_dir");
    assert.ok(!readdirSync(project).includes("x.txt"));
  });
  it("rejects oversized buffers", () => {
    const { project } = tempProject();
    const huge = Buffer.alloc(MAX_FILE_BYTES + 1);
    assert.throws(() => saveUpload(project, "big.bin", huge), (error) => error.status === 413);
  });
  it("refuses an uploads symlink that leaves the project", () => {
    const { dir, project } = tempProject();
    const outside = join(dir, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(project, ...UPLOAD_DIR_SEGMENTS));
    assert.throws(() => saveUpload(project, "x.txt", Buffer.from("x")), (error) => error.code === "upload_dir");
    assert.deepEqual(readdirSync(outside), []);
  });
});

describe("project uploads read boundary", () => {
  it("reads project uploads and other absolute paths by real path", () => {
    const ws = tempWorkspace();
    const { dir, project } = tempProject();
    const uploads = join(realpathSync(project), ...UPLOAD_DIR_SEGMENTS);
    const saved = saveUpload(project, "note.txt", Buffer.from("uploaded"));
    assert.ok(saved.path.startsWith(uploads + "/"));
    const got = resolveWorkspaceFile(ws, saved.path);
    assert.equal(got.path, realpathSync(saved.path));
    assert.equal(got.root, realpathSync(ws));
    assert.equal(readFileSync(got.path, "utf8"), "uploaded");

    // relative upload-looking paths still resolve from the workspace
    assert.throws(
      () => resolveWorkspaceFile(ws, saved.relativePath),
      (error) => error.code === "not_found",
    );
    // project siblings and unrelated absolute paths are readable too
    assert.equal(
      readFileSync(resolveWorkspaceFile(ws, join(project, "sibling.txt")).path, "utf8"),
      "project sibling",
    );
    const external = join(dir, "external.txt");
    writeFileSync(external, "external");
    assert.equal(readFileSync(resolveWorkspaceFile(ws, external).path, "utf8"), "external");
  });

  it("keeps ordinary workspace files and legacy workspace-local uploads working", () => {
    const ws = tempWorkspace();
    const legacyDir = join(ws, ".easy-pi-webui", "uploads");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "old.txt"), "legacy");

    assert.equal(resolveWorkspaceFile(ws, "hello.txt").relativePath.replace(/\\/g, "/"), "hello.txt");
    assert.equal(readFileSync(resolveWorkspaceFile(ws, ".easy-pi-webui/uploads/old.txt").path, "utf8"), "legacy");

    // an old workspace file stays readable by absolute path from another workspace
    const other = tempWorkspace();
    assert.equal(
      readFileSync(resolveWorkspaceFile(other, join(ws, ".easy-pi-webui", "uploads", "old.txt")).path, "utf8"),
      "legacy",
    );
  });

  it("follows an uploaded-file symlink outside the uploads root for reads", () => {
    const ws = tempWorkspace();
    const { dir, project } = tempProject();
    const uploads = join(realpathSync(project), ...UPLOAD_DIR_SEGMENTS);
    saveUpload(project, "first.txt", Buffer.from("first"));
    const outside = join(dir, "secret.txt");
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(uploads, "link.txt"));
    const got = resolveWorkspaceFile(ws, join(uploads, "link.txt"));
    assert.equal(got.path, realpathSync(outside));
    assert.equal(readFileSync(got.path, "utf8"), "secret");
  });
});
