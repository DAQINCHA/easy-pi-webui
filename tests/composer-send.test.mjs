import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { jsonResponse, loadApp } from "./helpers/frontend.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = readFileSync(join(ROOT, "public/js/app.js"), "utf8");
const HTML = readFileSync(join(ROOT, "public/index.html"), "utf8");
const CSS = readFileSync(join(ROOT, "public/styles.css"), "utf8");

function makeApp(fetchImpl) {
  const app = loadApp({ fetch: fetchImpl });
  app.state.key = "s:1";
  app.state.file = "/ws/s.jsonl";
  app.state.workspace = "/ws";
  app.bindEvents();
  return app;
}

function sentBody(call) {
  return JSON.parse(call.options.body);
}

function userBubbles(app) {
  return app.el.messages.querySelectorAll(".msg.user");
}

describe("composer send recovery and queueing", () => {
  it("restores both text and attachments when a normal send fails", async () => {
    const app = makeApp(async () => {
      throw new Error("网络断了");
    });
    const image = {
      kind: "image",
      id: "i1",
      name: "pic.png",
      mime: "image/png",
      data: "QUJD",
      url: "data:image/png;base64,QUJD",
    };
    app.el.input.value = "  保留前后的空格  ";
    app.state.attachments = [image];

    await app.sendMessage();

    assert.equal(app.el.input.value, "  保留前后的空格  ");
    assert.equal(app.state.attachments.length, 1);
    assert.equal(app.state.attachments[0], image);
    assert.equal(app.state.optimistic.length, 0);
    assert.equal(userBubbles(app).length, 0);
    assert.equal(app.el.queueRail.hidden, true);
    assert.match(app.el.toasts.textContent, /发送失败/);
  });

  it("restores text and attachments when a queued send fails", async () => {
    const app = makeApp(async () => {
      throw new Error("网络断了");
    });
    const image = {
      kind: "image",
      id: "i1",
      name: "pic.png",
      mime: "image/png",
      data: "QUJD",
      url: "data:image/png;base64,QUJD",
    };
    app.state.streaming = true;
    app.el.input.value = "排队失败";
    app.state.attachments = [image];

    await app.sendMessage();

    assert.equal(app.el.input.value, "排队失败");
    assert.equal(app.state.attachments.length, 1);
    assert.equal(app.state.attachments[0], image);
    assert.equal(app.queueItems().length, 0);
    assert.equal(app.el.queueRail.hidden, true);
    assert.equal(userBubbles(app).length, 0);
    assert.match(app.el.toasts.textContent, /发送失败/);
  });

  it("queues by default while running into the dedicated queue area, not the sent thread", async () => {
    const app = makeApp(async () => jsonResponse({ disposition: "queued" }));
    app.state.streaming = true;

    app.el.input.value = "排到下一轮";
    await app.sendMessage();

    assert.equal(sentBody(app.fetchCalls[0]).behavior, "followUp");
    assert.equal(app.state.optimistic.length, 0);
    assert.equal(userBubbles(app).length, 0);
    assert.equal(app.el.queueRail.hidden, false);
    assert.equal(app.el.queueList.querySelectorAll(".queue-item").length, 1);
    assert.match(app.el.queueList.textContent, /排到下一轮/);
    assert.match(app.el.queueList.textContent, /下一轮/);
    assert.equal(app.state.queue, 1);

    // 服务端确认同一条消息后，排队区不能变成两条。
    app.handleEvent({ type: "queue_update", steering: [], followUp: ["排到下一轮"] });
    assert.equal(app.el.queueList.querySelectorAll(".queue-item").length, 1);
    assert.equal(userBubbles(app).length, 0);

    // 等当前任务结束、这条真正进入历史后，才从排队区挪到线程里。
    app.handleEvent({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "排到下一轮" }] },
    });
    assert.equal(userBubbles(app).length, 1);
    assert.equal(app.el.queueRail.hidden, true);
    assert.equal(app.state.queue, 0);
  });

  it("keeps a send in the thread when the task is not running", async () => {
    const app = makeApp(async () => jsonResponse({ disposition: "started" }));
    app.state.streaming = false;

    app.el.input.value = "直接发送";
    await app.sendMessage();

    assert.equal(sentBody(app.fetchCalls[0]).behavior, undefined);
    assert.equal(app.state.optimistic.length, 1);
    assert.equal(userBubbles(app).length, 1);
    assert.match(app.el.messages.textContent, /直接发送/);
    assert.equal(app.el.queueRail.hidden, true);
  });

  it("does not clear a queued message when a same-text optimistic send settles", async () => {
    const app = makeApp(async () => jsonResponse({ disposition: "queued" }));
    app.state.streaming = true;
    app.applyQueueUpdate({ steering: [], followUp: ["继续"] });

    // 另一条同名的普通发送（非排队）先进入历史，不能把排队区里的「继续」一起摘掉。
    app.state.streaming = false;
    app.el.input.value = "继续";
    await app.sendMessage();
    app.handleEvent({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "继续" }] },
    });

    assert.equal(app.state.optimistic.length, 0);
    assert.equal(app.queueItems().length, 1);
    assert.equal(app.queueItems()[0].raw, "继续");
  });

  it("has no composer-side insert button; the insert action lives on queued items and appears on hover", () => {
    assert.equal(HTML.includes('id="steerBtn"'), false);
    assert.equal(SOURCE.includes("steerBtn"), false);
    assert.doesNotMatch(SOURCE, /Option\s*\/\s*Alt\s*\+\s*Enter/);
    assert.doesNotMatch(SOURCE, /Alt \+ Enter/);

    const app = makeApp(async () => jsonResponse({ disposition: "queued" }));
    app.state.streaming = true;
    app.applyQueueUpdate({ steering: [], followUp: ["下一轮的内容"] });

    const item = app.el.queueList.querySelector(".queue-item");
    assert.ok(item, "missing queue item");
    const insert = item.querySelector('[data-act="insert-queued"]');
    assert.ok(insert, "insert action must sit inside the queued message");
    assert.equal(insert.getAttribute("aria-label"), "插入当前任务");
    assert.equal(insert.hidden, false);

    // 默认透明且不接收指针，悬停 / 键盘聚焦这条排队消息时才出现。
    assert.match(CSS, /\.queue-act\s*\{[^}]*opacity:\s*0;/);
    assert.match(CSS, /\.queue-act\s*\{[^}]*pointer-events:\s*none;/);
    assert.match(CSS, /\.queue-item:hover \.queue-act,\s*\n\.queue-item:focus-within \.queue-act\s*\{[^}]*opacity:\s*1;/);
    assert.match(CSS, /\.queue-item:focus-within \.queue-act[^{]*\{[^}]*pointer-events:\s*auto;/);
  });

  it("converts a queued message into a steer and moves it to the sent thread", async () => {
    const app = makeApp(async (path) => {
      if (path === "/api/command") {
        return jsonResponse({ success: true, data: { steering: [], followUp: ["排队 A", "排队 B"] } });
      }
      return jsonResponse({ success: true, disposition: "queued" });
    });
    app.state.streaming = true;
    app.applyQueueUpdate({ steering: [], followUp: ["排队 A", "排队 B"] });

    await app.insertQueuedItem(app.queueItems()[0]);

    const command = app.fetchCalls.find((call) => call.path === "/api/command");
    assert.equal(sentBody(command).command.type, "clear_queue");
    const chatBodies = app.fetchCalls.filter((call) => call.path === "/api/chat").map(sentBody);
    assert.deepEqual(
      chatBodies.map((body) => [body.message, body.behavior]),
      [
        ["排队 A", "steer"],
        ["排队 B", "followUp"],
      ],
    );
    assert.equal(app.state.optimistic.length, 1);
    assert.equal(userBubbles(app).length, 1);
    assert.match(app.el.messages.textContent, /排队 A/);
    assert.equal(app.queueItems().length, 1);
    assert.equal(app.queueItems()[0].raw, "排队 B");
  });

  it("cancels one queued message without sending it", async () => {
    const app = makeApp(async (path) => {
      if (path === "/api/command") {
        return jsonResponse({ success: true, data: { steering: [], followUp: ["取消我", "留下我"] } });
      }
      return jsonResponse({ success: true, disposition: "queued" });
    });
    app.state.streaming = true;
    app.applyQueueUpdate({ steering: [], followUp: ["取消我", "留下我"] });

    await app.cancelQueuedItem(app.queueItems()[0]);

    const chatBodies = app.fetchCalls.filter((call) => call.path === "/api/chat").map(sentBody);
    assert.deepEqual(
      chatBodies.map((body) => [body.message, body.behavior]),
      [["留下我", "followUp"]],
    );
    assert.equal(app.state.optimistic.length, 0);
    assert.equal(app.queueItems().length, 1);
    assert.equal(app.queueItems()[0].raw, "留下我");
  });

  it("keeps images attached to a queued message when it is inserted into the current task", async () => {
    const app = makeApp(async (path) => {
      if (path === "/api/command") {
        return jsonResponse({ success: true, data: { steering: [], followUp: ["看图"] } });
      }
      return jsonResponse({ success: true, disposition: "queued" });
    });
    app.state.streaming = true;
    app.state.attachments = [
      { kind: "image", id: "i1", name: "pic.png", mime: "image/png", data: "QUJD", url: "data:image/png;base64,QUJD" },
    ];
    app.el.input.value = "看图";
    await app.sendMessage();
    app.applyQueueUpdate({ steering: [], followUp: ["看图"] });

    await app.insertQueuedItem(app.queueItems()[0]);

    const chatBodies = app.fetchCalls.filter((call) => call.path === "/api/chat").map(sentBody);
    const steer = chatBodies.find((body) => body.behavior === "steer");
    assert.ok(steer, "missing steer request");
    assert.deepEqual(steer.images, [{ type: "image", data: "QUJD", mimeType: "image/png" }]);
    assert.equal(app.state.optimistic.length, 1);
    assert.equal(userBubbles(app).length, 1);
  });

  it("summarizes queued messages with visible user text instead of machine envelopes", () => {
    const app = makeApp(async () => jsonResponse({}));
    const baseDir = "/skills/pdf-tools";
    const envelope = `<skill name="pdf-tools" location="${baseDir}/SKILL.md">\nReferences are relative to ${baseDir}.\n\n# PDF tools\n</skill>`;
    assert.equal(app.queueSummary(envelope + "\n\nextract report.pdf"), "extract report.pdf");
    assert.equal(app.queueSummary(envelope), "Skill：pdf-tools");

    const header = "请读取以下附件（文件已保存，请用工具打开下面提供的绝对路径；不要假设文件内容已经贴在消息里）：";
    const raw = "看看这个\n\n" + header + "\n- a.txt：/project/uploads/m3k2x9-a1b2c3d4-a.txt";
    assert.equal(app.queueSummary(raw), "看看这个");
    assert.equal(app.queueSummary(header + "\n- a.txt：/project/uploads/m3k2x9-a1b2c3d4-a.txt"), "a.txt");
  });

  it("keeps the send button as stop only when the input is empty while running", () => {
    const app = makeApp(async () => jsonResponse({ disposition: "queued" }));
    app.state.streaming = true;
    app.el.input.value = "下一轮";
    app.updateSendState();

    assert.equal(app.el.steerBtn, undefined);
    assert.equal(app.el.sendBtn.classList.contains("is-stop"), false);
    assert.match(app.el.sendBtn.title, /排队/);
    assert.match(app.el.hintText.textContent, /排队到下一轮/);
    assert.match(app.el.hintText.textContent, /插入当前任务/);

    app.el.input.value = "";
    app.updateSendState();
    assert.equal(app.el.sendBtn.classList.contains("is-stop"), true);
    assert.match(app.el.sendBtn.title, /停止/);
    assert.doesNotMatch(app.el.hintText.textContent, /插入当前任务/);
  });

  it("checks the encoded request size against the server limit before clearing the composer", () => {
    const app = makeApp(async () => jsonResponse({ disposition: "started" }));
    const body = { message: "abc", images: [{ data: "QUJD" }] };
    assert.equal(app.requestBodyBytes(body), new TextEncoder().encode(JSON.stringify(body)).length);
    assert.equal(app.requestTooLarge(body, app.requestBodyBytes(body)), false);
    assert.equal(app.requestTooLarge(body, app.requestBodyBytes(body) - 1), true);
    assert.match(app.requestTooLargeMessage(body), /上限 32 MB/);
    assert.match(SOURCE, /if \(requestTooLarge\(body\)\) \{/);
    assert.match(SOURCE, /const body = \{ key: state\.key, message: outgoing \};/);
  });
});
