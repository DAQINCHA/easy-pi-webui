import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { jsonResponse, loadApp } from "./helpers/frontend.mjs";

// 只用合成事件驱动真实 app.js 的渲染路径，不启动服务、不生成真实会话、不调用模型。
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const USER = { role: "user", content: [{ type: "text", text: "跑一遍" }] };

function makeApp() {
  const app = loadApp({
    fetch: async (path) => {
      if (path === "/api/sessions") return jsonResponse({ sessions: [] });
      if (path === "/api/fork-messages") return jsonResponse({ forkMessages: [] });
      if (path === "/api/stats") return jsonResponse({});
      return jsonResponse({ success: true });
    },
  });
  app.state.key = "s:1";
  app.state.file = "/ws/s.jsonl";
  app.state.workspace = "/ws";
  app.state.messages = [USER];
  app.bindEvents();
  app.renderThread();
  app.handleEvent({ type: "agent_start" });
  return app;
}

const step = (id) => ({ id, name: "read", args: { path: "/ws/" + id + ".md" } });

// 一个工具步骤的真实事件顺序：assistant toolCall 流式 -> message_end -> 工具开始 -> 工具结束 -> toolResult 消息。
function startStep(app, item) {
  app.handleEvent({ type: "message_start", message: { role: "assistant" } });
  app.handleEvent({
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: item.id, toolName: item.name },
  });
  app.handleEvent({
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: { id: item.id, name: item.name, arguments: item.args },
    },
  });
  app.handleEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: item.id, name: item.name, arguments: item.args }],
    },
  });
  app.handleEvent({
    type: "tool_execution_start",
    toolCallId: item.id,
    toolName: item.name,
    args: item.args,
  });
}

function endStep(app, item, { isError = false } = {}) {
  const content = [{ type: "text", text: isError ? "boom" : "ok" }];
  app.handleEvent({
    type: "tool_execution_end",
    toolCallId: item.id,
    toolName: item.name,
    isError,
    durationMs: 12,
    result: { content },
  });
  app.handleEvent({
    type: "message_end",
    message: {
      role: "toolResult",
      toolCallId: item.id,
      toolName: item.name,
      isError,
      durationMs: 12,
      content,
    },
  });
}

const procNode = (app) => app.el.messages.querySelector(".proc");
const spinNode = (app) => app.el.messages.querySelector(".proc .proc-ico .spin");
const procState = (app) => {
  const node = app.el.messages.querySelector(".proc .proc-state");
  return node ? node.textContent : "";
};
const iconUse = (app) => {
  const node = app.el.messages.querySelector(".proc .proc-ico use");
  return node ? node.getAttribute("href") : "";
};

// 从节点一路向上收集祖先，直到消息容器；用于证明整条链都留在原地。
function ancestorChain(node, stopAt) {
  const chain = [];
  for (let current = node; current; current = current.parentNode) {
    chain.push(current);
    if (current === stopAt) break;
  }
  return chain;
}

const opsSince = (app, index) => app.trace.ops.slice(index);

