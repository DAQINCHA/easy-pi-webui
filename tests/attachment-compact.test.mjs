import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parseAttachmentBlock } from "../public/js/markdown.js";
import { jsonResponse, loadApp } from "./helpers/frontend.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CSS = readFileSync(join(ROOT, "public/styles.css"), "utf8");

const HEADER = "请读取以下附件（文件已保存，请用工具打开下面提供的绝对路径；不要假设文件内容已经贴在消息里）：";
const OLD_HEADER = "请读取以下附件（文件已保存到工作目录，请用工具打开这些路径；不要假设文件内容已经贴在消息里）：";
const OFFICE_NOTE = "本界面不能解析 PDF / Office 等内容，需要 pi 用工具读取，或下载后用本机应用打开。";
const UNTRUSTED_NOTE = "此格式可能包含可执行内容，预览只显示文本，不会在页面里运行。";

function storedPath(name, { dir = "/project/uploads", stamp = "m3k2x9", hex = "a1b2c3d4" } = {}) {
  return dir + "/" + stamp + "-" + hex + "-" + name;
}

function line(name, path, note = "") {
  return "- " + name + "：" + path + (note ? "（" + note + "）" : "");
}

function block(lines, header = HEADER) {
  return header + "\n" + lines.join("\n");
}

function makeApp(messages) {
  const app = loadApp({
    fetch: async (path) => {
      if (path === "/api/sessions") return jsonResponse({ sessions: [] });
      if (path === "/api/stats") return jsonResponse({});
      return jsonResponse({ name: "preview", size: 1, preview: "none", note: "note" });
    },
  });
  app.state.key = "s:1";
  app.state.file = "/ws/s.jsonl";
  app.state.workspace = "/ws";
  app.state.messages = messages;
  app.bindEvents();
  app.renderThread();
  return app;
}

function userMessage(text, extra = []) {
  return { role: "user", content: [{ type: "text", text }, ...extra] };
}

describe("generated attachment block parser", () => {
  it("keeps the user prefix exact and parses multiple files, spaces, and Chinese names", () => {
    const firstName = "报告 final.pdf";
    const secondName = "数据 说明.txt";
    const firstPath = storedPath(firstName);
    const secondPath = storedPath(secondName, { stamp: "zz9", hex: "deadbeef" });
    const original =
      "请总结这两个文件\n\n第二段保持原样\n\n" +
      block([line(firstName, firstPath, OFFICE_NOTE), line(secondName, secondPath)]);

    const parsed = parseAttachmentBlock(original);
    assert.equal(parsed.text, "请总结这两个文件\n\n第二段保持原样");
    assert.deepEqual(parsed.files, [
      { name: firstName, path: firstPath, note: OFFICE_NOTE },
      { name: secondName, path: secondPath, note: "" },
    ]);
  });

  it("accepts both source-backed headers and an attachment-only message", () => {
    const name = "a.txt";
    const path = storedPath(name);
    for (const header of [HEADER, OLD_HEADER]) {
      const parsed = parseAttachmentBlock(block([line(name, path)], header));
      assert.equal(parsed.text, "");
      assert.deepEqual(parsed.files, [{ name, path, note: "" }]);
    }
  });

  it("strips only the two classifyFile notes, not arbitrary trailing parentheses", () => {
    const name = "工具.sh";
    const path = storedPath(name);
    const known = parseAttachmentBlock(block([line(name, path, UNTRUSTED_NOTE)]));
    assert.equal(known.files[0].path, path);
    assert.equal(known.files[0].note, UNTRUSTED_NOTE);

    const bracketName = "说明（未知说明）.txt";
    const bracketPath = storedPath(bracketName);
    const unknown = parseAttachmentBlock(block([line(bracketName, bracketPath)]));
    assert.equal(unknown.files[0].path, bracketPath);
    assert.equal(unknown.files[0].note, "");
  });

  it("rejects relative paths, mismatched saveUpload names, unknown headers, partials, and extra prose", () => {
    const name = "a.txt";
    const path = storedPath(name);
    const cases = [
      block([line(name, "uploads/m3k2x9-a1b2c3d4-a.txt")]),
      block([line(name, storedPath("other.txt"))]),
      "请读取以下附件：\n" + line(name, path),
      HEADER,
      HEADER + "\n" + line(name, path) + "\n- broken",
      block([line(name, path)]) + "\n\n后面还有正文",
      "普通 Markdown\n\n- " + name + "：" + path,
    ];
    for (const value of cases) assert.equal(parseAttachmentBlock(value), null, value.slice(0, 30));
  });

  it("rejects blocks inside backtick or tilde fences and ordinary lookalikes", () => {
    const name = "a.txt";
    const path = storedPath(name);
    for (const fence of ["```", "~~~"]) {
      assert.equal(parseAttachmentBlock(fence + "\n" + block([line(name, path)])), null);
      assert.equal(parseAttachmentBlock(fence + "\n" + block([line(name, path)]) + "\n" + fence), null);
    }
    const ownText = parseAttachmentBlock("普通文字\n\n" + block([line(name, path)]));
    assert.equal(ownText.text, "普通文字");
    assert.equal(parseAttachmentBlock(block([line(name, path)]) + "\n"), null);
  });

  it("returns null promptly for header-only, malformed-at-zero, and fenced lookalikes", () => {
    const name = "a.txt";
    const path = storedPath(name);
    assert.equal(parseAttachmentBlock(HEADER), null);
    assert.equal(parseAttachmentBlock(HEADER + "\n- broken"), null);
    assert.equal(parseAttachmentBlock("```\n" + block([line(name, path)])), null);
    assert.equal(parseAttachmentBlock("~~~\n" + block([line(name, path)]) + "\n~~~"), null);
  });
});

