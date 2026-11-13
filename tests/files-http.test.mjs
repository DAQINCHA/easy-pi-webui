import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { MAX_FILE_BYTES } from "../lib/files.js";
import { sessionsDir } from "../lib/sessions.js";
import { fileReq, startServer, upload } from "./helpers/harness.mjs";

describe("file upload / preview / download HTTP", () => {
  let server;

  before(async () => {
    server = await startServer();
  });

  after(async () => {
    if (server) await server.stop();
  });

  it("uploads content intact, including Chinese and duplicate names", async () => {
    const a = await upload(server.base, "报告.txt", Buffer.from("第一份内容", "utf8"));
    assert.equal(a.res.status, 200);
    assert.deepEqual(readFileSync(a.data.path), Buffer.from("第一份内容", "utf8"));
    const again = await upload(server.base, "报告.txt", Buffer.from("第二份内容", "utf8"));
    assert.equal(again.res.status, 200);
    assert.notEqual(a.data.path, again.data.path);
    assert.equal(a.data.name, "报告.txt");
    const down = await fileReq(server.base, a.data.path, "download");
    assert.equal(down.res.status, 200);
    assert.equal(down.res.headers.get("x-content-type-options"), "nosniff");
    assert.match(down.res.headers.get("content-disposition") || "", /attachment/);
    assert.equal(down.res.headers.get("content-type"), "application/octet-stream");
    assert.deepEqual(down.data, Buffer.from("第一份内容", "utf8"));
  });

  it("sanitizes dangerous filenames and still stores unique files", async () => {
    const result = await upload(server.base, "../../etc/passwd.txt", Buffer.from("x"));
    assert.equal(result.res.status, 200);
    assert.equal(result.data.name, "passwd.txt");
    assert.ok(result.data.path.startsWith(join(realpathSync(server.projectRoot), "uploads")));
  });

  it("rejects oversized uploads", async () => {
    const result = await upload(server.base, "huge.bin", Buffer.alloc(MAX_FILE_BYTES + 1));
    assert.equal(result.res.status, 413);
  });

  it("returns errors for missing files", async () => {
    const result = await fileReq(server.base, "no-such-file.txt", "download");
    assert.equal(result.res.status, 404);
  });

  it("resolves relative traversal and follows workspace symlinks", async () => {
    const outside = join(server.envHome.dir, "outside.txt");
    writeFileSync(outside, "outside-ok");
    const slash = await fileReq(server.base, "../outside.txt", "download");
    assert.equal(slash.res.status, 200);
    assert.deepEqual(slash.data, Buffer.from("outside-ok"));
    const encoded = await fetch(server.base + "/api/file?path=%2e%2e%2foutside.txt&mode=download");
    assert.equal(encoded.status, 200);
    assert.deepEqual(Buffer.from(await encoded.arrayBuffer()), Buffer.from("outside-ok"));
    const target = join(server.envHome.dir, "outside-linked.txt");
    writeFileSync(target, "linked-ok");
    symlinkSync(target, join(server.workspace, "escape.txt"));
    const linked = await fileReq(server.base, "escape.txt", "download");
    assert.equal(linked.res.status, 200);
    assert.deepEqual(linked.data, Buffer.from("linked-ok"));
  });

  it("reads temporary config/session files but never inline-executes HTML", async () => {
    const html = await upload(server.base, "page.html", Buffer.from('<script>alert(1)</script>'));
    const preview = await fileReq(server.base, html.data.path, "preview");
    assert.equal(preview.res.status, 200);
    assert.match(preview.res.headers.get("content-type") || "", /application\/json/);
    assert.equal(preview.data.preview, "text");
    assert.equal(preview.data.text, '<script>alert(1)</script>');
    const down = await fileReq(server.base, html.data.path, "download");
    assert.equal(down.res.headers.get("content-type"), "application/octet-stream");
    assert.match(down.res.headers.get("content-disposition") || "", /attachment/);

    const sessionFile = join(server.envHome.sessions, "secret.jsonl");
    writeFileSync(sessionFile, "session-secret");
    const sessionRead = await fileReq(server.base, sessionFile, "preview");
    assert.equal(sessionRead.res.status, 200);
    assert.equal(sessionRead.data.text, "session-secret");

    const configDir = join(server.envHome.home, ".config", "easy-pi-webui");
    mkdirSync(configDir, { recursive: true });
    const configFile = join(configDir, "secret.json");
    writeFileSync(configFile, '{"fake":"config-secret"}');
    const configRead = await fileReq(server.base, configFile, "preview");
    assert.equal(configRead.res.status, 200);
    assert.match(configRead.data.text, /config-secret/);
  });

  it("previews text as json and images as image bytes", async () => {
    writeFileSync(join(server.workspace, "readme.md"), "# 你好\n");
    const text = await fileReq(server.base, "readme.md", "preview");
    assert.equal(text.res.status, 200);
    assert.equal(text.data.preview, "text");
    assert.equal(text.data.text, "# 你好\n");

    const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
    writeFileSync(join(server.workspace, "dot.png"), png);
    const img = await fileReq(server.base, "dot.png", "preview");
    assert.equal(img.res.status, 200);
    assert.match(img.res.headers.get("content-type") || "", /image\/png/);
    assert.deepEqual(img.data, png);
  });

  it("labels office files as not previewable", async () => {
    writeFileSync(join(server.workspace, "deck.pptx"), "fake-office");
    const meta = await fileReq(server.base, "deck.pptx", "meta");
    assert.equal(meta.data.preview, "none");
    assert.match(meta.data.note, /不能解析/);
  });

  it("rejects untrusted Origin on upload", async () => {
    const result = await upload(server.base, "ok.txt", Buffer.from("ok"), {
      origin: "http://evil.example",
    });
    assert.equal(result.res.status, 403);
    const ok = await upload(server.base, "ok.txt", Buffer.from("ok"), {
      origin: "http://127.0.0.1:" + server.port,
    });
    assert.equal(ok.res.status, 200);
  });

  it("keeps new uploads in the project root across workspace switches", async () => {
    const projectUploads = join(realpathSync(server.projectRoot), "uploads");
    const first = await upload(server.base, "keep.txt", Buffer.from("in-first"));
    assert.equal(first.res.status, 200);
    assert.ok(first.data.path.startsWith(projectUploads));
    assert.ok(!first.data.path.startsWith(join(realpathSync(server.workspace), "uploads")));

    // A pre-existing workspace-local upload keeps its old workspace boundary.
    const legacyDir = join(server.workspace, ".easy-pi-webui", "uploads");
    mkdirSync(legacyDir, { recursive: true });
    const legacyPath = join(legacyDir, "legacy.txt");
    writeFileSync(legacyPath, "legacy");
    const legacyBefore = await fileReq(server.base, legacyPath, "download");
    assert.equal(legacyBefore.res.status, 200);

    const next = join(server.envHome.dir, "ws2");
    mkdirSync(next);
    const switched = await fetch(server.base + "/api/workspace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: next }),
    });
    const body = await switched.json();
    assert.equal(switched.status, 200);
    assert.equal(body.workspace, realpathSync(next));

    const stale = await fileReq(server.base, first.data.path, "download");
    assert.equal(stale.res.status, 200);
    assert.deepEqual(stale.data, Buffer.from("in-first"));
    const staleMeta = await fileReq(server.base, first.data.path, "meta");
    assert.equal(staleMeta.res.status, 200);
    const stalePreview = await fileReq(server.base, first.data.path, "preview");
    assert.equal(stalePreview.res.status, 200);
    assert.equal(stalePreview.data.preview, "text");
    assert.equal(stalePreview.data.text, "in-first");

    const legacyAfter = await fileReq(server.base, legacyPath, "download");
    assert.equal(legacyAfter.res.status, 200);
    assert.deepEqual(legacyAfter.data, Buffer.from("legacy"));
    writeFileSync(join(next, "inside.txt"), "inside");
    const inside = await fileReq(server.base, "inside.txt", "download");
    assert.equal(inside.res.status, 200);
    assert.deepEqual(inside.data, Buffer.from("inside"));
    writeFileSync(join(server.projectRoot, "sibling.txt"), "sibling");
    const sibling = await fileReq(server.base, join(server.projectRoot, "sibling.txt"), "meta");
    assert.equal(sibling.res.status, 200);
    const external = join(server.envHome.dir, "outside-switch.txt");
    writeFileSync(external, "outside");
    const outside = await fileReq(server.base, external, "download");
    assert.equal(outside.res.status, 200);
    assert.deepEqual(outside.data, Buffer.from("outside"));

    const second = await upload(server.base, "new.txt", Buffer.from("in-second"));
    assert.equal(second.res.status, 200);
    assert.ok(second.data.path.startsWith(projectUploads));
    assert.ok(!second.data.path.startsWith(join(realpathSync(next), "uploads")));
    const fresh = await fileReq(server.base, second.data.path, "download");
    assert.equal(fresh.res.status, 200);
    assert.deepEqual(fresh.data, Buffer.from("in-second"));

    // switch back so later tests still use the original workspace
    const back = await fetch(server.base + "/api/workspace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: server.workspace }),
    });
    assert.equal(back.status, 200);
    const legacyBack = await fileReq(server.base, legacyPath, "download");
    assert.equal(legacyBack.res.status, 200);
    assert.deepEqual(legacyBack.data, Buffer.from("legacy"));
  });

  it("ignores launch cwd for the project upload location", async () => {
    const other = await startServer({ cwd: tmpdir() });
    try {
      const file = await upload(other.base, "cwd.txt", Buffer.from("cwd-independent"));
      assert.equal(file.res.status, 200);
      assert.ok(file.data.path.startsWith(join(realpathSync(other.projectRoot), "uploads")));
      assert.ok(!file.data.path.startsWith(join(realpathSync(other.workspace), "uploads")));
    } finally {
      await other.stop();
    }
  });

  it("passes attachment paths into the prompt and keeps image-only / bare messages unchanged", async () => {
    const file = await upload(server.base, "材料.txt", Buffer.from("材料正文"));
    assert.ok(file.data.path.startsWith(join(realpathSync(server.projectRoot), "uploads")));
    const created = await fetch(server.base + "/api/session/new", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const snap = await created.json();
    assert.equal(created.status, 200, JSON.stringify(snap));
    const key = snap.key;
    assert.ok(key);

    const message =
      "请帮我看看这份材料\n\n请读取以下附件（文件已保存到工作目录，请用工具打开这些路径；不要假设文件内容已经贴在消息里）：\n- 材料.txt：" +
      file.data.path +
      "（）";
    const chat = await fetch(server.base + "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, message }),
    });
    assert.equal(chat.status, 200, await chat.text());

    const imageChat = await fetch(server.base + "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key,
        message: "请看这张图片。",
        images: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      }),
    });
    assert.equal(imageChat.status, 200);

    const plain = await fetch(server.base + "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, message: "你好，没有附件" }),
    });
    assert.equal(plain.status, 200);

    const log = readFileSync(server.envHome.log, "utf8");
    const prompts = log
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((row) => row.type === "prompt");
    assert.ok(prompts.some((row) => String(row.message).includes(file.data.path) && String(row.message).includes("材料.txt")));
    const imagePrompt = prompts.find((row) => row.message === "请看这张图片。");
    assert.ok(imagePrompt);
    assert.equal(imagePrompt.images.length, 1);
    assert.equal(imagePrompt.images[0].data, "AAAA");
    const bare = prompts.find((row) => row.message === "你好，没有附件");
    assert.ok(bare);
    assert.ok(!bare.images);
    assert.doesNotMatch(bare.message, /请读取以下附件/);
  });

  it("cleans up only unreferenced uploads on demand", async () => {
    const uploads = join(realpathSync(server.projectRoot), "uploads");
    const orphan = join(uploads, "orphan-" + Date.now() + ".txt");
    writeFileSync(orphan, "old payload");
    const stamp = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(orphan, stamp, stamp);

    // 至少有一个可读的会话文件，清理才会执行（读不到会话时一律不删）。
    const folder = sessionsDir(realpathSync(server.workspace));
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "cleanup.jsonl"),
      JSON.stringify({ type: "message", message: { role: "user", content: "与上传无关的内容" } }) + "\n",
    );

    const res = await fetch(server.base + "/api/uploads/cleanup", { method: "POST" });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.ok(data.deleted.includes(basename(orphan)));
    assert.equal(existsSync(orphan), false);
  });
});