describe("process indicator stays connected in place", () => {
  it("models a traditional DOM move as remove + insert (helper sanity)", () => {
    const app = makeApp();
    const from = app.document.createElement("div");
    const to = app.document.createElement("div");
    app.el.messages.appendChild(from);
    app.el.messages.appendChild(to);
    const child = app.document.createElement("span");
    from.appendChild(child);

    const marker = app.trace.ops.length;
    to.appendChild(child);

    const ops = opsSince(app, marker).filter((op) => op.uid === child._uid);
    assert.deepEqual(ops.map((op) => op.op), ["remove", "insert"], "移动已有节点必须记录为摘下 + 插回");
    assert.equal(child._detaches, 1, "移动会让节点被摘下");
    assert.equal(child._attaches, 2, "移动会让节点被重新插入");
  });

  it("never detaches or reparents the spinner, proc, body, or assistant wrapper", () => {
    const app = makeApp();
    const first = step("t1");
    startStep(app, first);

    const spin = spinNode(app);
    assert.ok(spin, "运行中的过程组应该有转圈节点");
    const chain = ancestorChain(spin, app.el.messages);
    const proc = procNode(app);
    assert.ok(chain.includes(proc), "祖先链必须包含过程组");
    assert.ok(
      chain.some((node) => /(^|\s)body(\s|$)/.test(node.className)),
      "祖先链必须包含正文容器 .body",
    );
    assert.ok(
      chain.some((node) => /(^|\s)assistant(\s|$)/.test(node.className)),
      "祖先链必须包含助手包装器 .msg.assistant",
    );
    assert.equal(chain[chain.length - 1] === app.el.messages, true, "祖先链应一直连到消息容器");

    const uids = new Set(chain.map((node) => node._uid));
    const parents = chain.map((node) => node.parentNode);
    const detaches = chain.map((node) => node._detaches);
    const attaches = chain.map((node) => node._attaches);
    let marker = app.trace.ops.length;

    const assertInPlace = (label) => {
      chain.forEach((node, index) => {
        // 用布尔比较：断言失败时不要打印整棵（带循环引用的）DOM 图。
        assert.equal(node.parentNode === parents[index], true, label + "：祖先关系不能变（不能 reparent）");
        assert.equal(node._detaches, detaches[index], label + "：不能被摘下（remove）");
        assert.equal(node._attaches, attaches[index], label + "：不能被重新插入（insert）");
        assert.ok(app.el.messages.contains(node), label + "：必须仍然连在消息容器里");
      });
      const touched = opsSince(app, marker).filter((op) => uids.has(op.uid));
      assert.deepEqual(
        touched.map((op) => op.op + ":" + op.uid),
        [],
        label + "：转圈节点及其祖先不能出现 remove/insert 操作",
      );
      marker = app.trace.ops.length;
    };

    assertInPlace("工具开始");
    endStep(app, first);
    assertInPlace("第一条工具结束");

    for (const id of ["t2", "t3", "t4"]) {
      const item = step(id);
      startStep(app, item);
      assertInPlace(id + " 开始");
      endStep(app, item);
      assertInPlace(id + " 结束");
    }

    // 计数和文案是原地更新的，节点身份没有变。
    assert.equal(procNode(app) === proc, true, "过程组节点不能被替换");
    assert.equal(spinNode(app) === spin, true, "转圈节点不能被替换");
    assert.match(procState(app), /^进行中 4\/4$/);
  });

  it("keeps the proc and body in place when streaming text arrives after it", () => {
    const app = makeApp();
    const first = step("t1");
    startStep(app, first);
    endStep(app, first);

    const proc = procNode(app);
    const spin = spinNode(app);
    const wrapper = proc.parentNode.parentNode;
    const body = proc.parentNode;
    const marker = app.trace.ops.length;

    // 正文出现在过程组之后：过程组本身不能为了腾位置被搬动。
    app.handleEvent({ type: "message_start", message: { role: "assistant" } });
    app.handleEvent({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    app.handleEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "结果" } });

    // 正文到达后这一组过程就结束了（activeProc 只在最后一段仍是过程组时成立），
    // 所以转圈按设计变成完成图标；但过程组、.body 和助手包装器必须原地保留。
    assert.equal(procNode(app) === proc, true, "过程组节点不能被替换");
    assert.equal(proc.parentNode === body, true, "过程组不能离开原来的 .body");
    assert.equal(body.parentNode === wrapper, true, ".body 不能离开原来的助手包装器");
    assert.equal(wrapper.classList.contains("assistant"), true, "包装器应仍是 .msg.assistant");
    assert.equal(spinNode(app) === null, true, "正文到达后过程组应结束转圈");
    assert.equal(app.el.messages.contains(spin), false, "旧的转圈节点应被替换掉");
    assert.equal(proc.querySelector(".proc-ico").classList.contains("ok"), true, "过程组应切换为完成状态");
    assert.equal(iconUse(app), "#i-check", "完成后应显示勾选图标");
    const touched = opsSince(app, marker).filter((op) =>
      [proc._uid, body._uid, wrapper._uid].includes(op.uid),
    );
    assert.deepEqual(touched.map((op) => op.op), [], "过程组和祖先不能被摘下或重新插入");
  });
});