describe("compact attachment display", () => {
  it("shows own text and one filename link per file, hiding instructions and paths by default", () => {
    const firstName = "报告 final.pdf";
    const secondName = "notes.txt";
    const firstPath = storedPath(firstName);
    const secondPath = storedPath(secondName, { stamp: "m3k2xa", hex: "0011aabb" });
    const original = "请总结这两个文件\n\n第二段\n\n" + block([
      line(firstName, firstPath, OFFICE_NOTE),
      line(secondName, secondPath),
    ]);
    const app = makeApp([userMessage(original)]);
    const bubble = app.el.messages.querySelector(".msg.user .bubble");

    assert.equal(bubble.querySelector(".attach-user-text").textContent, "请总结这两个文件\n\n第二段");
    assert.ok(bubble.innerHTML.indexOf("attach-block") < bubble.innerHTML.indexOf("attach-user-text"), "attachment card renders above own text");
    assert.equal(bubble.textContent.includes(HEADER), false);
    assert.equal(bubble.querySelectorAll(".attach-file-name").length, 2);

    const links = bubble.querySelectorAll(".attach-file-name");
    assert.equal(links[0].textContent, firstName);
    assert.equal(links[1].textContent, secondName);
    assert.equal(links[0].getAttribute("data-ws-file"), firstPath);
    assert.equal(links[1].getAttribute("data-ws-file"), secondPath);
    assert.equal(bubble.querySelector(".attach-file-row").textContent.includes(firstPath), false);

    const paths = bubble.querySelector(".attach-file-paths");
    assert.equal(paths.hidden, true);
    assert.equal(paths.textContent, firstPath + "（" + OFFICE_NOTE + "）\n" + secondPath);
    assert.equal(app.state.messages[0].content[0].text, original);
    assert.equal(app.el.messages.querySelector(".msg.user").__copyText, original);
  });

  it("opens the preview with the exact original path and expands/collapses the path details", async () => {
    const name = "目录 里的文件.txt";
    const path = storedPath(name);
    const original = "看这个\n\n" + block([line(name, path)]);
    const app = makeApp([userMessage(original)]);
    const bubble = app.el.messages.querySelector(".msg.user .bubble");
    const link = bubble.querySelector(".attach-file-name");

    app.el.messages.emit("click", { target: link });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const meta = app.fetchCalls.find((call) => call.path.includes("mode=meta"));
    assert.ok(meta, "clicking the filename requests file metadata");
    assert.equal(new URL("http://localhost" + meta.path).searchParams.get("path"), path);

    const toggle = bubble.querySelector("[data-attach-toggle]");
    const paths = bubble.querySelector(".attach-file-paths");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    app.el.messages.emit("click", { target: toggle });
    assert.equal(paths.hidden, false);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(toggle.querySelector(".attach-file-hint").textContent, "收起路径");

    app.renderThread();
    assert.equal(app.el.messages.querySelector(".attach-file-paths").hidden, false, "rerender keeps details open");
    app.el.messages.emit("click", { target: app.el.messages.querySelector("[data-attach-toggle]") });
    assert.equal(app.el.messages.querySelector(".attach-file-paths").hidden, true);
    assert.equal(app.state.messages[0].content[0].text, original);
  });

  it("copies only visible user text and attachment names by default", async () => {
    const name = "a.txt";
    const path = storedPath(name);
    const original = "保留前导空格\n\n" + block([line(name, path)]);
    const app = makeApp([userMessage(original)]);
    let copied = null;
    app.navigator.clipboard.writeText = async (value) => {
      copied = value;
    };
    app.el.messages.emit("click", { target: app.el.messages.querySelector('[data-act="copy-user"]') });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(copied, "保留前导空格\na.txt");
    assert.equal(copied.includes(HEADER), false);
    assert.equal(copied.includes(path), false);
    assert.equal(copied.includes("路径"), false);
    assert.equal(copied.includes("展开"), false);
  });

  it("copies the full raw request only from the explicit full-request action", async () => {
    const name = "a.txt";
    const path = storedPath(name);
    const original = "  保留前导空格\n\n" + block([line(name, path)]);
    const app = makeApp([userMessage(original)]);
    let copied = null;
    app.navigator.clipboard.writeText = async (value) => {
      copied = value;
    };
    app.el.messages.emit("click", { target: app.el.messages.querySelector('[data-act="copy-user-full"]') });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(copied, original);
  });

  it("works with both historical headers and keeps inline images unchanged", () => {
    for (const header of [HEADER, OLD_HEADER]) {
      const name = "图.png";
      const path = storedPath(name);
      const original = "看图\n\n" + block([line(name, path)], header);
      const app = makeApp([
        userMessage(original, [{ type: "image", mimeType: "image/png", data: "QUJD" }]),
      ]);
      const bubble = app.el.messages.querySelector(".msg.user .bubble");
      assert.ok(bubble.querySelector(".images img"));
      assert.equal(bubble.querySelector(".images img").getAttribute("src"), "data:image/png;base64,QUJD");
      assert.equal(bubble.querySelector(".attach-file-name").textContent, name);
      assert.equal(bubble.querySelector(".attach-user-text").textContent, "看图");
    }
  });

  it("keeps a Skill block and its appended attachment block in the same user message", () => {
    const skill = '<skill name="pdf-tools" location="/skills/pdf-tools/SKILL.md">\nReferences are relative to /skills/pdf-tools.\n\n# PDF tools\n</skill>';
    const name = "report.pdf";
    const path = storedPath(name);
    const original = skill + "\n\nextract report.pdf\n\n" + block([line(name, path, OFFICE_NOTE)]);
    const app = makeApp([userMessage(original)]);
    const bubble = app.el.messages.querySelector(".msg.user .bubble");

    assert.equal(bubble.querySelector(".skill-body").hidden, true);
    assert.equal(bubble.querySelector(".skill-body").textContent, "# PDF tools");
    assert.equal(bubble.querySelector(".skill-user-text").textContent, "extract report.pdf");
    assert.equal(bubble.querySelector(".attach-file-name").textContent, name);
    assert.equal(bubble.querySelector(".attach-file-name").getAttribute("data-ws-file"), path);
    assert.equal(bubble.querySelector(".attach-file-paths").hidden, true);
    assert.equal(app.state.messages[0].content[0].text, original);
  });

  it("leaves ordinary text, code fences, and partial lookalikes untouched", () => {
    const name = "a.txt";
    const path = storedPath(name);
    const values = [
      "普通 Markdown\n\n- " + name + "：" + path,
      "```\n" + block([line(name, path)]) + "\n```",
      "~~~\n" + block([line(name, path)]) + "\n~~~",
      block([line(name, path)]) + "\n\n后面还有正文",
      HEADER + "\n- broken",
    ];
    for (const value of values) {
      const app = makeApp([userMessage(value)]);
      const bubble = app.el.messages.querySelector(".msg.user .bubble");
      assert.equal(bubble.querySelector(".attach-block"), null);
      assert.equal(bubble.querySelector(".attach-invoke"), null);
      assert.equal(bubble.textContent, value);
      assert.equal(app.state.messages[0].content[0].text, value);
    }
  });
});

