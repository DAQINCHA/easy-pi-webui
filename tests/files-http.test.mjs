import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { MAX_FILE_BYTES } from "../lib/files.js";
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
    const down = await fileReq(server.base, a.data.relativePath, "download");
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
    assert.ok(result.data.path.startsWith(join(realpathSync(server.workspace), ".easy-pi-webui", "uploads")));
  });

  it("rejects oversized uploads", async () => {
    const result = await upload(server.base, "huge.bin", Buffer.alloc(MAX_FILE_BYTES + 1));
    assert.equal(result.res.status, 413);
  });

  it("returns errors for missing files", async () => {
    const result = await fileReq(server.base, "no-such-file.txt", "download");
    assert.equal(result.res.status, 404);
  });

  it("rejects lexical and encoded traversal, and escaping symlinks", async () => {
    const slash = await fileReq(server.base, "../secret.txt", "download");
    assert.equal(slash.res.status, 403);
    const encoded = await fetch(server.base + "/api/file?path=%2e%2e%2f%2e%2e%2fetc%2fpasswd&mode=download");
    assert.equal(encoded.status, 403);
    const outside = join(server.envHome.dir, "outside.txt");
    writeFileSync(outside, "leaked");
    symlinkSync(outside, join(server.workspace, "escape.txt"));
    const linked = await fileReq(server.base, "escape.txt", "download");
    assert.equal(linked.res.status, 403);
  });

  it("does not expose app config or session dirs, and does not inline-execute HTML", async () => {
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
    const blocked = await fileReq(server.base, sessionFile, "preview");
    assert.equal(blocked.res.status, 403);
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

  it("follows the current workspace only after a switch", async () => {
    const first = await upload(server.base, "keep.txt", Buffer.from("in-first"));
    assert.equal(first.res.status, 200);
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
    assert.equal(stale.res.status, 403);

    const second = await upload(server.base, "new.txt", Buffer.from("in-second"));
    assert.equal(second.res.status, 200);
    assert.ok(second.data.path.startsWith(join(realpathSync(next), ".easy-pi-webui")));
    const fresh = await fileReq(server.base, second.data.relativePath, "download");
    assert.equal(fresh.res.status, 200);
    assert.deepEqual(fresh.data, Buffer.from("in-second"));

    // switch back so later tests still use the original workspace
    const back = await fetch(server.base + "/api/workspace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: server.workspace }),
    });
    assert.equal(back.status, 200);
  });

  it("passes attachment paths into the prompt and keeps image-only / bare messages unchanged", async () => {
    const file = await upload(server.base, "材料.txt", Buffer.from("材料正文"));
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
});