describe("collapsed process indicator", () => {
  it("keeps the same spinner DOM node across rapidly arriving steps", () => {
    const app = makeApp();
    const first = step("t1");
    startStep(app, first);

    const proc = procNode(app);
    const spin = spinNode(app);
    assert.ok(proc, "过程组应该已渲染");
    assert.ok(spin, "运行中的过程组应该有转圈指示器");
    assert.match(proc.querySelector(".proc-ico").className, /\brun\b/);

    // 每来一个新事件都走一次真实重绘；节点身份和状态必须连续。
    const assertStillRunning = (label) => {
      assert.ok(procNode(app) === proc, label + "：过程组节点不能被替换");
      assert.ok(spinNode(app) === spin, label + "：转圈节点不能被替换（否则动画会从头开始）");
      assert.match(proc.querySelector(".proc-ico").className, /\brun\b/, label + "：不能退出运行态");
      assert.notEqual(procState(app), "已完成", label + "：进行中不能显示已完成");
    };

    assertStillRunning("工具开始");

    endStep(app, first);
    assertStillRunning("第一条工具结束（下一步还没到）");

    for (const id of ["t2", "t3", "t4"]) {
      const item = step(id);
      startStep(app, item);
      assertStillRunning(id + " 开始");
      endStep(app, item);
      assertStillRunning(id + " 结束");
    }

    // 组头文案更新了，但转圈节点还是最初那一个。
    assert.match(proc.querySelector(".proc-title").textContent, /4 个步骤/);
    assert.match(procState(app), /^进行中 4\/4$/);
  });

  it("keeps the whole process running between two steps, not just the last child", () => {
    const app = makeApp();
    const first = step("t1");
    startStep(app, first);
    endStep(app, first);

    // 第一条工具已经有结果、下一条还没开始时，整段过程仍在运行。
    assert.match(procState(app), /^进行中 1\/1$/);
    assert.notEqual(procState(app), "已完成");
    assert.ok(spinNode(app), "步骤间隙也要保持转圈，不能闪成已完成");
    assert.match(procNode(app).querySelector(".proc-ico").className, /\brun\b/);

    const second = step("t2");
    startStep(app, second);
    assert.match(procState(app), /^进行中 1\/2$/);
  });

  it("shows the real error indicator for a failed tool instead of hiding it behind a spinner", () => {
    const app = makeApp();
    const bad = step("bad");
    startStep(app, bad);
    endStep(app, bad, { isError: true });

    const proc = procNode(app);
    assert.ok(proc.querySelector(".proc-ico").classList.contains("err"), "失败后组头应带错误状态");
    assert.ok(spinNode(app) === null, "失败且没有子项在跑时不能继续转圈");
    assert.equal(iconUse(app), "#i-alert", "应显示真实的感叹号错误图标");
    assert.match(procState(app), /失败/);
  });

  it("stops spinning when the whole process completes", async () => {
    const app = makeApp();
    const item = step("t1");
    startStep(app, item);
    endStep(app, item);

    app.handleEvent({ type: "agent_settled", aborted: false });
    await tick();

    const proc = procNode(app);
    assert.ok(proc, "完成后过程组仍然保留");
    assert.ok(spinNode(app) === null, "完成后必须停止转圈");
    assert.ok(proc.querySelector(".proc-ico").classList.contains("ok"));
    assert.equal(procState(app), "已完成");
    assert.equal(iconUse(app), "#i-check");
  });

  it("stops spinning on abort and reports the stopped state", async () => {
    const app = makeApp();
    startStep(app, step("t1"));
    assert.ok(spinNode(app), "中止前仍在转圈");

    app.handleEvent({ type: "agent_settled", aborted: true });
    await tick();

    const proc = procNode(app);
    assert.ok(proc, "中止后过程组仍然保留");
    assert.ok(spinNode(app) === null, "中止后必须停止转圈");
    assert.ok(proc.querySelector(".proc-ico").classList.contains("stop"));
    assert.equal(procState(app), "已停止");
    assert.equal(iconUse(app), "#i-stop");
  });

  it("keeps expand/collapse working across incremental updates", () => {
    const app = makeApp();
    const first = step("t1");
    startStep(app, first);
    endStep(app, first);

    const proc = procNode(app);
    const spin = spinNode(app);
    const toggle = proc.querySelector("[data-proc-toggle]");
    const body = proc.querySelector(".proc-body");
    assert.ok(toggle && body);
    assert.equal(body.hidden, true, "默认折叠");
    assert.equal(body.children.length, 0, "折叠时不渲染卡片");

    // 走真实的委托点击处理器。
    app.el.messages.emit("click", { target: toggle });
    assert.equal(proc.classList.contains("open"), true);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(body.hidden, false);
    assert.ok(body.children.length > 0, "展开后应填入步骤卡片");
    assert.equal(app.state.procOpen.get(proc.getAttribute("data-proc-key")), true);

    // 展开状态下继续来新步骤：组和转圈节点都保持，展开状态不丢。
    const next = step("t2");
    startStep(app, next);
    endStep(app, next);
    assert.ok(procNode(app) === proc, "更新时复用同一个过程组节点");
    assert.ok(spinNode(app) === spin, "更新时复用同一个转圈节点");
    assert.equal(proc.classList.contains("open"), true, "展开状态不能被打回折叠");
    assert.equal(body.hidden, false);

    app.el.messages.emit("click", { target: toggle });
    assert.equal(proc.classList.contains("open"), false);
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(body.hidden, true, "再次点击应折叠");
    assert.equal(app.state.procOpen.has(proc.getAttribute("data-proc-key")), false);
  });
});
