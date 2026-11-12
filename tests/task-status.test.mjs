import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PHASE,
  collectTurnFiles,
  connectionLabel,
  createTaskState,
  describeTask,
  reduceAll,
  reduceTaskState,
  shouldNotifyDone,
  toolActivity,
} from "../public/js/task-status.js";

const started = (key) =>
  reduceAll([
    { type: "__session", key: key || "s:a" },
    { type: "__connection", status: "open" },
    { type: "agent_start" },
  ]);

describe("task status reducer", () => {
  it("maps thinking and text events to human labels", () => {
    let state = started();
    state = reduceTaskState(state, { type: "thinking_start" });
    assert.equal(state.phase, PHASE.THINKING);
    assert.equal(describeTask(state).label, "正在思考");
    assert.equal(describeTask(state).showSpinner, true);

    state = reduceTaskState(state, { type: "thinking_end" });
    assert.equal(state.phase, PHASE.WORKING);
    assert.equal(describeTask(state).label, "正在处理你的请求");

    state = reduceTaskState(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    });
    assert.equal(state.phase, PHASE.WRITING);
    assert.equal(describeTask(state).label, "正在写回复");

    state = reduceTaskState(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_end", content: "你好" },
    });
    assert.equal(state.phase, PHASE.WORKING);
  });

  it("maps a single file tool by name and path, without inventing shell meaning", () => {
    let state = started();
    state = reduceTaskState(state, {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "read",
      args: { path: "/ws/notes/hello.md" },
    });
    assert.equal(state.phase, PHASE.TOOL);
    assert.equal(describeTask(state).label, "正在读取「hello.md」");
    assert.deepEqual(state.turnFiles, []);

    state = reduceTaskState(state, {
      type: "tool_execution_start",
      toolCallId: "t2",
      toolName: "bash",
      args: { command: "echo hi > /ws/out.txt" },
    });
    const view = describeTask(state);
    assert.match(view.label, /正在同时处理 2 项/);
    assert.match(view.label, /读取文件/);
    assert.match(view.label, /运行命令/);
    assert.doesNotMatch(view.label, /out\.txt/);
    assert.doesNotMatch(view.label, /echo hi/);
    assert.deepEqual(state.turnFiles, []);
  });

  it("tracks concurrent tools and records only edit/write paths", () => {
    let state = started();
    state = reduceTaskState(state, {
      type: "tool_execution_start",
      toolCallId: "a",
      toolName: "write",
      args: { path: "/ws/a.md" },
    });
    state = reduceTaskState(state, {
      type: "tool_execution_start",
      toolCallId: "b",
      toolName: "edit",
      args: { path: "/ws/b.md" },
    });
    assert.equal(describeTask(state).label, "正在同时处理 2 项（写入文件、修改文件）");
    assert.deepEqual(state.turnFiles, ["/ws/a.md", "/ws/b.md"]);

    state = reduceTaskState(state, { type: "tool_execution_end", toolCallId: "a", isError: false });
    assert.equal(describeTask(state).label, "正在修改「b.md」");
  });

  it("does not fail the turn when a tool errors and the agent later succeeds", () => {
    let state = started();
    state = reduceTaskState(state, {
      type: "tool_execution_start",
      toolCallId: "bad",
      toolName: "read",
      args: { path: "/ws/missing.txt" },
    });
    state = reduceTaskState(state, { type: "tool_execution_end", toolCallId: "bad", isError: true });
    assert.equal(state.phase, PHASE.WORKING);
    assert.equal(state.settledKind, null);

    state = reduceTaskState(state, {
      type: "tool_execution_start",
      toolCallId: "ok",
      toolName: "write",
      args: { path: "/ws/result.md" },
    });
    state = reduceTaskState(state, { type: "tool_execution_end", toolCallId: "ok", isError: false });
    state = reduceTaskState(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_start" },
    });
    state = reduceTaskState(state, { type: "agent_settled", aborted: false });

    assert.equal(state.phase, PHASE.COMPLETED);
    const view = describeTask(state);
    assert.equal(view.label, "已完成");
    assert.equal(view.summary, "已完成。改了 1 个文件，点下面的文件名可预览或下载。其中有 1 个步骤没有成功。");
    assert.deepEqual(view.files, ["/ws/result.md"]);
    assert.equal(shouldNotifyDone(state), true);
    assert.doesNotMatch(view.summary, /已完成你所有要求/);
  });

  it("marks a true agent failure after retry exhaustion, not a single tool error", () => {
    let state = started();
    state = reduceTaskState(state, {
      type: "tool_execution_start",
      toolCallId: "t",
      toolName: "read",
      args: { path: "/ws/a.txt" },
    });
    state = reduceTaskState(state, { type: "tool_execution_end", toolCallId: "t", isError: true });
    state = reduceTaskState(state, { type: "auto_retry_start", attempt: 1, maxAttempts: 2 });
    assert.equal(state.phase, PHASE.RETRYING);
    assert.equal(describeTask(state).label, "请求失败，正在重试（1/2）");

    state = reduceTaskState(state, { type: "auto_retry_end", success: false, finalError: "模型不可用" });
    state = reduceTaskState(state, { type: "agent_settled" });
    assert.equal(state.phase, PHASE.FAILED);
    assert.equal(describeTask(state).summary, "没有完成：模型不可用。");
    assert.equal(shouldNotifyDone(state), false);
  });

  it("treats assistant stopReason error as a failed turn", () => {
    let state = started();
    state = reduceTaskState(state, {
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "context overflow" },
    });
    state = reduceTaskState(state, { type: "agent_settled" });
    assert.equal(state.phase, PHASE.FAILED);
    assert.match(describeTask(state).summary, /没有完成：context overflow/);
  });

  it("recovers when an automatic retry later succeeds", () => {
    let state = started();
    state = reduceTaskState(state, { type: "auto_retry_start", attempt: 1, maxAttempts: 2 });
    state = reduceTaskState(state, { type: "auto_retry_end", success: true });
    state = reduceTaskState(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_start" },
    });
    state = reduceTaskState(state, { type: "agent_settled" });
    assert.equal(state.phase, PHASE.COMPLETED);
    assert.equal(describeTask(state).summary, "已完成。");
  });

  it("treats abort as stopped, not failed", () => {
    let state = started();
    state = reduceTaskState(state, { type: "thinking_start" });
    state = reduceTaskState(state, { type: "agent_settled", aborted: true });
    assert.equal(state.phase, PHASE.STOPPED);
    assert.equal(describeTask(state).summary, "已停止。");
    assert.equal(shouldNotifyDone(state), false);
  });

  it("shows waiting only for real pending extension dialogs, then clears on resolve or reject", () => {
    let state = started();
    state = reduceTaskState(state, { type: "extension_ui_request", method: "notify", message: "hi" });
    assert.equal(state.phase, PHASE.WORKING);
    assert.equal(state.waiting, null);

    state = reduceTaskState(state, { type: "extension_ui_request", method: "setStatus", statusText: "busy" });
    assert.equal(state.waiting, null);

    state = reduceTaskState(state, {
      type: "extension_ui_request",
      id: "ui-1",
      method: "confirm",
      title: "允许运行？",
    });
    assert.equal(state.phase, PHASE.WAITING);
    assert.equal(describeTask(state).label, "等待你确认");
    assert.equal(describeTask(state).live, "assertive");
    assert.equal(describeTask(state).showSpinner, false);

    state = reduceTaskState(state, { type: "__ui_resolved", id: "ui-1", cancelled: false });
    assert.equal(state.waiting, null);
    assert.equal(state.phase, PHASE.WORKING);

    state = reduceTaskState(state, { type: "extension_ui_request", id: "ui-2", method: "select" });
    assert.equal(describeTask(state).label, "等待你选择");
    state = reduceTaskState(state, { type: "__ui_resolved", id: "ui-2", cancelled: true });
    assert.equal(state.phase, PHASE.WORKING);

    state = reduceTaskState(state, { type: "extension_ui_request", id: "ui-3", method: "input" });
    assert.equal(describeTask(state).label, "等待你输入");
    state = reduceTaskState(state, { type: "extension_ui_request", id: "ui-4", method: "editor" });
    assert.equal(describeTask(state).label, "等待你编辑");
    state = reduceTaskState(state, { type: "__ui_resolved", id: "other" });
    assert.equal(state.waiting.id, "ui-4");
    state = reduceTaskState(state, { type: "__ui_resolved", id: "ui-4" });
    assert.equal(state.waiting, null);
  });

  it("distinguishes disconnect from task failure and restores after reconnect", () => {
    let state = started();
    state = reduceTaskState(state, {
      type: "tool_execution_start",
      toolCallId: "t",
      toolName: "write",
      args: { path: "/ws/keep.md" },
    });
    state = reduceTaskState(state, { type: "__connection", status: "reconnecting" });
    assert.equal(state.phase, PHASE.DISCONNECTED);
    const view = describeTask(state);
    assert.match(view.label, /连接已断开，正在重连/);
    assert.match(view.label, /不是最新的/);
    assert.notEqual(view.phase, PHASE.FAILED);
    assert.equal(state.settledKind, null);
    assert.equal(connectionLabel(state), "连接中断，正在重连…");

    state = reduceTaskState(state, { type: "__connection", status: "open" });
    state = reduceTaskState(state, { type: "__replay", on: false });
    assert.equal(state.phase, PHASE.TOOL);
    assert.equal(describeTask(state).label, "正在写入「keep.md」");

    state = reduceTaskState(state, { type: "__connection", status: "down" });
    assert.equal(connectionLabel(state), "后端未连接");
    assert.notEqual(describeTask(state).phase, PHASE.FAILED);
  });

  it("does not treat a replayed or snapshotted completion as just finished", () => {
    let state = reduceAll([
      { type: "__session", key: "s:old" },
      { type: "__connection", status: "open" },
      { type: "__replay", on: true },
      { type: "agent_start" },
      {
        type: "tool_execution_start",
        toolCallId: "w",
        toolName: "write",
        args: { path: "/ws/old.md" },
      },
      { type: "tool_execution_end", toolCallId: "w" },
      { type: "agent_settled" },
    ]);
    assert.equal(state.phase, PHASE.COMPLETED);
    assert.equal(state.settledFresh, false);
    assert.equal(shouldNotifyDone(state), false);
    assert.equal(describeTask(state).settledFresh, false);

    state = reduceTaskState(state, {
      type: "__hydrate",
      snapshot: {
        key: "s:old",
        state: { isStreaming: false },
        messages: [
          { role: "user", content: "写一个文件" },
          {
            role: "assistant",
            content: [{ type: "toolCall", name: "write", arguments: { path: "/ws/old.md" } }],
          },
        ],
        pendingUi: [],
      },
    });
    assert.equal(state.settledFresh, false);
    assert.equal(shouldNotifyDone(state), false);
    assert.deepEqual(state.turnFiles, ["/ws/old.md"]);
  });

  it("hydrates a newly opened session as idle, keeping last-turn file links", () => {
    const state = reduceAll([
      { type: "__connection", status: "open" },
      { type: "__session", key: "s:new" },
      {
        type: "__hydrate",
        snapshot: {
          key: "s:new",
          state: { isStreaming: false },
          messages: [
            { role: "user", content: "第一轮" },
            {
              role: "assistant",
              content: [{ type: "toolCall", name: "write", arguments: { path: "/ws/one.md" } }],
            },
            { role: "user", content: "第二轮" },
            {
              role: "assistant",
              content: [
                { type: "toolCall", name: "bash", arguments: { command: "touch two.md" } },
                { type: "toolCall", name: "edit", arguments: { path: "/ws/two.md" } },
              ],
            },
          ],
        },
      },
    ]);
    assert.equal(state.phase, PHASE.IDLE);
    assert.equal(state.settledKind, null);
    assert.equal(shouldNotifyDone(state), false);
    assert.deepEqual(state.turnFiles, ["/ws/two.md"]);
    assert.equal(describeTask(state).summary, "");
  });

  it("hydrates pending confirmation and in-flight streaming from a snapshot", () => {
    const waiting = reduceAll([
      { type: "__session", key: "s:live" },
      { type: "__connection", status: "open" },
      {
        type: "__hydrate",
        snapshot: {
          key: "s:live",
          state: { isStreaming: true },
          pendingUi: [{ id: "p1", method: "confirm", title: "继续？" }],
          messages: [],
        },
      },
    ]);
    assert.equal(waiting.phase, PHASE.WAITING);
    assert.equal(describeTask(waiting).label, "等待你确认");

    const streaming = reduceTaskState(createTaskState("s:live"), {
      type: "__hydrate",
      snapshot: { key: "s:live", state: { isStreaming: true }, messages: [] },
    });
    streaming.connection = "open";
    const live = reduceTaskState(streaming, { type: "__connection", status: "open" });
    assert.equal(live.phase, PHASE.WORKING);
    assert.equal(live.settledFresh, false);
  });

  it("isolates state across turns and session switches", () => {
    let state = started("s:one");
    state = reduceTaskState(state, {
      type: "tool_execution_start",
      toolCallId: "w",
      toolName: "write",
      args: { path: "/ws/one.md" },
    });
    state = reduceTaskState(state, { type: "tool_execution_end", toolCallId: "w" });
    state = reduceTaskState(state, { type: "agent_settled" });
    assert.equal(state.phase, PHASE.COMPLETED);
    assert.deepEqual(state.turnFiles, ["/ws/one.md"]);

    state = reduceTaskState(state, { type: "agent_start" });
    assert.equal(state.phase, PHASE.WORKING);
    assert.deepEqual(state.turnFiles, []);
    assert.equal(state.settledKind, null);
    state = reduceTaskState(state, { type: "agent_settled" });
    assert.equal(describeTask(state).summary, "已完成。");

    state = reduceTaskState(state, { type: "__session", key: "s:two" });
    assert.equal(state.sessionKey, "s:two");
    assert.equal(state.phase, PHASE.IDLE);
    assert.deepEqual(state.turnFiles, []);
    assert.equal(state.settledKind, null);
    assert.equal(shouldNotifyDone(state), false);
  });

  it("keeps last-turn file links when reconnecting a completed live session", () => {
    let state = started("s:keep");
    state = reduceTaskState(state, {
      type: "tool_execution_start",
      toolCallId: "w",
      toolName: "write",
      args: { path: "/ws/keep.md" },
    });
    state = reduceTaskState(state, { type: "tool_execution_end", toolCallId: "w" });
    state = reduceTaskState(state, { type: "agent_settled" });
    assert.equal(shouldNotifyDone(state), true);

    state = reduceTaskState(state, { type: "__connection", status: "reconnecting" });
    state = reduceTaskState(state, { type: "__connection", status: "open" });
    state = reduceTaskState(state, { type: "__replay", on: false });
    state = reduceTaskState(state, {
      type: "__hydrate",
      snapshot: {
        key: "s:keep",
        state: { isStreaming: false },
        messages: [
          { role: "user", content: "写" },
          {
            role: "assistant",
            content: [{ type: "toolCall", name: "write", arguments: { path: "/ws/keep.md" } }],
          },
        ],
      },
    });
    assert.equal(state.phase, PHASE.COMPLETED);
    assert.equal(state.settledFresh, false);
    assert.equal(shouldNotifyDone(state), false);
    assert.deepEqual(state.turnFiles, ["/ws/keep.md"]);
    assert.match(describeTask(state).summary, /改了 1 个文件/);
  });

  it("treats an unexpected process exit as failure, and an intentional one as not", () => {
    let state = started();
    state = reduceTaskState(state, { type: "bridge_exit", intentional: false, code: 1 });
    assert.equal(state.phase, PHASE.FAILED);
    assert.match(describeTask(state).summary, /助手进程已退出/);

    let clean = started();
    clean = reduceTaskState(clean, { type: "agent_settled" });
    clean = reduceTaskState(clean, { type: "bridge_exit", intentional: true });
    assert.equal(clean.phase, PHASE.COMPLETED);
  });

  it("labels unknown and mcp tools without guessing what they did", () => {
    assert.equal(toolActivity({ name: "mystery" }), "正在使用工具「mystery」");
    let state = started();
    state = reduceTaskState(state, {
      type: "tool_execution_start",
      toolCallId: "m",
      toolName: "mcp__browser__click",
      args: { selector: "button" },
    });
    assert.equal(describeTask(state).label, "正在使用扩展「browser__click」");
  });

  it("collects only the last turn's edit/write paths from history messages", () => {
    const files = collectTurnFiles([
      { role: "user", content: "one" },
      { role: "assistant", content: [{ type: "toolCall", name: "write", arguments: { path: "/ws/old.md" } }] },
      { role: "user", content: "two" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "好的" },
          { type: "toolCall", name: "bash", arguments: { command: "rm x" } },
          { type: "toolCall", name: "edit", arguments: { path: "/ws/new.md" } },
        ],
      },
    ]);
    assert.deepEqual(files, ["/ws/new.md"]);
  });

  it("preserves an in-flight tool across same-session reconnect hydrate", () => {
    let state = started("s:live");
    state = reduceTaskState(state, {
      type: "tool_execution_start",
      toolCallId: "w",
      toolName: "write",
      args: { path: "/ws/draft.md" },
    });
    state = reduceTaskState(state, { type: "__connection", status: "reconnecting" });
    state = reduceTaskState(state, { type: "__connection", status: "open" });
    state = reduceTaskState(state, { type: "__replay", on: false });
    state = reduceTaskState(state, {
      type: "__hydrate",
      snapshot: { key: "s:live", state: { isStreaming: true }, messages: [] },
    });
    assert.equal(state.phase, PHASE.TOOL);
    assert.equal(describeTask(state).label, "正在写入「draft.md」");
    assert.deepEqual(state.turnFiles, ["/ws/draft.md"]);
  });

  it("keeps connection labels distinct and does not invent progress", () => {
    const open = reduceTaskState(createTaskState(), { type: "__connection", status: "open" });
    assert.equal(connectionLabel(open), "已连接");
    assert.equal(connectionLabel(open, { needsWorkspace: true }), "请先选择工作目录");
    const view = describeTask(started());
    assert.doesNotMatch(view.label, /%/);
    assert.doesNotMatch(view.label, /预计|分钟|秒后/);
  });
});
