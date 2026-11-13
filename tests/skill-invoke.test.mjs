import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parseSkillBlock } from "../public/js/markdown.js";
import { jsonResponse, loadApp } from "./helpers/frontend.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CSS = readFileSync(join(ROOT, "public/styles.css"), "utf8");

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = CSS.match(new RegExp(escaped + "\\s*\\{[^}]*\\}"));
  assert.ok(match, "missing selector " + selector);
  return match[0];
}

describe("message avatar matches the collapsed process header height", () => {
  it("is a 32x32 border-box square that does not stretch the image", () => {
    const avatar = rule(".msg .avatar");
    assert.match(avatar, /width:\s*32px/);
    assert.match(avatar, /height:\s*32px/);
    assert.match(rule(".msg .avatar img"), /object-fit:\s*contain/);
    assert.match(rule(".proc-head"), /min-height:\s*32px/);
  });

  it("keeps the avatar centered on the first process/tool row", () => {
    assert.match(rule(".msg.assistant.lead-proc .avatar"), /margin-top:\s*8px/);
    assert.match(rule(".msg.assistant.lead-tool .avatar"), /margin-top:\s*12px/);
  });
});

describe("skill invocation display", () => {
  const baseDir = "/skills/pdf-tools";
  const body = "# PDF tools\nRead the file.";
  const refs = `References are relative to ${baseDir}.`;
  const envelope = `<skill name="pdf-tools" location="${baseDir}/SKILL.md">\n${refs}\n\n${body}\n</skill>`;

  it("parses pi's exact expanded envelope and keeps user args separate", () => {
    const parsed = parseSkillBlock(envelope + "\n\nextract report.pdf");
    assert.equal(parsed.name, "pdf-tools");
    assert.equal(parsed.content, body);
    assert.equal(parsed.userMessage, "extract report.pdf");
  });

  it("keeps user-added text byte-for-byte, without trimming", () => {
    const parsed = parseSkillBlock(envelope + "\n\n  extract report.pdf  ");
    assert.equal(parsed.userMessage, "  extract report.pdf  ");
  });

  it("rejects lookalike XML that lacks the generated References line", () => {
    assert.equal(
      parseSkillBlock('<skill name="pdf-tools" location="/skills/pdf-tools/SKILL.md">\n# PDF tools\n</skill>'),
      null,
    );
    assert.equal(
      parseSkillBlock(
        '<skill name="pdf-tools" location="/skills/pdf-tools/SKILL.md">\nReferences are relative to /elsewhere.\n\nbody\n</skill>',
      ),
      null,
    );
    assert.equal(parseSkillBlock('<skill name="x" location="y">\nbody\n</skill>'), null);
    assert.equal(parseSkillBlock("<skill>not pi</skill>"), null);
  });

  it("leaves malformed plain text untouched", () => {
    assert.equal(parseSkillBlock("plain user text"), null);
    assert.equal(parseSkillBlock(""), null);
    assert.equal(parseSkillBlock(envelope + " trailing"), null);
  });

  it("still collapses when only harmless whitespace differs", () => {
    const variants = [
      envelope.replace(/\n/g, "\r\n"), // CRLF
      "  " + envelope, // 前导空格
      envelope + "\n", // 结尾多一个换行
      envelope + "\n\n\n", // 结尾多几个空行
      envelope + "   \n\n  ", // 结尾只有空白
      envelope.replace("</skill>", "</skill>   "), // 结束标签行尾空格
      envelope.replace("\n\n" + body, "\n\n\n" + body), // 正文前多一个空行
      envelope.replace("\n\n" + body, "\n" + body), // 正文前少一个空行
    ];
    for (const variant of variants) {
      const parsed = parseSkillBlock(variant);
      assert.ok(parsed, "should still parse: " + JSON.stringify(variant.slice(0, 60)));
      assert.equal(parsed.name, "pdf-tools");
      assert.equal(parsed.content, body);
      assert.equal(parsed.userMessage, undefined);
    }
  });

  it("accepts a single blank line before the user args and keeps them byte-for-byte", () => {
    const parsed = parseSkillBlock(envelope + "\nextract report.pdf");
    assert.ok(parsed);
    assert.equal(parsed.userMessage, "extract report.pdf");

    const spaced = parseSkillBlock(envelope.replace("</skill>", "</skill>  ") + "\n\n  extract  ");
    assert.ok(spaced);
    assert.equal(spaced.userMessage, "  extract  ");
  });

  it("does not treat ordinary text that mentions the envelope as a skill block", () => {
    assert.equal(parseSkillBlock("看这个：\n" + envelope), null);
    assert.equal(parseSkillBlock("普通消息提到 <skill name=\"x\"> 和 </skill> 但不是信封"), null);
  });

  it("renders a collapsed skill body with optional args outside it, and toggles via real events", () => {
    const original = envelope + "\n\nextract report.pdf";
    const app = loadApp({
      fetch: async (path) => {
        if (path === "/api/sessions") return jsonResponse({ sessions: [] });
        if (path === "/api/stats") return jsonResponse({});
        return jsonResponse({ success: true });
      },
    });
    app.state.key = "s:1";
    app.state.file = "/ws/s.jsonl";
    app.state.workspace = "/ws";
    app.state.messages = [{ role: "user", content: [{ type: "text", text: original }] }];
    app.bindEvents();
    app.renderThread();

    let bodyEl = app.el.messages.querySelector(".skill-body");
    const userText = app.el.messages.querySelector(".skill-user-text");
    assert.ok(bodyEl && userText);
    assert.equal(bodyEl.hidden, true, "collapsed by default");
    assert.equal(bodyEl.textContent, body);
    assert.equal(userText.textContent, "extract report.pdf");
    assert.equal(bodyEl.contains(userText), false, "user args stay outside the hidden body");

    const toggle = app.el.messages.querySelector("[data-skill-toggle]");
    app.el.messages.emit("click", { target: toggle });
    assert.equal(bodyEl.hidden, false, "expands on click");
    assert.equal(toggle.getAttribute("aria-expanded"), "true");

    app.el.messages.emit("click", { target: toggle });
    assert.equal(bodyEl.hidden, true, "collapses on second click");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");

    app.el.messages.emit("click", { target: toggle });
    app.renderThread();
    bodyEl = app.el.messages.querySelector(".skill-body");
    assert.equal(bodyEl.hidden, false, "rerender preserves the open state");

    assert.equal(app.state.messages[0].content[0].text, original, "message content is never rewritten");
  });

  it("copies only the visible skill text by default and keeps the raw envelope behind full-request copy", async () => {
    const original = envelope + "\n\n  extract report.pdf  ";
    const app = loadApp({
      fetch: async (path) => {
        if (path === "/api/sessions") return jsonResponse({ sessions: [] });
        if (path === "/api/stats") return jsonResponse({});
        return jsonResponse({ success: true });
      },
    });
    app.state.key = "s:1";
    app.state.file = "/ws/s.jsonl";
    app.state.workspace = "/ws";
    app.state.messages = [{ role: "user", content: [{ type: "text", text: original }] }];
    app.bindEvents();
    app.renderThread();
    let copied = null;
    app.navigator.clipboard.writeText = async (value) => {
      copied = value;
    };
    const message = app.el.messages.querySelector(".msg.user");

    app.el.messages.emit("click", { target: message.querySelector('[data-act="copy-user"]') });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(copied, "extract report.pdf");
    assert.equal(copied.includes("References"), false);
    assert.equal(copied.includes("展开"), false);

    app.el.messages.emit("click", { target: message.querySelector("[data-skill-toggle]") });
    app.el.messages.emit("click", { target: message.querySelector('[data-act="copy-user"]') });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(copied, body + "\n  extract report.pdf");

    app.el.messages.emit("click", { target: message.querySelector('[data-act="copy-user-full"]') });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(copied, original);
  });

  it("fills edit and branch drafts with visible text instead of the skill envelope", () => {
    const app = loadApp({
      fetch: async (path) => {
        if (path === "/api/sessions") return jsonResponse({ sessions: [] });
        if (path === "/api/stats") return jsonResponse({});
        return jsonResponse({ success: true });
      },
    });
    assert.equal(app.visiblePromptText(envelope + "\n\nextract report.pdf"), "extract report.pdf");
    assert.equal(app.visiblePromptText(envelope), "");
    assert.equal(app.visiblePromptText("普通文字"), "普通文字");
  });
});

