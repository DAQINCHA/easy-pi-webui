import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deferred, jsonResponse, loadApp, sidebarLabels } from "./helpers/frontend.mjs";

const FILE = "/ws/active.jsonl";
const OTHER = "/ws/other.jsonl";

function session(overrides = {}) {
  return {
    file: FILE,
    id: "1",
    name: "",
    title: "第一条消息",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archived: false,
    pinned: false,
    ...overrides,
  };
}

function makeApp(fetchImpl) {
  const app = loadApp({ fetch: fetchImpl });
  app.state.key = "s:1";
  app.state.file = FILE;
  app.state.workspace = "/ws";
  app.state.messages = [{ role: "user", content: [{ type: "text", text: "第一条消息" }] }];
  app.state.sessions = [session()];
  app.renderSessions();
  app.updateHeader();
  return app;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("active sidebar title freshness", () => {
  it("shows an active manual rename at once, even when the list response is stale", async () => {
    const stale = [session()];
    const app = makeApp(async (path) => {
      if (path === "/api/sessions") return jsonResponse({ sessions: stale });
      return jsonResponse({ success: true });
    });
    assert.deepEqual(sidebarLabels(app), ["第一条消息"]);

    await app.saveName("手动新名", "s:1", true);

    assert.equal(app.state.sessionName, "手动新名");
    assert.deepEqual(sidebarLabels(app), ["手动新名"]);
    assert.equal(app.el.title.textContent, "手动新名");

    // 再刷新几次旧列表，也不能把刚改的名字盖回去。
    await app.refreshSessions();
    await app.refreshSessions();
    assert.deepEqual(sidebarLabels(app), ["手动新名"]);
    assert.equal(app.state.sessionName, "手动新名");
  });

  it("applies an auto-name event to the current row without switching sessions", async () => {
    const stale = [session()];
    const app = makeApp(async (path) => {
      if (path === "/api/sessions") return jsonResponse({ sessions: stale });
      return jsonResponse({ success: true });
    });
    const key = app.state.key;
    const file = app.state.file;

    app.handleEvent({ type: "session_info_changed", name: "自动生成的标题" });

    // 事件处理函数返回时就该是新标题，不等列表刷新。
    assert.deepEqual(sidebarLabels(app), ["自动生成的标题"]);
    assert.equal(app.state.sessionName, "自动生成的标题");
    assert.equal(app.el.title.textContent, "自动生成的标题");
    assert.equal(app.state.key, key);
    assert.equal(app.state.file, file);
    assert.equal(app.fetchCalls.some((call) => call.path === "/api/session/open"), false);

    await tick();
    await app.refreshSessions();
    assert.deepEqual(sidebarLabels(app), ["自动生成的标题"]);
  });

  it("keeps the new name when the event arrives before the rename response", async () => {
    const pending = deferred();
    const stale = [session()];
    const app = makeApp(async (path) => {
      if (path === "/api/sessions") return jsonResponse({ sessions: stale });
      if (path === "/api/rename") return pending.promise;
      return jsonResponse({ success: true });
    });

    const saving = app.saveName("先事件后响应", "s:1", true);
    // fake-pi / 官方 pi 都是先发 session_info_changed，再回 set_session_name。
    app.handleEvent({ type: "session_info_changed", name: "先事件后响应" });
    assert.deepEqual(sidebarLabels(app), ["先事件后响应"]);
    assert.equal(app.state.sessionName, "先事件后响应");

    pending.resolve(jsonResponse({ success: true }));
    await saving;
    assert.deepEqual(sidebarLabels(app), ["先事件后响应"]);
    assert.equal(app.state.sessionName, "先事件后响应");
  });

  it("does not regress on older list responses or an older snapshot", async () => {
    const oldList = deferred();
    const newList = deferred();
    let listCalls = 0;
    const app = makeApp(async (path) => {
      if (path === "/api/sessions") {
        listCalls += 1;
        return listCalls === 1 ? oldList.promise : newList.promise;
      }
      return jsonResponse({ success: true });
    });

    const snapshotSeq = app.nextSessionsSeq();
    app.handleEvent({ type: "session_info_changed", name: "最新标题" });
    assert.deepEqual(sidebarLabels(app), ["最新标题"]);

    // 先发旧列表请求，再发新列表请求；新列表先回来，旧的后回来。
    const older = app.refreshSessions();
    const newer = app.refreshSessions();
    newList.resolve(jsonResponse({ sessions: [session({ name: "最新标题" })] }));
    await newer;
    assert.deepEqual(sidebarLabels(app), ["最新标题"]);

    oldList.resolve(jsonResponse({ sessions: [session({ name: "" })] }));
    await older;
    assert.deepEqual(sidebarLabels(app), ["最新标题"]);
    assert.equal(app.state.sessionName, "最新标题");

    // 比事件更旧的快照（仍带旧名字 / 旧列表）也不能回退。
    app.applySnapshot(
      {
        key: "s:1",
        sessionFile: FILE,
        workspace: "/ws",
        state: { sessionName: "" },
        messages: [],
        sessions: [session({ name: "" })],
        pendingUi: [],
      },
      snapshotSeq,
    );
    assert.deepEqual(sidebarLabels(app), ["最新标题"]);
    assert.equal(app.state.sessionName, "最新标题");
  });

  it("keeps a fresh list title when an older snapshot arrives afterwards", async () => {
    const app = makeApp(async (path) => {
      if (path === "/api/sessions") {
        return jsonResponse({ sessions: [session({ name: "列表里的新标题" })] });
      }
      return jsonResponse({ success: true });
    });
    const snapshotSeq = app.nextSessionsSeq();

    await app.refreshSessions();
    assert.deepEqual(sidebarLabels(app), ["列表里的新标题"]);
    assert.equal(app.state.sessionName, "列表里的新标题");

    app.applySnapshot(
      {
        key: "s:1",
        sessionFile: FILE,
        workspace: "/ws",
        state: { sessionName: "" },
        messages: [{ role: "user", content: [{ type: "text", text: "第一条消息" }] }],
        sessions: [session({ name: "" })],
        pendingUi: [],
      },
      snapshotSeq,
    );
    assert.deepEqual(sidebarLabels(app), ["列表里的新标题"]);
    assert.equal(app.state.sessionName, "列表里的新标题");
  });

  it("does not let a delayed resync snapshot overwrite a later title", async () => {
    const pendingSnapshot = deferred();
    const freshList = [session({ name: "手动标题" })];
    const app = makeApp(async (path) => {
      if (path === "/api/session/snapshot") return pendingSnapshot.promise;
      if (path === "/api/sessions") return jsonResponse({ sessions: freshList });
      if (path === "/api/rename") return jsonResponse({ success: true });
      return jsonResponse({ success: true });
    });

    // 先建立一个带旧标题的活动快照。
    app.applySnapshot({
      key: "s:1",
      sessionFile: FILE,
      workspace: "/ws",
      state: { sessionName: "旧标题" },
      messages: [{ role: "user", content: [{ type: "text", text: "第一条消息" }] }],
      sessions: [session({ name: "旧标题" })],
      pendingUi: [],
    });
    assert.equal(app.state.sessionName, "旧标题");
    assert.deepEqual(sidebarLabels(app), ["旧标题"]);

    // 真实 resync：请求在改名之前发出，响应在改名之后才回来。
    const resyncing = app.resync();
    assert.equal(app.fetchCalls.some((call) => call.path === "/api/session/snapshot"), true);

    app.handleEvent({ type: "session_info_changed", name: "事件标题" });
    await app.saveName("手动标题", "s:1", true);
    await app.refreshSessions();

    pendingSnapshot.resolve(
      jsonResponse({
        key: "s:1",
        sessionFile: FILE,
        workspace: "/ws",
        state: { sessionName: "旧标题" },
        messages: [{ role: "user", content: [{ type: "text", text: "第一条消息" }] }],
        sessions: [session({ name: "旧标题" })],
        pendingUi: [],
      }),
    );
    await resyncing;
    await tick();

    assert.equal(app.state.key, "s:1");
    assert.equal(app.state.file, FILE);
    assert.equal(app.state.sessionName, "手动标题");
    assert.equal(app.el.title.textContent, "手动标题");
    assert.deepEqual(sidebarLabels(app), ["手动标题"]);
  });

  it("renames the session that was current when the request started", async () => {
    const pendingRename = deferred();
    const list = [
      session({ name: "" }),
      session({ file: OTHER, id: "2", name: "另一个会话", title: "另一条消息" }),
    ];
    const app = makeApp(async (path) => {
      if (path === "/api/rename") return pendingRename.promise;
      if (path === "/api/sessions") return jsonResponse({ sessions: list });
      return jsonResponse({ success: true });
    });
    app.state.sessions = list;
    app.renderSessions();

    const saving = app.saveName("当前会话的新名", "s:1", true);
    // 请求还没回来时切到另一个会话。
    app.applySnapshot({
      key: "s:2",
      sessionFile: OTHER,
      workspace: "/ws",
      state: { sessionName: "另一个会话" },
      messages: [{ role: "user", content: [{ type: "text", text: "另一条消息" }] }],
      sessions: list,
      pendingUi: [],
    });
    assert.equal(app.state.key, "s:2");
    assert.equal(app.state.file, OTHER);
    assert.equal(app.state.sessionName, "另一个会话");

    pendingRename.resolve(jsonResponse({ success: true }));
    await saving;
    await tick();

    assert.equal(app.state.key, "s:2");
    assert.equal(app.state.file, OTHER);
    assert.equal(app.state.sessionName, "另一个会话");
    assert.equal(app.el.title.textContent, "另一个会话");
    assert.deepEqual(sidebarLabels(app), ["当前会话的新名", "另一个会话"]);
  });

  it("lets a named list fill in an unnamed snapshot title", async () => {
    const app = makeApp(async (path) => {
      if (path === "/api/sessions") {
        return jsonResponse({ sessions: [session({ name: "保存后的标题" })] });
      }
      return jsonResponse({ success: true });
    });

    app.applySnapshot({
      key: "s:1",
      sessionFile: FILE,
      workspace: "/ws",
      state: { sessionName: "" },
      messages: [{ role: "user", content: [{ type: "text", text: "第一条消息" }] }],
      sessions: [session({ name: "" })],
      pendingUi: [],
    });
    assert.equal(app.state.sessionName, "");
    assert.equal(app.state.sessionNames.has(FILE), false);
    assert.deepEqual(sidebarLabels(app), ["第一条消息"]);

    await app.refreshSessions();

    assert.equal(app.state.sessionName, "保存后的标题");
    assert.equal(app.el.title.textContent, "保存后的标题");
    assert.deepEqual(sidebarLabels(app), ["保存后的标题"]);
  });

  it("updates a non-active row immediately without touching the active title", async () => {
    const stale = [session(), session({ file: OTHER, id: "2", title: "另一条消息" })];
    const app = makeApp(async (path) => {
      if (path === "/api/sessions") return jsonResponse({ sessions: stale });
      return jsonResponse({ success: true });
    });
    app.state.sessions = stale;
    app.renderSessions();
    assert.deepEqual(sidebarLabels(app), ["第一条消息", "另一条消息"]);

    await app.saveName("另一个会话的名字", "s:2", false);

    assert.deepEqual(sidebarLabels(app), ["第一条消息", "另一个会话的名字"]);
    assert.equal(app.state.sessionName, "");
    assert.equal(app.el.title.textContent, "第一条消息");
  });

  it("keeps branch suffixes, the unnamed fallback and the new-session placeholder", async () => {
    const app = makeApp(async (path) => {
      if (path === "/api/sessions") return jsonResponse({ sessions: [] });
      return jsonResponse({ success: true });
    });

    app.state.key = "s:2";
    app.state.file = OTHER;
    app.state.sessionName = "分支标题 · 另一分支";
    app.state.sessions = [
      session({ file: OTHER, id: "2", name: "分支标题 · 另一分支", title: "旧标题" }),
    ];
    app.renderSessions();
    assert.deepEqual(sidebarLabels(app), ["分支标题 · 另一分支"]);

    await app.saveName("分支标题 · 另一分支（改）", "s:2", true);
    assert.deepEqual(sidebarLabels(app), ["分支标题 · 另一分支（改）"]);
    assert.equal(app.state.sessionName, "分支标题 · 另一分支（改）");

    // 未命名：回退到第一条用户消息。
    app.state.key = "s:1";
    app.state.file = FILE;
    app.state.sessionName = "";
    app.state.sessions = [session({ name: "", title: "第一条消息" })];
    app.renderSessions();
    assert.deepEqual(sidebarLabels(app), ["第一条消息"]);

    // 新会话占位：没有消息、没有名字时显示「新对话」。
    app.state.key = "s:3";
    app.state.file = "/ws/new.jsonl";
    app.state.sessionName = "";
    app.state.messages = [];
    app.state.sessions = [];
    app.renderSessions();
    assert.deepEqual(sidebarLabels(app), ["新对话"]);
  });
});