describe("attachment hover/focus contrast", () => {
  function ruleFor(selector) {
    for (const match of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectorPart = match[1].replace(/\/\*[\s\S]*?\*\//g, "");
      const found = selectorPart
        .split(",")
        .map((part) => part.trim())
        .includes(selector);
      if (found) return match[0];
    }
    assert.fail("missing selector " + selector);
  }

  function luminance(hex) {
    const channels = hex.replace("#", "").match(/../g).map((pair) => {
      const v = parseInt(pair, 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }

  it("uses the same dark-on-yellow hover/focus treatment as skill headers", () => {
    for (const selector of [
      ".attach-file-name:hover",
      ".attach-file-name:focus-visible",
      ".attach-file-toggle:hover",
      ".attach-file-toggle:focus-visible",
    ]) {
      const rule = ruleFor(selector);
      assert.match(rule, /background:\s*var\(--bg-hover\)/);
      assert.match(rule, /color:\s*var\(--accent-fg\)/);
    }
    for (const selector of [
      ".attach-file-toggle:hover .attach-file-hint",
      ".attach-file-toggle:focus-visible .attach-file-hint",
    ]) {
      assert.match(ruleFor(selector), /color:\s*inherit/);
    }
    assert.match(ruleFor(".attach-file-name"), /color:\s*var\(--text-1\)/);
    assert.match(ruleFor(".attach-file-hint"), /color:\s*var\(--text-4\)/);

    const bgs = [...CSS.matchAll(/--bg-hover:\s*(#[0-9a-fA-F]{6})/g)].map((m) => m[1].toLowerCase());
    const fgs = [...CSS.matchAll(/--accent-fg:\s*(#[0-9a-fA-F]{6})/g)].map((m) => m[1].toLowerCase());
    assert.ok(bgs.length >= 2, "light and dark both define --bg-hover");
    assert.ok(fgs.length >= 2, "light and dark both define --accent-fg");
    for (const bg of bgs) {
      assert.equal(bg, "#ffe600");
      for (const fg of fgs) {
        assert.ok(contrast(fg, bg) >= 7, fg + " on " + bg + " must reach AAA");
      }
    }
  });
});