describe("skill header hover/focus text contrast", () => {
  function lineRule(selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = CSS.match(new RegExp("^" + escaped + " \\{[^}]*\\}", "m"));
    assert.ok(match, "missing rule " + selector);
    return match[0];
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

  it("paints the header yellow with dark text on hover and focus-visible", () => {
    for (const state of ["hover", "focus-visible"]) {
      const head = lineRule(".skill-head:" + state);
      assert.match(head, /background:\s*var\(--bg-hover\)/);
      assert.match(head, /color:\s*var\(--accent-fg\)/);
      for (const child of [".skill-label", ".skill-name", ".skill-hint"]) {
        assert.match(lineRule(".skill-head:" + state + " " + child), /color:\s*inherit/);
      }
    }
  });

  it("keeps the ordinary theme text colors outside hover/focus", () => {
    for (const child of [".skill-label", ".skill-name", ".skill-hint"]) {
      const base = lineRule(child);
      assert.match(base, /color:\s*var\(--text-\d\)/);
      assert.doesNotMatch(base, /#111111/);
    }
  });

  it("keeps AAA dark-on-yellow contrast in both light and dark themes", () => {
    const bgs = [...CSS.matchAll(/--bg-hover:\s*(#[0-9a-fA-F]{6})/g)].map((m) => m[1].toLowerCase());
    assert.ok(bgs.length >= 2, "light and dark both define --bg-hover");
    for (const bg of bgs) {
      assert.equal(bg, "#ffe600");
      assert.ok(contrast("#111111", bg) >= 7, "dark text on " + bg + " must reach AAA");
    }
  });
});
