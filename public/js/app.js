import { renderMarkdown, escapeHtml } from "./markdown.js";

const $ = (id) => document.getElementById(id);

const el = {
  app: $("app"),
  scrim: $("scrim"),
  sidebar: $("sidebar"),
  resizer: $("sidebarResizer"),
  rail: $("messageRail"),
  railTicks: $("railTicks"),
  railTip: $("railTip"),
  sessionList: $("sessionList"),
  search: $("sessionSearch"),
  newChat: $("newChatBtn"),
  brand: $("brandHome"),
  workspaceChip: $("workspaceChip"),
  workspaceName: $("workspaceName"),
  themeBtn: $("themeBtn"),
  menuBtn: $("menuBtn"),
  title: $("sessionTitle"),
  brandVersion: $("brandVersion"),
  moreBtn: $("moreBtn"),
  thread: $("thread"),
  messages: $("messages"),
  empty: $("emptyState"),
  suggestions: $("suggestions"),
  emptyPickBtn: $("emptyPickBtn"),
  toBottom: $("toBottom"),
  input: $("input"),
  composer: $("composer"),
  attachRow: $("attachRow"),
  attachBtn: $("attachBtn"),
  fileInput: $("fileInput"),
  sendBtn: $("sendBtn"),
  modelChip: $("modelChip"),
  modelChipText: $("modelChipText"),
  thinkChip: $("thinkChip"),
  thinkChipText: $("thinkChipText"),
  ctxChip: $("ctxChip"),
  ctxArc: $("ctxArc"),
  ctxText: $("ctxText"),
  queuePill: $("queuePill"),
  queueCount: $("queueCount"),
  hintText: $("hintText"),
  statusHint: $("statusHint"),
  menuLayer: $("menuLayer"),
  modalLayer: $("modalLayer"),
  toasts: $("toasts"),
};

const state = {
  key: null,
  file: null,
  workspace: "",
  needsWorkspace: false,
  workspaceError: "",
  piVersion: "",
  sessions: [],
  messages: [],
  forkMessages: [],
  forkBusy: false,
  turnFiles: new Map(),
  turnSummary: null,
  turnSummaryOpen: false,
  replaying: false,
  models: [],
  commands: [],
  thinkingLevels: ["off"],
  model: null,
  thinkingLevel: "off",
  sessionName: "",
  stats: {},
  streaming: false,
  live: null,
  optimisticEl: null,
  // 当前轮次（turn）的 DOM 节点，重绘时按它定位插入点。
  lastTurnNodes: [],
  toolResults: new Map(),
  toolLive: new Map(),
  toolOpen: new Map(),
  // 过程组（相邻思考/工具）的展开状态，键是 "m<消息序号>:g<组序号>"。
  procOpen: new Map(),
  openThink: false,
  attachments: [],
  filter: "",
  archivedOpen: false,
  menuAnchor: null,
  es: null,
  statusEs: null,
  statusRefreshTimer: 0,
  // 首条 /api/session-events 的 status 事件到达前，侧栏也可能已经渲染；
  // 给一个空 Map，避免 renderSessions / markSeen 读到 undefined。
  runtime: new Map(),
  lastSeq: 0,
  queue: 0,
  slash: null,
  activity: "",
  railActive: null,
  installPrompt: null,
};

const ICON = (name) => '<svg aria-hidden="true"><use href="#i-' + name + '"/></svg>';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

async function api(path, body) {
  const options =
    body === undefined
      ? {}
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "HTTP " + response.status);
  return data;
}

function toast(message, kind) {
  const node = document.createElement("div");
  node.className = "toast" + (kind === "error" ? " error" : "");
  node.textContent = message;
  el.toasts.appendChild(node);
  setTimeout(() => {
    node.style.opacity = "0";
    node.style.transition = "opacity .2s";
    setTimeout(() => node.remove(), 220);
  }, kind === "error" ? 5200 : 2800);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function basename(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  return parts[parts.length - 1] || path || "";
}

function timeLabel(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function relativeTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const diff = Date.now() - date.getTime();
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
  if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
  if (diff < 7 * 86400000) return Math.floor(diff / 86400000) + " 天前";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
}

function dayBucket(iso) {
  const date = new Date(iso);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diff = Math.round((start - day) / 86400000);
  if (diff <= 0) return "今天";
  if (diff === 1) return "昨天";
  if (diff < 7) return "7 天内";
  return "更早";
}

function fmtTokens(value) {
  const n = Number(value) || 0;
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 10000) return Math.round(n / 1000) + "k";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function fmtCost(value) {
  const n = Number(value) || 0;
  if (!n) return "$0";
  return "$" + (n < 0.01 ? n.toFixed(4) : n.toFixed(2));
}

function fmtDuration(ms) {
  if (ms === undefined || ms === null) return "";
  if (ms < 1000) return Math.round(ms) + "ms";
  return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + "s";
}

function truncate(text, limit) {
  const value = String(text ?? "");
  return value.length > limit ? value.slice(0, limit) + "\n…（已截断）" : value;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function textOf(message) {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && block.type === "text")
      .map((block) => block.text || "")
      .join("\n");
  }
  return "";
}

function imageBlocks(message) {
  if (!message || !Array.isArray(message.content)) return [];
  return message.content.filter((block) => block && block.type === "image");
}

function sessionTitle() {
  if (state.sessionName) return state.sessionName;
  const first = state.messages.find((message) => message.role === "user");
  if (first) {
    const flat = textOf(first).replace(/\s+/g, " ").trim();
    if (flat) return flat.length > 42 ? flat.slice(0, 42) + "…" : flat;
  }
  return "新对话";
}

function shortenPath(path) {
  const value = String(path || "");
  if (value.length <= 64) return value;
  return "…" + value.slice(-60);
}

/* ------------------------------------------------------------------ */
/* sidebar                                                             */
/* ------------------------------------------------------------------ */

function sessionItemHtml(session) {
  const active = state.key === "s:" + session.id;
  const runtime = state.runtime.get(session.id);
  const running = Boolean(runtime && runtime.running) || (active && state.streaming);
  const errored = !running && Boolean(runtime && runtime.errored);
  const unread = !running && !errored && Boolean(runtime && runtime.unread);
  const label = session.name || session.title;
  const pinned = Boolean(session.pinned) && !session.archived;
  return (
    '<div class="session-wrap' + (session.archived ? " archived" : "") + (pinned ? " pinned" : "") + (running ? " running" : "") + '">' +
    '<button class="session-item' + (active ? " active" : "") + '" data-file="' + escapeHtml(session.file) + '">' +
    '<span class="row"><span class="t">' + escapeHtml(label) + "</span>" +
    (running
      ? '<span class="session-spin" title="正在工作"></span>'
      : errored
        ? '<span class="error-dot" title="模型错误，会话已终止"></span>'
        : unread
          ? '<span class="unread-dot" title="已完成，未读"></span>'
          : "") +
    "</span>" +
    '<span class="m">' + escapeHtml(relativeTime(session.updatedAt)) + "</span>" +
    "</button>" +
    (session.archived
      ? '<button class="session-action" type="button" data-menu-file="' + escapeHtml(session.file) + '" title="会话操作" aria-label="会话操作">' +
        ICON("dots") +
        "</button>"
      : '<button class="session-action pin' + (pinned ? " on" : "") + '" type="button" data-pin-file="' + escapeHtml(session.file) +
        '" title="' + (pinned ? "取消置顶" : "置顶会话") + '" aria-label="' + (pinned ? "取消置顶" : "置顶会话") + '">' +
        ICON("pin") +
        "</button>" +
        '<button class="session-action archive" type="button" data-archive-file="' + escapeHtml(session.file) + '" title="归档会话" aria-label="归档会话">' +
        ICON("archive") +
        "</button>") +
    "</div>"
  );
}

function renderSessions() {
  const query = state.filter.trim().toLowerCase();
  const list = state.sessions.filter((session) => {
    if (!query) return true;
    return (session.title + " " + session.name).toLowerCase().includes(query);
  });

  if (!list.length) {
    el.sessionList.innerHTML =
      '<div class="session-empty">' +
      (query ? "没有匹配的会话" : "还没有会话<br>发一条消息就会出现在这里") +
      "</div>";
    return;
  }

  const pinned = list.filter((session) => session.pinned && !session.archived);
  const active = list.filter((session) => !session.archived && !session.pinned);
  const archived = list.filter((session) => session.archived);

  let html = "";
  if (pinned.length) {
    html += '<div class="session-group-label">已置顶</div>';
    for (const session of pinned) html += sessionItemHtml(session);
  }
  if (active.length) {
    const groups = new Map();
    for (const session of active) {
      const label = dayBucket(session.updatedAt);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(session);
    }
    for (const [label, sessions] of groups) {
      html += '<div class="session-group-label">' + label + "</div>";
      for (const session of sessions) html += sessionItemHtml(session);
    }
  }

  if (archived.length) {
    const open = state.archivedOpen || Boolean(query);
    html +=
      '<button class="session-group-label archived-toggle' + (open ? " open" : "") + '" type="button" data-toggle-archive>' +
      "<span>已归档</span><span class=\"count\">" + archived.length + "</span>" +
      '<span class="chev">' + ICON("right") + "</span>" +
      "</button>";
    if (open) {
      for (const session of archived) html += sessionItemHtml(session);
    }
  }

  el.sessionList.innerHTML = html;
}

function updateWorkspace() {
  if (!state.workspace) {
    el.workspaceName.textContent = "未选择工作目录";
    el.workspaceChip.title = "点击选择工作目录";
    return;
  }
  el.workspaceName.textContent = basename(state.workspace) || state.workspace;
  el.workspaceChip.title = "切换工作区 · " + state.workspace;
}

// 未选择工作区时：不建会话、不发消息，只留「选目录」这一条路。
function updateWorkspaceGate() {
  const heading = el.empty.querySelector("h1");
  if (heading) heading.textContent = state.needsWorkspace ? "请先选择工作目录" : "今天想做点什么？";
  el.suggestions.hidden = Boolean(state.needsWorkspace);
  el.emptyPickBtn.hidden = !state.needsWorkspace;
  updateSendState();
  setStatus(state.needsWorkspace ? "请先选择工作目录" : "已连接");
}

function dismissModal() {
  el.modalLayer.hidden = true;
  el.modalLayer.innerHTML = "";
  el.modalLayer.onclick = null;
}

/** 首次/失效配置时的选目录弹窗：沿用现有 openModal + .field + /api/workspace。 */
function openWorkspacePicker() {
  if (!el.modalLayer.hidden) return;
  const recent = readRecentWorkspaces();
  const recentHtml = recent.length
    ? '<div class="ws-menu-label">最近使用</div><div class="ws-menu-list">' +
      recent
        .map(
          (item) =>
            '<button class="recent-item" type="button" data-pick-recent="' + escapeHtml(item) + '">' +
            '<span class="recent-name">' + escapeHtml(basename(item) || item) + "</span>" +
            '<span class="recent-path">' + escapeHtml(item) + "</span>" +
            "</button>",
        )
        .join("") +
      "</div>"
    : "";
  const hint = state.workspaceError
    ? '<div class="ws-menu-hint">启动提示：' + escapeHtml(state.workspaceError) + "</div>"
    : '<div class="ws-menu-hint">这台电脑第一次使用 Easy-Pi WebUI。选一个目录作为工作区，选择会保存在这台电脑上，以后自动记住。</div>';

  const modal = openModal({
    title: "选择工作目录",
    body:
      hint +
      '<input class="field" id="workspacePath" placeholder="/绝对/路径" autocomplete="off">' +
      '<div style="margin-top:10px"><button class="picker-btn" type="button" id="workspacePickInModal">' +
      PICKER_LABEL +
      "</button></div>" +
      recentHtml,
    actions: [
      { label: "取消" },
      {
        label: "使用这个目录",
        kind: "primary",
        onClick: (card) => {
          const path = card.querySelector("#workspacePath").value.trim();
          if (!path) {
            toast("请输入目录路径", "error");
            return false;
          }
          switchToWorkspace(path);
          return false;
        },
      },
    ],
  });

  const input = modal.card.querySelector("#workspacePath");
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      modal.card.querySelector(".btn.primary").click();
    }
  });
  const pick = modal.card.querySelector("#workspacePickInModal");
  pick.addEventListener("click", async () => {
    const label = pick.innerHTML;
    pick.disabled = true;
    try {
      const data = await api("/api/workspace/pick", {});
      if (data.cancelled || !data.path) return;
      input.value = data.path;
      switchToWorkspace(data.path);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      if (document.body.contains(pick)) {
        pick.disabled = false;
        pick.innerHTML = label;
      }
    }
  });
  for (const row of modal.card.querySelectorAll("[data-pick-recent]")) {
    row.addEventListener("click", () => switchToWorkspace(row.getAttribute("data-pick-recent")));
  }
  input.focus();
}

const PICKER_LABEL = '<svg><use href="#i-folder"/></svg><span>打开工作区...</span>';
const WORKSPACE_RECENT_KEY = "piwebui.workspaces";

function readRecentWorkspaces() {
  try {
    const raw = JSON.parse(localStorage.getItem(WORKSPACE_RECENT_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((item) => typeof item === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

function rememberWorkspace(path) {
  const list = [path, ...readRecentWorkspaces().filter((item) => item !== path)].slice(0, 8);
  try {
    localStorage.setItem(WORKSPACE_RECENT_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

function forgetWorkspace(path) {
  const list = readRecentWorkspaces().filter((item) => item !== path);
  try {
    localStorage.setItem(WORKSPACE_RECENT_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

function openWorkspaceMenu() {
  const current = state.workspace || "";
  const recent = readRecentWorkspaces().filter((item) => item !== current);
  const recentHtml = recent.length
    ? '<div class="ws-menu-label">最近使用</div><div class="ws-menu-list">' +
      recent
        .map(
          (item) =>
            '<div class="recent-row">' +
            '<button class="recent-item" type="button" data-recent="' + escapeHtml(item) + '">' +
            '<span class="recent-name">' + escapeHtml(basename(item) || item) + "</span>" +
            '<span class="recent-path">' + escapeHtml(item) + "</span>" +
            "</button>" +
            '<button class="recent-remove" type="button" data-remove-recent="' + escapeHtml(item) + '" title="从最近使用中移除" aria-label="从最近使用中移除">' +
            ICON("x") +
            "</button>" +
            "</div>",
        )
        .join("") +
      "</div>"
    : '<div class="ws-menu-empty">还没有其他目录</div>';
  const html =
    '<div class="ws-menu-head">' +
    '<div class="ws-menu-name">' + escapeHtml(basename(current) || current) + "</div>" +
    '<div class="ws-menu-path">' + escapeHtml(current) + "</div>" +
    "</div>" +
    '<button class="picker-btn" type="button" id="workspacePick">' + PICKER_LABEL + "</button>" +
    '<div class="ws-menu-hint">' +
    (state.streaming ? "当前会话会在后台继续，不会中断。" : "旧目录的会话不会丢。") +
    "</div>" +
    recentHtml;

  openMenu(el.workspaceChip, [], { html, align: "left", preferUp: true, className: "workspace-menu" });

  const pick = el.menuLayer.querySelector("#workspacePick");
  if (pick) pick.addEventListener("click", () => pickWorkspace(pick));
  for (const row of el.menuLayer.querySelectorAll("[data-recent]")) {
    row.addEventListener("click", () => switchToWorkspace(row.getAttribute("data-recent")));
  }
  for (const button of el.menuLayer.querySelectorAll("[data-remove-recent]")) {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      forgetWorkspace(button.getAttribute("data-remove-recent"));
      openWorkspaceMenu();
    });
  }
}

async function pickWorkspace(button) {
  if (state.switching) return;
  const label = button.innerHTML;
  button.disabled = true;
  button.textContent = "正在打开…";
  try {
    const data = await api("/api/workspace/pick", {});
    if (data.cancelled || !data.path) {
      toast("已取消选择");
      return;
    }
    await switchToWorkspace(data.path);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    if (document.body.contains(button)) {
      button.disabled = false;
      button.innerHTML = label;
    }
  }
}

async function switchToWorkspace(path) {
  if (!path || state.switching) return;
  if (!state.needsWorkspace && path === state.workspace) {
    toast("当前已经是这个目录");
    closeMenu();
    return;
  }
  state.switching = true;
  try {
    const data = await api("/api/workspace", { path });
    if (!state.needsWorkspace && data.workspace === state.workspace) {
      toast("当前已经是这个目录");
      closeMenu();
      return;
    }
    rememberWorkspace(data.workspace);
    closeMenu();
    state.needsWorkspace = false;
    state.workspaceError = "";
    dismissModal();
    await resetToWorkspace(data);
    if (!data.saved) {
      toast(
        "目录已切换，但没能保存到本机配置：" +
          (data.saveError || "未知原因") +
          "；重启后需要重新选择",
        "error",
      );
    } else {
      toast("已切换到 " + (basename(data.workspace) || data.workspace));
    }
  } catch (error) {
    toast("切换失败：" + error.message, "error");
  } finally {
    state.switching = false;
  }
}

async function resetToWorkspace(data) {
  if (state.es) {
    state.es.close();
    state.es = null;
  }
  state.key = null;
  state.file = null;
  state.workspace = data.workspace || state.workspace;
  state.piVersion = data.piVersion || state.piVersion;
  state.messages = [];
  state.models = [];
  state.commands = [];
  state.thinkingLevels = ["off"];
  state.model = null;
  state.thinkingLevel = "off";
  state.sessionName = "";
  state.stats = {};
  state.streaming = false;
  state.queue = 0;
  state.attachments = [];
  state.live = null;
  state.optimisticEl = null;
  state.toolResults.clear();
  state.toolLive.clear();
  state.toolOpen.clear();

  state.sessions = data.sessions || [];
  renderAttachments();
  renderThread();
  renderSessions();
  updateWorkspace();
  updateWorkspaceGate();
  updateChips();
  updateStats();
  updateSendState();
  updateWorking();
  updateHeader();
  el.queuePill.hidden = true;

  try {
    await newSession();
  } catch (error) {
    toast("已切换目录，但新建会话失败：" + error.message, "error");
  }
}

/* ------------------------------------------------------------------ */
/* header + composer chips                                             */
/* ------------------------------------------------------------------ */

function updateHeader() {
  const title = sessionTitle();
  el.title.textContent = title;
  if (el.brandVersion) el.brandVersion.textContent = ("Pi " + state.piVersion).trim();
  document.title = title + " · Easy-Pi WebUI";
}

function updateChips() {
  const modelName = state.model ? state.model.name || state.model.id : "模型";
  el.modelChipText.textContent = modelName;
  el.modelChip.title = state.model ? modelName + " · 点击切换模型" : "选择模型";
  el.thinkChipText.textContent = "思考 " + (state.thinkingLevel || "off");
  el.thinkChip.hidden = !state.model || !state.model.reasoning;
  updateHeader();
}

function updateStats() {
  const usage = state.stats && state.stats.contextUsage;
  if (!usage || !usage.contextWindow) {
    el.ctxChip.hidden = true;
    return;
  }
  const circumference = 2 * Math.PI * 6;
  // 压缩后 pi 在下一轮回复前报告不出占比（percent 为 null）：
  // 圆环保留但置灰、弧清空，避免看起来「直接消失」。
  if (usage.percent === null || usage.percent === undefined) {
    el.ctxChip.classList.add("ctx-pending");
    el.ctxChip.hidden = false;
    el.ctxText.textContent = "—";
    el.ctxArc.style.strokeDasharray = circumference.toFixed(2);
    el.ctxArc.style.strokeDashoffset = circumference.toFixed(2);
    el.ctxChip.title = "上下文已压缩，等下一轮回复后重新统计";
    return;
  }
  el.ctxChip.classList.remove("ctx-pending");
  const percent = Math.max(0, Math.min(100, Number(usage.percent) || 0));
  const label = percent.toFixed(1) + "%";
  // 1M 上下文下线性刻度几乎看不到变化，用平方根让小幅增长也有可见的弧
  const fraction = percent <= 0 ? 0 : Math.max(Math.sqrt(percent / 100), 0.05);
  el.ctxChip.hidden = false;
  el.ctxText.textContent = label;
  el.ctxArc.style.strokeDasharray = circumference.toFixed(2);
  el.ctxArc.style.strokeDashoffset = (circumference * (1 - fraction)).toFixed(2);
  el.ctxChip.title =
    "上下文 " + label + " · " + fmtTokens(usage.tokens) + " / " + fmtTokens(usage.contextWindow) +
    " · 累计 " + fmtTokens(state.stats.tokens ? state.stats.tokens.total : 0) + " tokens";
}

function setHidden(node, hidden) {
  if (!node) return;
  if (hidden) node.setAttribute("hidden", "");
  else node.removeAttribute("hidden");
}

function updateSendState() {
  if (state.needsWorkspace) {
    el.input.disabled = true;
    el.input.placeholder = "请先选择工作目录";
    el.sendBtn.disabled = true;
    el.sendBtn.classList.remove("is-stop");
    setHidden(el.sendBtn.querySelector(".send-icon"), false);
    setHidden(el.sendBtn.querySelector(".stop-icon"), true);
    el.sendBtn.title = "请先选择工作目录";
    el.hintText.textContent = "请先选择工作目录";
    return;
  }
  el.input.disabled = false;
  el.input.placeholder = "给 pi 发消息，输入 / 查看命令";
  const hasText = el.input.value.trim().length > 0 || state.attachments.length > 0;
  const stop = state.streaming;
  el.sendBtn.classList.toggle("is-stop", stop);
  el.sendBtn.disabled = !stop && !hasText;
  setHidden(el.sendBtn.querySelector(".send-icon"), stop);
  setHidden(el.sendBtn.querySelector(".stop-icon"), !stop);
  el.sendBtn.title = stop ? "停止（Esc）" : hasText ? "发送" : "输入内容后发送";
  el.hintText.textContent = stop
    ? "Enter 发送 = 插入当前任务 · Shift + Enter 换行"
    : "Enter 发送 · Shift + Enter 换行";
}

function setStatus(text) {
  el.statusHint.textContent = text || "";
}

/* ------------------------------------------------------------------ */
/* thread rendering                                                    */
/* ------------------------------------------------------------------ */

function scrollNearBottom() {
  const thread = el.thread;
  return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 160;
}

function scrollBottom(force) {
  if (!force && !scrollNearBottom()) return;
  requestAnimationFrame(() => {
    el.thread.scrollTop = el.thread.scrollHeight;
  });
}

function indexToolResults() {
  state.toolResults.clear();
  for (const message of state.messages) {
    if (message.role === "toolResult" && message.toolCallId) {
      state.toolResults.set(message.toolCallId, {
        content: message.content,
        isError: message.isError,
        durationMs: message.durationMs,
        done: true,
      });
    }
  }
}

function thinkHtml(text, live) {
  const value = String(text || "");
  return (
    '<details class="think' + (live ? " is-live" : "") + '"' + (state.openThink ? " open" : "") + ">" +
    '<summary>' + ICON("spark") +
    '<span class="think-label">' + (live ? "正在思考" : "思考过程") + "</span>" +
    '<span class="think-meta">' + fmtTokens(value.length) + " 字</span>" +
    '<span class="chev">' + ICON("right") + "</span>" +
    "</summary><div class=\"think-body\">" + escapeHtml(value) + "</div></details>"
  );
}

function resultOutput(result) {
  if (!result) return "";
  const content = result.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block) return "";
        if (block.type === "text") return block.text || "";
        if (block.type === "image") return "[图片]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function toolMeta(call) {
  const name = String(call.name || "tool");
  const args = call.arguments || {};
  if (name === "bash") return { icon: "terminal", title: "运行命令", arg: String(args.command || "") };
  if (name === "read") return { icon: "file", title: "读取文件", arg: shortenPath(args.path) };
  if (name === "edit") return { icon: "edit", title: "编辑文件", arg: shortenPath(args.path) };
  if (name === "write") return { icon: "file", title: "写入文件", arg: shortenPath(args.path) };
  if (name === "codemode") return { icon: "code", title: "运行脚本", arg: "" };
  if (name.startsWith("mcp__")) return { icon: "globe", title: name.replace(/^mcp__/, ""), arg: "" };
  return { icon: "bolt", title: name, arg: "" };
}

// 卡片一律默认折叠，只留一行简略动态（标题 + 参数 + 状态）；是否展开只由用户点击决定。
function isToolOpen(call) {
  return state.toolOpen.get(call.id) || false;
}

function diffHtml(args) {
  const edits = Array.isArray(args.edits) ? args.edits : [];
  if (!edits.length) return "";
  let lines = 0;
  let html = '<div class="diff">';
  for (const edit of edits) {
    if (lines > 160) {
      html += '<div class="diff-line ctx">…（差异过长，已截断）</div>';
      break;
    }
    const oldLines = String(edit.oldText || "").split("\n");
    const newLines = String(edit.newText || "").split("\n");
    for (const line of oldLines) {
      html += '<div class="diff-line del">- ' + escapeHtml(line) + "</div>";
      lines += 1;
    }
    for (const line of newLines) {
      html += '<div class="diff-line add">+ ' + escapeHtml(line) + "</div>";
      lines += 1;
    }
  }
  return html + "</div>";
}

function toolBodyHtml(call, result) {
  const args = call.arguments || {};
  const output = resultOutput(result);
  const running = !result || result.partial;
  if (call.name === "bash") {
    const body = output || (running ? "正在运行…" : "（没有输出）");
    return (
      '<div class="tool-cmd">' + escapeHtml(args.command || "") + "</div>" +
      '<pre class="term' + (result && result.isError ? " is-error" : "") + '">' + escapeHtml(truncate(body, 14000)) + "</pre>"
    );
  }
  if (call.name === "edit") {
    const diff = diffHtml(args);
    if (diff) return '<div class="diff-file">' + escapeHtml(args.path || "") + "</div>" + diff;
    return '<pre class="term">' + escapeHtml(truncate(output || JSON.stringify(args, null, 2), 14000)) + "</pre>";
  }
  if (call.name === "write") {
    const content = String(args.content || "");
    return (
      '<div class="diff-file">' + escapeHtml(args.path || "") + "</div>" +
      '<pre class="term">' + escapeHtml(truncate(content || output, 14000)) + "</pre>"
    );
  }
  if (call.name === "read") {
    return (
      '<div class="diff-file">' + escapeHtml(args.path || "") + "</div>" +
      '<pre class="term">' + escapeHtml(truncate(output || "读取中…", 14000)) + "</pre>"
    );
  }
  const body = output || (running ? "运行中…" : "（没有输出）");
  return '<pre class="term' + (result && result.isError ? " is-error" : "") + '">' + escapeHtml(truncate(body, 14000)) + "</pre>";
}

function toolCardHtml(call, result) {
  const meta = toolMeta(call);
  const pending = !result || result.partial;
  // 没有结果又已经不在流式里，说明这一条是被中止/中断的，不要再转圈。
  const running = pending && state.streaming;
  const stopped = pending && !state.streaming;
  const error = Boolean(result && result.isError);
  const open = isToolOpen(call, result);
  const duration = result && result.durationMs ? fmtDuration(result.durationMs) : "";
  const status = running
    ? '<span class="spin"></span>'
    : stopped
      ? '<span class="stopped">' + ICON("stop") + "已停止</span>"
      : (error ? '<span class="err">' + ICON("alert") + "</span>" : '<span class="ok">' + ICON("check") + "</span>") +
        (duration ? "<span>" + duration + "</span>" : "");
  return (
    '<div class="tool' + (error ? " is-error" : "") + (open ? " open" : "") + '" data-tool-id="' + escapeHtml(call.id || "") + '">' +
    '<button class="tool-head" type="button" data-tool-toggle>' +
    '<span class="tool-ico">' + ICON(meta.icon) + "</span>" +
    '<span class="tool-title">' + escapeHtml(meta.title) + "</span>" +
    '<span class="tool-arg">' + escapeHtml(meta.arg || "") + "</span>" +
    '<span class="tool-status">' + status + "</span>" +
    '<span class="chev">' + ICON("right") + "</span>" +
    "</button>" +
    '<div class="tool-body"' + (open ? "" : " hidden") + ">" + toolBodyHtml(call, result) + "</div>" +
    "</div>"
  );
}

function contentBlocks(message) {
  if (typeof message.content === "string") return [{ type: "text", text: message.content }];
  return Array.isArray(message.content) ? message.content : [];
}

/* ------------------------- 轮次（turn）模型 ------------------------ */

// 一轮 = 一条用户消息之后、下一条用户消息之前的全部内容。
// 过程组的边界只看「连续」，不看消息：同一轮里跨消息相邻的思考/工具也合成一条。
function buildTurns(messages) {
  const turns = [];
  let current = null;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role === "system") continue;
    if (message.role === "user") {
      current = { index: turns.length, user: { message, index }, parts: [] };
      turns.push(current);
      continue;
    }
    if (!current) {
      current = { index: turns.length, user: null, parts: [] };
      turns.push(current);
    }
    current.parts.push({ message, index });
  }
  return turns;
}

// 工具结果已经并进调用卡片里，只有找不到对应调用的孤儿结果才单独成节点。
function collectToolCallIds(extraBlocks) {
  const ids = new Set();
  const add = (blocks) => {
    for (const block of blocks || []) {
      if (block && block.type === "toolCall" && block.id) ids.add(block.id);
    }
  };
  for (const message of state.messages) {
    if (message && message.role === "assistant") add(contentBlocks(message));
  }
  add(extraBlocks);
  return ids;
}

// 把一轮切成可见单元：正文（text）、过程组（proc）、单独成节点的其他内容（other）。
// 正文永远单独一段，不会被吞进过程组。
// 组键 = 轮序号 + 组序号：消息只会往后追加，所以键在流式、重连、重绘之间都稳定。
function turnSegments(turn, liveBlocks) {
  const segments = [];
  let run = null;
  let ordinal = 0;
  const toolCallIds = collectToolCallIds(liveBlocks);

  const addBlocks = (blocks, live) => {
    for (const block of blocks || []) {
      if (!block) continue;
      if (block.type === "thinking" || block.type === "toolCall") {
        // 空的思考块静态渲染时本来就不显示，跳过；组序号已经先占好，不会错位。
        if (block.type === "thinking" && !live && !String(block.thinking || block.text || "").trim()) continue;
        if (!run) {
          run = { type: "proc", key: "t" + turn.index + ":g" + ordinal, ordinal, members: [] };
          ordinal += 1;
          segments.push(run);
        }
        run.members.push({ block, live });
        continue;
      }
      if (block.type !== "text") continue;
      run = null;
      segments.push({ type: "text", block, live });
    }
  };

  for (const part of turn.parts) {
    const message = part.message;
    if (message.role === "assistant") {
      addBlocks(contentBlocks(message), false);
      continue;
    }
    if (message.role === "toolResult") {
      if (message.toolCallId && toolCallIds.has(message.toolCallId)) continue;
      run = null;
      segments.push({ type: "other", message, index: part.index });
      continue;
    }
    if (message.role === "custom" || message.role === "developer") {
      run = null;
      segments.push({ type: "other", message, index: part.index });
    }
  }
  if (liveBlocks && liveBlocks.length) addBlocks(liveBlocks, true);
  return segments.filter((segment) => segment.type !== "proc" || segment.members.length);
}

// 汇总只讲真实数据：步骤总数、真实完成进度、真实失败数；不编比例。
function procStats(members) {
  let tools = 0;
  let done = 0;
  let failed = 0;
  let aborted = 0;
  let running = 0;
  for (const member of members) {
    if (member.block.type !== "toolCall") continue;
    const id = member.block.id;
    tools += 1;
    const result = state.toolResults.get(id) || state.toolLive.get(id);
    if (!result || result.partial) {
      // 流式中就是真的在跑；已经不在流式还没结果，那就是被中止的。
      if (state.streaming) running += 1;
      else aborted += 1;
      continue;
    }
    if (result.isError) failed += 1;
    done += 1;
  }
  // 最后一项还是流式中的思考块，说明它正在写，不能当已完成。
  const tail = members[members.length - 1];
  const thinkingLive = Boolean(tail && tail.live && tail.block.type === "thinking");

  let icon;
  let stateText;
  let tone;
  if (failed) {
    icon = running || thinkingLive ? '<span class="spin"></span>' : ICON("alert");
    stateText = failed + " 个失败" + (running && tools ? " · " + done + "/" + tools : "");
    tone = "err";
  } else if (running || thinkingLive) {
    icon = '<span class="spin"></span>';
    stateText = tools ? "进行中 " + done + "/" + tools : "思考中";
    tone = "run";
  } else if (aborted) {
    icon = ICON("stop");
    stateText = "已停止";
    tone = "stop";
  } else {
    icon = ICON("check");
    stateText = "已完成";
    tone = "ok";
  }
  return { title: members.length + " 个步骤", stateText, icon, tone };
}

// 流式里的工具调用只有 argsJson，得先解析成 arguments 才能渲染参数。
function procMemberHtml(member) {
  const block = member.block;
  if (member.live && block.type === "toolCall") {
    const call = { id: block.id, name: block.name, arguments: parseArgs(block) };
    return toolCardHtml(call, state.toolResults.get(block.id) || state.toolLive.get(block.id));
  }
  return blockHtml(block, member.live);
}

// 折叠时只渲染组头，展开时才渲染里面的卡片：长任务不会因为重绘而变卡。
function procHtml(segment) {
  const open = state.procOpen.get(segment.key) || false;
  const stats = procStats(segment.members);
  const body = open ? segment.members.map(procMemberHtml).join("") : "";
  return (
    '<div class="proc' + (open ? " open" : "") + '" data-proc-key="' + escapeHtml(segment.key) + '">' +
    '<button class="proc-head" type="button" data-proc-toggle aria-expanded="' + (open ? "true" : "false") + '">' +
    '<span class="proc-ico ' + stats.tone + '">' + stats.icon + "</span>" +
    '<span class="proc-title">' + escapeHtml(stats.title) + "</span>" +
    '<span class="proc-state ' + stats.tone + '">' + escapeHtml(stats.stateText) + "</span>" +
    '<span class="chev">' + ICON("right") + "</span>" +
    "</button>" +
    '<div class="proc-body"' + (open ? "" : " hidden") + ">" + body + "</div>" +
    "</div>"
  );
}

function segmentsHtml(segments, options = {}) {
  let html = "";
  segments.forEach((segment, position) => {
    if (segment.type === "proc") {
      html += procHtml(segment);
      return;
    }
    if (segment.type !== "text") return;
    const caret = Boolean(options.caret) && position === segments.length - 1;
    html += blockHtml(segment.block, segment.live, caret);
  });
  return html;
}

function otherHtml(segment) {
  const message = segment.message;
  if (message.role === "toolResult") {
    const call = {
      id: message.toolCallId || "orphan-" + segment.index,
      name: message.toolName || "tool",
      arguments: {},
    };
    return toolCardHtml(call, { content: message.content, isError: message.isError, durationMs: message.durationMs });
  }
  return '<div class="markdown">' + renderMarkdown(textOf(message)) + "</div>";
}

// 由组键反查这一段内容（展开时要按需填充卡片）。
function findProcSegment(key) {
  const match = /^t(\d+):g(\d+)$/.exec(String(key || ""));
  if (!match) return null;
  const turns = buildTurns(state.messages);
  const index = Number(match[1]);
  const turn = turns[index];
  if (!turn) return null;
  const liveBlocks = state.live && index === turns.length - 1 ? state.live.blocks : null;
  const segments = turnSegments(turn, liveBlocks);
  return segments.find((segment) => segment.type === "proc" && segment.ordinal === Number(match[2])) || null;
}

function blockHtml(block, live, caret) {
  if (!block) return "";
  if (block.type === "text") {
    if (!live && !String(block.text || "").trim()) return "";
    return '<div class="markdown' + (caret ? " is-streaming" : "") + '">' + renderMarkdown(block.text || "") + "</div>";
  }
  if (block.type === "thinking") {
    const text = block.thinking || block.text || "";
    if (!live && !String(text).trim()) return "";
    return thinkHtml(text, live);
  }
  if (block.type === "toolCall") {
    const result = state.toolResults.get(block.id) || state.toolLive.get(block.id);
    return toolCardHtml(block, result);
  }
  return "";
}

/* ------------------------------------------------------------------ */
/* fork：编辑 / 重新生成（阶段 B）                                      */
/* ------------------------------------------------------------------ */

// UI 只显示当前分支的用户消息，get_fork_messages 也是当前分支：
// 数量一致时按顺序一一对应，不一致时按文字前缀匹配，匹配不到就没有编辑按钮。
function forkEntryMap() {
  const map = new Map();
  const users = state.messages.filter((message) => message && message.role === "user");
  const forks = state.forkMessages || [];
  if (!forks.length) return map;
  if (users.length === forks.length) {
    users.forEach((message, i) => map.set(message, forks[i].entryId));
    return map;
  }
  for (const message of users) {
    const text = textOf(message).trim();
    if (!text) continue;
    const hit = forks.find((fork) => {
      const target = String(fork.text || "").trim();
      return target && (target.startsWith(text.slice(0, 24)) || text.startsWith(target.slice(0, 24)));
    });
    if (hit) map.set(message, hit.entryId);
  }
  return map;
}

function forkButton(act, entryId, label, hardBlocked, title) {
  const disabled = hardBlocked || state.streaming || state.forkBusy || !entryId;
  return (
    '<button class="action" type="button" data-fork-action' +
    (hardBlocked ? " data-fork-blocked" : "") +
    ' data-act="' + act + '"' +
    ' data-entry-id="' + escapeHtml(entryId || "") + '"' +
    (disabled ? " disabled" : "") +
    ' title="' + escapeHtml(title) + '">' + label + "</button>"
  );
}

function setForkButtonsBusy(busy) {
  for (const button of document.querySelectorAll("[data-fork-action]")) {
    const hardBlocked = button.hasAttribute("data-fork-blocked");
    button.disabled = hardBlocked || busy || state.streaming || !button.getAttribute("data-entry-id");
  }
}

function userNode(message, index, ctx = {}) {
  const node = document.createElement("div");
  node.className = "msg user";
  if (typeof index === "number") node.dataset.userIndex = String(index);
  const images = imageBlocks(message);
  const text = textOf(message);
  let html = '<div class="bubble">';
  if (images.length) {
    html += '<div class="images">';
    for (const image of images) {
      html += '<img src="data:' + escapeHtml(image.mimeType || "image/png") + ";base64," + escapeHtml(image.data || "") + '" alt="图片">';
    }
    html += "</div>";
  }
  if (text) html += escapeHtml(text);
  html += "</div>";
  node.innerHTML = html;
  const foot = document.createElement("div");
  foot.className = "msg-foot";
  let footHtml = '<button class="action" type="button" data-act="copy-user">' + ICON("copy") + "复制</button>";
  if (ctx.forkEntryId) {
    const hardBlocked = Boolean(ctx.hasImages);
    const title = hardBlocked
      ? "带图片的消息不能编辑或重新生成（分叉后图片会丢）"
      : "从这条消息之前重新开始";
    footHtml += forkButton("edit-user", ctx.forkEntryId, "编辑", hardBlocked, title);
    if (ctx.isLastUser) footHtml += forkButton("regen-user", ctx.forkEntryId, "重新生成", hardBlocked, title);
  }
  foot.innerHTML = footHtml;
  node.appendChild(foot);
  return node;
}

// 首个可见段是过程组时，头像要跟着下移对齐组首行（见 styles.css 的 lead-* 规则）。
function leadAlignClass(segments) {
  const first = (segments || [])[0];
  if (!first) return "";
  return first.type === "proc" ? "lead-proc" : "";
}

function lastUserAndAssistant() {
  let lastUser = null;
  let lastAssistant = null;
  for (const message of state.messages) {
    if (!message) continue;
    if (message.role === "user") lastUser = message;
    if (message.role === "assistant") lastAssistant = message;
  }
  return { lastUser, lastAssistant };
}

function turnContext(turn, options) {
  const opts = options || {};
  const forkMap = forkEntryMap();
  const { lastUser, lastAssistant } = lastUserAndAssistant();
  const userMessage = turn.user ? turn.user.message : null;
  const ownsLastAssistant = Boolean(lastAssistant) && turn.parts.some((part) => part.message === lastAssistant);
  return {
    user: {
      forkEntryId: userMessage ? forkMap.get(userMessage) || null : null,
      hasImages: userMessage ? imageBlocks(userMessage).length > 0 : false,
      isLastUser: Boolean(userMessage) && userMessage === lastUser,
    },
    regenEntryId: ownsLastAssistant && userMessage ? forkMap.get(userMessage) || null : null,
    liveBlocks: opts.liveBlocks || null,
    streaming: Boolean(opts.streaming),
    refresh: Boolean(opts.refresh),
  };
}

// 一轮渲染成若干节点：用户气泡 + 助手内容。
// 过程组跨消息合并，正文独立成段；孤儿工具结果 / 自定义消息单独成节点。
function turnNodes(turn, ctx) {
  const nodes = [];
  if (turn.user) {
    const node = userNode(turn.user.message, turn.user.index, ctx.user);
    node.setAttribute("data-turn", String(turn.index));
    // 重绘出来的节点不播入场动画，否则每帧淡入一次就是闪。
    if (ctx.refresh) node.classList.add("refresh");
    nodes.push(node);
  }

  const segments = turnSegments(turn, ctx.liveBlocks);
  const chunks = [];
  let buffer = [];
  for (const segment of segments) {
    if (segment.type === "other") {
      if (buffer.length) chunks.push({ segments: buffer });
      buffer = [];
      chunks.push({ other: segment });
      continue;
    }
    buffer.push(segment);
  }
  if (buffer.length) chunks.push({ segments: buffer });

  // 脚注挂在最后一个「有正文或过程」的块上，不挂在孤儿卡片上。
  let footAt = -1;
  chunks.forEach((chunk, position) => {
    if (chunk.segments) footAt = position;
  });
  const hasText = segments.some((segment) => segment.type === "text" && String(segment.block.text || "").trim());

  chunks.forEach((chunk, position) => {
    const node = document.createElement("div");
    node.className = "msg assistant" + (ctx.refresh ? " refresh" : "");
    node.setAttribute("data-turn", String(turn.index));
    let html = '<div class="avatar"><img src="logo.svg" alt=""></div><div class="body">';
    if (chunk.other) {
      node.classList.add("lead-tool");
      html += otherHtml(chunk.other);
    } else {
      const align = leadAlignClass(chunk.segments);
      if (align) node.classList.add(align);
      html += segmentsHtml(chunk.segments, { caret: ctx.streaming && position === chunks.length - 1 });
    }
    if (position === footAt) {
      // 纯过程的一轮没有正文，就不放一个点了没反应的「复制」。
      let footHtml = hasText ? '<button class="action" type="button" data-act="copy-bot">' + ICON("copy") + "复制</button>" : "";
      if (ctx.regenEntryId) {
        footHtml += forkButton("regen-bot", ctx.regenEntryId, "重新生成", false, "从这条回答对应的消息重新开始");
      }
      if (footHtml) html += '<div class="msg-foot">' + footHtml + "</div>";
    }
    html += "</div>";
    node.innerHTML = html;
    nodes.push(node);
  });
  return nodes;
}

// 重绘当前轮：流式逐帧、工具状态变化、消息结束都走这里。
// 过程组折叠时只渲染组头，所以重绘成本只跟可见内容有关。
function captureFocus() {
  const active = document.activeElement;
  if (!active || !el.messages.contains(active)) return null;
  const group = active.closest("[data-proc-key]");
  if (group) return '[data-proc-key="' + group.getAttribute("data-proc-key") + '"] [data-proc-toggle]';
  const tool = active.closest("[data-tool-id]");
  if (tool) return '[data-tool-id="' + tool.getAttribute("data-tool-id") + '"] [data-tool-toggle]';
  return null;
}

function restoreFocus(selector) {
  if (!selector) return;
  const target = el.messages.querySelector(selector);
  if (target) target.focus();
}

function refreshCurrentTurn(options) {
  const turns = buildTurns(state.messages);
  const turn = turns[turns.length - 1] || (state.live ? { index: 0, user: null, parts: [] } : null);
  if (!turn) return;
  const focus = captureFocus();
  const nodes = turnNodes(turn, turnContext(turn, Object.assign({}, options, { refresh: true })));

  const old = state.lastTurnNodes || [];
  const oldFirst = old[0];
  const sameTurn = Boolean(oldFirst) && oldFirst.getAttribute("data-turn") === String(turn.index);

  // 用户气泡是静止内容，重绘时直接复用：重建它会让图片重新解码，也会把入场动画再播一遍。
  let keepUser = null;
  if (sameTurn && turn.user && oldFirst.classList.contains("user")) {
    keepUser = oldFirst;
    nodes[0] = keepUser;
  }

  if (sameTurn && oldFirst.parentNode) {
    const lastOld = old[old.length - 1];
    const after = lastOld ? lastOld.nextSibling : null;
    for (const node of old) {
      if (node !== keepUser) node.remove();
    }
    const ref = after && after.parentNode ? after : null;
    for (const node of nodes) {
      if (node === keepUser) continue;
      if (ref) ref.parentNode.insertBefore(node, ref);
      else el.messages.appendChild(node);
    }
  } else {
    for (const node of nodes) el.messages.appendChild(node);
  }
  state.lastTurnNodes = nodes;
  el.empty.hidden = state.messages.length > 0 || state.streaming;
  restoreFocus(focus);
}

// 胶囊只讲「文件更改情况」：只统计 edit / write 的 args.path。
// bash / codemode 之类间接写文件拿不到路径，这一轮没记录到文件就不显示胶囊。
function buildTurnSummary() {
  const files = [...state.turnFiles.keys()];
  return files.length ? { files } : null;
}

/** 相对工作区显示文件所在目录；不在工作区里就退回原目录。 */
function turnFileDir(file) {
  const normalized = String(file || "").replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const dir = slash >= 0 ? normalized.slice(0, slash) : "";
  const ws = String(state.workspace || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (ws && (dir === ws || dir.startsWith(ws + "/"))) {
    const rel = dir.slice(ws.length).replace(/^\/+/, "");
    return rel || basename(ws) || ".";
  }
  return dir;
}

function renderTurnSummary() {
  const summary = state.turnSummary;
  if (!summary || !summary.files.length) return;
  const files = summary.files;

  const node = document.createElement("div");
  node.className = "turn-summary";

  // 默认收起的胶囊：只显示文件数，不显示增删行数、不显示命令数。
  const label = files.length + " 个文件已更改";
  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = "turn-pill" + (state.turnSummaryOpen ? " open" : "");
  pill.setAttribute("aria-expanded", String(state.turnSummaryOpen));
  pill.innerHTML =
    "<span>" + escapeHtml(label) + "</span>" +
    '<span class="turn-chev">' + ICON("down") + "</span>";

  // 点开后的清单：文件名 + 所在目录，逐文件列全。
  const card = document.createElement("div");
  card.className = "turn-card";
  card.hidden = !state.turnSummaryOpen;
  const list = document.createElement("div");
  list.className = "turn-list";
  for (const file of files) {
    const row = document.createElement("div");
    row.className = "turn-file";
    row.innerHTML =
      '<span class="turn-file-name">' + escapeHtml(basename(file) || file) + "</span>" +
      '<span class="turn-file-dir">' + escapeHtml(turnFileDir(file)) + "</span>";
    list.appendChild(row);
  }
  card.appendChild(list);

  pill.addEventListener("click", () => {
    state.turnSummaryOpen = !state.turnSummaryOpen;
    card.hidden = !state.turnSummaryOpen;
    pill.classList.toggle("open", state.turnSummaryOpen);
    pill.setAttribute("aria-expanded", String(state.turnSummaryOpen));
  });

  node.appendChild(pill);
  node.appendChild(card);
  el.messages.appendChild(node);
}

function renderThread() {
  state.optimisticEl = null;
  indexToolResults();
  el.messages.innerHTML = "";
  let lastNodes = [];
  const turns = buildTurns(state.messages);
  turns.forEach((turn, position) => {
    const liveBlocks = state.live && position === turns.length - 1 ? state.live.blocks : null;
    const nodes = turnNodes(turn, turnContext(turn, { liveBlocks, streaming: Boolean(liveBlocks) }));
    for (const node of nodes) el.messages.appendChild(node);
    lastNodes = nodes;
  });
  state.lastTurnNodes = lastNodes;
  el.empty.hidden = state.messages.length > 0 || state.streaming;
  // 摘要不写进 state.messages，每次重绘都重新插入一次，天然避免重复。
  renderTurnSummary();
  renderRail();
  scrollBottom(true);
}

function updateRailVisibility() {
  el.rail.classList.toggle("tight", el.thread.clientWidth < 860);
}

function renderRail() {
  const users = [];
  state.messages.forEach((message, index) => {
    if (message.role === "user") users.push({ index });
  });
  if (!users.length) {
    el.rail.hidden = true;
    el.railTicks.innerHTML = "";
    el.railTip.hidden = true;
    return;
  }
  el.rail.hidden = false;
  el.railTip.hidden = true;
  state.railActive = null;
  el.railTicks.innerHTML = users
    .map(
      ({ index }) =>
        '<button class="rail-tick" type="button" data-index="' + index + '" aria-label="跳转到这条消息"></button>',
    )
    .join("");
  requestAnimationFrame(() => {
    const count = users.length;
    const height = el.railTicks.clientHeight || 0;
    const gap = count > 1 ? Math.max(3, Math.min(10, (height - count * 2) / (count - 1))) : 8;
    el.railTicks.style.gap = Math.round(gap) + "px";
    updateRailVisibility();
  });
}

function showRailTip(tick, message) {
  const raw = textOf(message || {}).replace(/\s+/g, " ").trim();
  el.railTip.textContent = raw ? (raw.length > 120 ? raw.slice(0, 120) + "…" : raw) : "（图片消息）";
  el.railTip.hidden = false;
  const tickRect = tick.getBoundingClientRect();
  const railRect = el.rail.getBoundingClientRect();
  const maxTop = Math.max(8, railRect.height - el.railTip.offsetHeight - 8);
  const centered = tickRect.top - railRect.top + tickRect.height / 2 - el.railTip.offsetHeight / 2;
  el.railTip.style.top = Math.round(Math.min(maxTop, Math.max(8, centered))) + "px";
}

function scrollToUserMessage(index) {
  const node = el.messages.querySelector('[data-user-index="' + index + '"]');
  if (!node) return;
  const threadRect = el.thread.getBoundingClientRect();
  const nodeRect = node.getBoundingClientRect();
  el.thread.scrollTo({
    top: el.thread.scrollTop + nodeRect.top - threadRect.top - 18,
    behavior: "smooth",
  });
}

function resetRail() {
  state.railActive = null;
  for (const item of el.railTicks.children) {
    item.style.width = "";
    item.classList.remove("hot");
  }
  el.railTip.hidden = true;
}

function activateRailTick(tick) {
  state.railActive = tick;
  const ticks = [...el.railTicks.children];
  const hovered = ticks.indexOf(tick);
  ticks.forEach((item, index) => {
    const distance = Math.abs(index - hovered);
    item.style.width = (distance === 0 ? 26 : distance === 1 ? 20 : distance === 2 ? 15 : 10) + "px";
    item.classList.toggle("hot", distance === 0);
  });
  showRailTip(tick, state.messages[Number(tick.dataset.index)]);
}

function bindRail() {
  // 整条竖条都能命中：取离鼠标最近的那条，不用精准点到 2px 的线
  el.railTicks.addEventListener("pointermove", (event) => {
    const ticks = [...el.railTicks.children];
    if (!ticks.length) return;
    const y = event.clientY;
    let best = null;
    let bestDistance = Infinity;
    for (const tick of ticks) {
      const rect = tick.getBoundingClientRect();
      const distance = Math.abs(y - (rect.top + rect.height / 2));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = tick;
      }
    }
    if (!best || bestDistance > 18) {
      resetRail();
      return;
    }
    if (best !== state.railActive) activateRailTick(best);
  });
  el.railTicks.addEventListener("pointerleave", resetRail);
  el.railTicks.addEventListener("click", (event) => {
    event.preventDefault();
    const tick = state.railActive || event.target.closest(".rail-tick");
    if (tick) scrollToUserMessage(Number(tick.dataset.index));
  });
}

/* ------------------------------------------------------------------ */
/* live streaming                                                      */
/* ------------------------------------------------------------------ */

let liveFrame = 0;

function parseArgs(block) {
  if (block.arguments && typeof block.arguments === "object") return block.arguments;
  if (block.argsJson) {
    const parsed = parseJson(block.argsJson);
    if (parsed && typeof parsed === "object") return parsed;
  }
  return {};
}

function renderLiveNow() {
  if (!state.live) return;
  const near = scrollNearBottom();
  refreshCurrentTurn({ liveBlocks: state.live.blocks, streaming: true });
  if (near) scrollBottom(true);
}

function scheduleLive() {
  if (liveFrame) return;
  liveFrame = requestAnimationFrame(() => {
    liveFrame = 0;
    renderLiveNow();
  });
}

function dropStream() {
  state.live = null;
}

function updateWorking() {
  const existing = el.messages.querySelector(".working");
  if (!state.streaming) {
    if (existing) existing.remove();
    return;
  }
  if (state.live && state.live.blocks.some((block) => block && (block.text || block.thinking || block.toolCall))) {
    if (existing) existing.remove();
    return;
  }
  const label = state.activity || "pi 正在工作";
  if (existing) {
    existing.querySelector(".working-label").textContent = label;
    return;
  }
  const node = document.createElement("div");
  node.className = "working";
  node.innerHTML = '<span class="dots"><i></i><i></i><i></i></span><span class="working-label">' + escapeHtml(label) + "</span>";
  el.messages.appendChild(node);
  scrollBottom();
}

function addNotice(text) {
  const node = document.createElement("div");
  node.className = "notice";
  node.innerHTML = ICON("refresh") + "<span>" + escapeHtml(text) + "</span>";
  el.messages.appendChild(node);
  scrollBottom();
  return node;
}

/* ------------------------------------------------------------------ */
/* session lifecycle                                                   */
/* ------------------------------------------------------------------ */

function applySnapshot(snapshot) {
  const switched = state.key !== snapshot.key;
  state.key = snapshot.key;
  state.file = snapshot.sessionFile || null;
  state.workspace = snapshot.workspace || state.workspace;
  state.messages = (snapshot.messages || []).filter((message) => message.role !== "system");
  state.forkMessages = snapshot.forkMessages || [];
  state.models = snapshot.models || [];
  state.commands = snapshot.commands || [];
  state.thinkingLevels = snapshot.thinkingLevels || ["off"];
  state.stats = snapshot.stats || {};
  state.model = snapshot.state && snapshot.state.model ? snapshot.state.model : null;
  state.thinkingLevel = (snapshot.state && snapshot.state.thinkingLevel) || "off";
  state.sessionName = (snapshot.state && snapshot.state.sessionName) || "";
  state.streaming = Boolean(snapshot.state && snapshot.state.isStreaming);
  if (!state.streaming) state.live = null;
  state.queue = 0;
  state.toolResults.clear();
  state.toolLive.clear();
  state.toolOpen.clear();
  state.procOpen.clear();
  if (switched) {
    state.attachments = [];
    renderAttachments();
  }
  state.sessions = snapshot.sessions || state.sessions;

  if (state.file) {
    try {
      localStorage.setItem("piwebui.last", JSON.stringify({ file: state.file }));
    } catch {
      /* ignore */
    }
  }

  updateWorkspace();
  renderThread();
  renderSessions();
  updateChips();
  updateStats();
  updateSendState();
  updateWorking();
  setStatus("已连接");

  for (const request of snapshot.pendingUi || []) showUiDialog(request);
}

async function openSession(file) {
  const snapshot = await api("/api/session/open", { file });
  applySnapshot(snapshot);
  connectStream();
  markSeen(true);
}

async function newSession() {
  if (state.needsWorkspace) {
    openWorkspacePicker();
    return;
  }
  const snapshot = await api("/api/session/new", {});
  applySnapshot(snapshot);
  connectStream();
  markSeen(true);
  el.input.focus();
  await applySavedDefaults();
}

function connectStream() {
  if (state.es) {
    state.es.close();
    state.es = null;
  }
  state.lastSeq = 0;
  let helloed = false;
  // hello 到达之前的事件都是断线重连的历史回放，不给它们补发通知。
  state.replaying = true;
  const source = new EventSource("/api/events?key=" + encodeURIComponent(state.key));
  state.es = source;
  source.addEventListener("hello", (event) => {
    const data = parseJson(event.data || "{}") || {};
    state.lastSeq = data.seq || 0;
    state.replaying = false;
    if (helloed) resync();
    helloed = true;
    setStatus("已连接");
  });
  source.addEventListener("pi", (event) => {
    const record = parseJson(event.data);
    if (!record) return;
    const seq = Number(event.lastEventId || 0);
    if (seq) state.lastSeq = Math.max(state.lastSeq, seq);
    handleEvent(record);
  });
  source.onerror = () => {
    state.replaying = true;
    setStatus("连接中断，正在重连…");
  };
}

function connectSessionEvents() {
  if (state.statusEs) state.statusEs.close();
  const source = new EventSource("/api/session-events");
  state.statusEs = source;
  source.addEventListener("status", (event) => {
    const data = parseJson(event.data || "{}") || {};
    state.runtime = new Map(Object.entries(data.statuses || {}));
    renderSessions();
    scheduleSessionRefresh();
  });
}

function scheduleSessionRefresh() {
  if (state.statusRefreshTimer) return;
  state.statusRefreshTimer = setTimeout(() => {
    state.statusRefreshTimer = 0;
    refreshSessions();
  }, 600);
}

function isViewing() {
  return document.visibilityState === "visible" && document.hasFocus();
}

async function markSeen(force = false) {
  if (!state.key) return;
  if (!force && !isViewing()) return;
  const id = state.key.replace(/^s:/, "");
  try {
    await api("/api/session/seen", { key: state.key });
  } catch {
    return;
  }
  const runtime = state.runtime.get(id);
  if (runtime) {
    runtime.unread = false;
    runtime.errored = false;
    renderSessions();
  }
}

async function resync() {
  if (!state.key) return;
  try {
    const snapshot = await api("/api/session/snapshot", { key: state.key });
    applySnapshot(snapshot);
  } catch {
    /* ignore */
  }
}

// 每轮结束后取最新的可编辑消息（新用户消息会有新 entryId），再重绘按钮。
async function refreshForkMessages() {
  if (!state.key) return;
  try {
    const data = await api("/api/fork-messages", { key: state.key });
    state.forkMessages = data.forkMessages || [];
  } catch {
    /* 用旧的 forkMessages 也重绘，保证摘要/按钮状态一致 */
  }
  renderThread();
}

async function handleForkAction(act, button) {
  if (state.forkBusy || !state.key) return;
  if (state.streaming) {
    toast("正在回复，等这一轮结束再操作", "error");
    return;
  }
  const entryId = button.getAttribute("data-entry-id");
  if (!entryId) {
    toast("这条消息不能编辑", "error");
    return;
  }
  const regen = act !== "edit-user";
  state.forkBusy = true;
  setForkButtonsBusy(true);
  try {
    const data = await api("/api/fork", { key: state.key, entryId });
    const previousKey = state.key;
    // 先应用快照再发消息，避免拿旧 key 发。
    applySnapshot(data.snapshot);
    if (data.snapshot.key !== previousKey) connectStream();
    el.input.value = data.text || "";
    autosize();
    updateSendState();
    if (regen) {
      toast("已从这条消息重新开始");
      await sendMessage();
    } else {
      el.input.focus();
      toast("原文已放回输入框，改完发送即可");
    }
  } catch (error) {
    toast("操作失败：" + error.message, "error");
  } finally {
    state.forkBusy = false;
    setForkButtonsBusy(false);
  }
}

/* ---------- 完成通知（默认关） ---------- */

const NOTIFY_KEY = "piwebui.notify";

function readNotifyPref() {
  try {
    return localStorage.getItem(NOTIFY_KEY) === "1";
  } catch {
    return false;
  }
}

function writeNotifyPref(on) {
  try {
    localStorage.setItem(NOTIFY_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

async function toggleNotify() {
  if (readNotifyPref()) {
    writeNotifyPref(false);
    toast("已关闭完成通知");
    return;
  }
  if (!("Notification" in window)) {
    toast("当前浏览器不支持系统通知", "error");
    return;
  }
  // 权限请求必须发生在用户点击的手势里；已经是 denied 就不再反复请求。
  let permission = Notification.permission;
  if (permission === "default") {
    try {
      permission = await Notification.requestPermission();
    } catch {
      permission = "denied";
    }
  }
  if (permission !== "granted") {
    toast("通知权限被拒绝，请到浏览器设置里允许", "error");
    return;
  }
  writeNotifyPref(true);
  toast("已开启完成通知");
}

async function maybeNotifyDone() {
  if (!readNotifyPref()) return;
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const title = "pi 已完成";
  const body = (state.sessionName || sessionTitle()) + " · 本轮结束";
  const tag = "pi-" + state.key;
  try {
    // 阶段 D 注册 SW 后优先走 SW。这里用 getRegistration 而不是 ready，
    // 避免尚未注册 SW 时永远等待；SW 版的 notificationclick / clients.matchAll
    // 聚焦窗口由阶段 D 的 sw.js 实现。
    const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (reg && typeof reg.showNotification === "function") {
      await reg.showNotification(title, { body, tag });
      return;
    }
  } catch {
    /* 退回普通通知 */
  }
  try {
    const note = new Notification(title, { body, tag });
    note.onclick = () => {
      window.focus();
      note.close();
    };
  } catch {
    /* ignore */
  }
}

/* ---------- PWA：Service Worker + 安装到桌面 ---------- */

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

function registerServiceWorker() {
  // 安全上下文才注册：https / 127.0.0.1 / localhost。
  // 局域网普通 http 注册必然失败，file:// 也不注册。
  if (!("serviceWorker" in navigator)) return;
  const secure =
    location.protocol === "https:" ||
    location.hostname === "127.0.0.1" ||
    location.hostname === "localhost";
  if (!secure) return;
  // 只在这里注册一次；失败不影响页面其他功能。
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

function setupInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (event) => {
    // 先接管，避免浏览器自己弹一条提示；改由「更多」菜单触发。
    event.preventDefault();
    state.installPrompt = event;
  });
  window.addEventListener("appinstalled", () => {
    state.installPrompt = null;
    toast("已安装到桌面");
  });
}

async function promptInstall() {
  const prompt = state.installPrompt;
  if (!prompt) return;
  state.installPrompt = null;
  try {
    prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice && choice.outcome === "accepted") toast("正在安装…");
  } catch {
    toast("安装失败", "error");
  }
}

async function refreshStats() {
  if (!state.key) return;
  try {
    state.stats = await api("/api/stats", { key: state.key });
    updateStats();
  } catch {
    /* ignore */
  }
}

async function refreshSessions() {
  try {
    const data = await api("/api/sessions");
    state.sessions = data.sessions || [];
    renderSessions();
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* pi event stream                                                     */
/* ------------------------------------------------------------------ */

function handleEvent(event) {
  switch (event.type) {
    case "agent_start":
      state.streaming = true;
      state.activity = "pi 正在工作";
      // 每轮重新统计「本轮改了什么」。
      state.turnFiles = new Map();
      state.turnSummary = null;
      state.turnSummaryOpen = false;
      updateSendState();
      updateWorking();
      renderSessions();
      updateHeader();
      // 本轮开始后，已渲染的编辑/重生成按钮要立刻置灰（点击处也有 streaming 兜底）。
      setForkButtonsBusy(false);
      break;

    case "message_start":
      if (event.message && event.message.role === "assistant") {
        state.live = { blocks: [] };
      }
      break;

    case "message_update":
      applyLiveUpdate(event.assistantMessageEvent);
      break;

    case "message_end":
      finishMessage(event.message);
      break;

    case "tool_execution_start": {
      state.toolLive.set(event.toolCallId, { partial: true, content: [], toolName: event.toolName, startedAt: Date.now() });
      // 只认 edit / write 的 args.path（见 buildTurnSummary 的注释）。
      const args = event.args || {};
      if ((event.toolName === "edit" || event.toolName === "write") && args.path) {
        state.turnFiles.set(args.path, event.toolName);
      }
      state.activity = "运行 " + event.toolName + "…";
      updateToolDom();
      updateWorking();
      break;
    }

    case "tool_execution_update":
      state.toolLive.set(event.toolCallId, {
        partial: true,
        content: event.partialResult && event.partialResult.content ? event.partialResult.content : [],
      });
      updateToolDom();
      break;

    case "tool_execution_end":
      state.toolLive.delete(event.toolCallId);
      state.toolResults.set(event.toolCallId, {
        content: event.result && event.result.content ? event.result.content : [],
        isError: event.isError,
        durationMs: event.durationMs,
        done: true,
      });
      state.activity = "pi 正在工作";
      updateToolDom();
      updateWorking();
      break;

    case "agent_settled": {
      state.streaming = false;
      state.activity = "";
      state.queue = 0;
      el.queuePill.hidden = true;
      dropStream();
      updateSendState();
      updateWorking();
      updateHeader();
      collapseTools();
      // 工具卡片收起之后才算本轮摘要；历史回放和主动停止都不补通知。
      const replayed = state.replaying;
      const aborted = Boolean(event.aborted);
      state.turnSummary = buildTurnSummary();
      renderSessions();
      markSeen();
      refreshStats();
      refreshSessions();
      // 新一轮的用户消息会产生新 entryId；重绘时一并插入摘要。
      refreshForkMessages();
      if (!replayed && !aborted) maybeNotifyDone();
      break;
    }

    case "queue_update": {
      const steering = Array.isArray(event.steering) ? event.steering.length : 0;
      const follow = Array.isArray(event.followUp) ? event.followUp.length : 0;
      state.queue = steering + follow;
      el.queuePill.hidden = state.queue === 0;
      el.queueCount.textContent = String(state.queue);
      break;
    }

    case "compaction_start":
      addNotice(event.reason === "manual" ? "正在压缩上下文…" : "上下文接近上限，正在自动压缩…");
      break;

    case "compaction_end":
      addNotice(event.aborted ? "压缩已取消" : event.errorMessage ? "压缩失败：" + event.errorMessage : "上下文已压缩");
      break;

    case "auto_retry_start":
      addNotice("请求失败，正在重试（" + event.attempt + "/" + event.maxAttempts + "）");
      break;

    case "auto_retry_end":
      if (!event.success) addNotice("重试失败：" + (event.finalError || "未知错误"));
      break;

    case "session_info_changed":
      state.sessionName = event.name || "";
      updateHeader();
      refreshSessions();
      break;

    case "thinking_level_changed":
      state.thinkingLevel = event.level;
      updateChips();
      break;

    case "extension_ui_request":
      handleUiRequest(event);
      break;

    case "bridge_exit":
      state.streaming = false;
      dropStream();
      refreshCurrentTurn();
      updateSendState();
      updateWorking();
      updateHeader();
      // 删除会话、服务端主动回收等正常关闭不弹错误
      if (event.intentional) break;
      setStatus("pi 进程已退出");
      toast("pi 进程已退出，重新打开会话即可恢复", "error");
      break;

    default:
      break;
  }
}

function applyLiveUpdate(update) {
  if (!state.live || !update) return;
  const blocks = state.live.blocks;
  const index = typeof update.contentIndex === "number" ? update.contentIndex : 0;

  switch (update.type) {
    case "text_start":
      blocks[index] = { type: "text", text: "" };
      break;
    case "text_delta":
      if (!blocks[index]) blocks[index] = { type: "text", text: "" };
      blocks[index].text = (blocks[index].text || "") + (update.delta || "");
      break;
    case "text_end":
      if (!blocks[index]) blocks[index] = { type: "text", text: "" };
      blocks[index].text = update.content || blocks[index].text || "";
      break;
    case "thinking_start":
      blocks[index] = { type: "thinking", thinking: "" };
      break;
    case "thinking_delta":
      if (!blocks[index]) blocks[index] = { type: "thinking", thinking: "" };
      blocks[index].thinking = (blocks[index].thinking || "") + (update.delta || "");
      break;
    case "thinking_end":
      if (!blocks[index]) blocks[index] = { type: "thinking", thinking: "" };
      blocks[index].thinking = update.content || blocks[index].thinking || "";
      break;
    case "toolcall_start":
      blocks[index] = { type: "toolCall", id: update.id, name: update.toolName, argsJson: "", arguments: null };
      state.activity = "调用 " + update.toolName + "…";
      break;
    case "toolcall_delta":
      if (blocks[index]) blocks[index].argsJson = (blocks[index].argsJson || "") + (update.delta || "");
      break;
    case "toolcall_end":
      if (blocks[index] && update.toolCall) {
        blocks[index].id = update.toolCall.id || blocks[index].id;
        blocks[index].name = update.toolCall.name || blocks[index].name;
        blocks[index].arguments = update.toolCall.arguments || {};
      }
      break;
    default:
      break;
  }
  scheduleLive();
  updateWorking();
}

function finishMessage(message) {
  if (!message) return;
  if (message.role === "assistant") {
    state.live = null;
    state.messages.push(message);
    refreshCurrentTurn();
    el.empty.hidden = true;
    // 最终答案（纯文字、没有继续调工具）出现的那一刻就收起工具卡片
    if (!contentBlocks(message).some((block) => block && block.type === "toolCall")) {
      collapseTools();
    }
    scrollBottom();
    refreshStats();
  } else if (message.role === "user") {
    if (state.optimisticEl) {
      state.optimisticEl.remove();
      state.optimisticEl = null;
    }
    state.messages.push(message);
    // 新用户消息 = 新的一轮：渲染这一轮并追加到末尾。
    const turns = buildTurns(state.messages);
    const turn = turns[turns.length - 1];
    const nodes = turn ? turnNodes(turn, turnContext(turn)) : [];
    for (const node of nodes) el.messages.appendChild(node);
    state.lastTurnNodes = nodes;
    el.empty.hidden = true;
    renderRail();
    scrollBottom();
  } else if (message.role === "toolResult") {
    state.messages.push(message);
    if (message.toolCallId) {
      state.toolResults.set(message.toolCallId, {
        content: message.content,
        isError: message.isError,
        durationMs: message.durationMs,
        done: true,
      });
    }
    // 孤儿结果也走重绘，它会作为独立节点出现在当前轮里。
    refreshCurrentTurn();
    scrollBottom();
  }
}

function collapseTools() {
  // 卡片始终折叠是常态：把本轮和之前的工具卡、思考卡统一收起；用户之后仍可再点开
  for (const card of el.messages.querySelectorAll(".tool")) {
    card.classList.remove("open");
    const body = card.querySelector(".tool-body");
    if (body) body.hidden = true;
  }
  state.toolOpen.clear();
  for (const card of el.messages.querySelectorAll("details.think[open]")) {
    card.removeAttribute("open");
  }
  state.openThink = false;
}

/* 工具状态一变就重绘当前轮：摘要里的进度/失败数、卡片状态都从这里更新。 */
function updateToolDom() {
  refreshCurrentTurn();
  scrollBottom();
}

/* ------------------------------------------------------------------ */
/* composer                                                            */
/* ------------------------------------------------------------------ */

// 输入框最高能长到视口的三分之一多一点：软键盘弹出或横屏时，
// 发送按钮和最后一行输入不能一起被挤出屏幕。
function maxInputHeight() {
  const viewport = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  return Math.max(96, Math.min(220, Math.round(viewport * 0.36)));
}

function autosize() {
  el.input.style.height = "auto";
  el.input.style.height = Math.min(el.input.scrollHeight, maxInputHeight()) + "px";
}

function addOptimisticUser(text, images) {
  const node = userNode({ role: "user", content: images.concat(text ? [{ type: "text", text }] : []) });
  el.messages.appendChild(node);
  state.optimisticEl = node;
  el.empty.hidden = true;
  scrollBottom(true);
}

async function sendMessage() {
  if (state.needsWorkspace) {
    openWorkspacePicker();
    return;
  }
  const text = el.input.value.trim();
  if (!text && !state.attachments.length) return;
  if (!state.key) {
    try {
      await newSession();
    } catch (error) {
      toast("创建会话失败：" + error.message, "error");
      return;
    }
  }

  const images = state.attachments.map((item) => ({ type: "image", data: item.data, mimeType: item.mime }));
  el.input.value = "";
  autosize();
  state.attachments = [];
  renderAttachments();
  updateSendState();
  closeSlash();

  addOptimisticUser(text, images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType })));

  const body = { key: state.key, message: text || "请看这张图片。" };
  if (images.length) body.images = images;
  if (state.streaming) body.behavior = "steer";

  try {
    await api("/api/chat", body);
  } catch (error) {
    if (state.optimisticEl) {
      state.optimisticEl.remove();
      state.optimisticEl = null;
    }
    el.input.value = text;
    autosize();
    updateSendState();
    toast("发送失败：" + error.message, "error");
  }
}

async function abortRun() {
  if (!state.key) return;
  try {
    await api("/api/abort", { key: state.key });
    toast("已请求停止");
  } catch (error) {
    toast("停止失败：" + error.message, "error");
  }
}

function renderAttachments() {
  if (!state.attachments.length) {
    el.attachRow.hidden = true;
    el.attachRow.innerHTML = "";
    updateSendState();
    return;
  }
  el.attachRow.hidden = false;
  el.attachRow.innerHTML = state.attachments
    .map(
      (item, index) =>
        '<div class="attach-thumb"><img src="' + item.url + '" alt=""><button type="button" data-remove="' + index + '">' +
        ICON("x") +
        "</button></div>",
    )
    .join("");
  updateSendState();
}

function addFiles(files) {
  const accepted = Array.from(files).filter((file) => file && file.type.startsWith("image/"));
  for (const file of accepted.slice(0, 6)) {
    if (file.size > 8 * 1024 * 1024) {
      toast("图片过大（上限 8MB）：" + file.name, "error");
      continue;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || "");
      const comma = url.indexOf(",");
      state.attachments.push({
        id: Math.random().toString(36).slice(2),
        name: file.name || "image",
        mime: file.type || "image/png",
        data: comma >= 0 ? url.slice(comma + 1) : url,
        url,
      });
      renderAttachments();
    };
    reader.readAsDataURL(file);
  }
}

/* ------------------------------------------------------------------ */
/* slash commands                                                      */
/* ------------------------------------------------------------------ */

function closeSlash() {
  state.slash = null;
  closeMenu();
}

function updateSlash() {
  const value = el.input.value;
  const match = value.match(/^\/([^\s]*)$/);
  if (!match) {
    if (state.slash) closeSlash();
    return;
  }
  const query = match[1].toLowerCase();
  const items = state.commands
    .filter((command) => {
      if (command.name.startsWith("builtin:")) return false;
      return !query || command.name.toLowerCase().includes(query) || (command.description || "").toLowerCase().includes(query);
    })
    .slice(0, 9);
  if (!items.length) {
    if (state.slash) closeSlash();
    return;
  }
  openMenu(el.composer, items.map((command) => ({
    label: "/" + command.name,
    sub: command.description || "",
    badge: command.source === "skill" ? "技能" : command.source === "prompt" ? "模板" : "扩展",
    onClick: () => applyCommandName(command.name),
  })), { align: "left", preferUp: true, slash: true });
  state.slash = { items, index: 0 };
  const first = el.menuLayer.querySelector(".menu-item");
  if (first) first.classList.add("active");
}

function applyCommandName(name) {
  el.input.value = "/" + name + " ";
  autosize();
  closeSlash();
  el.input.focus();
  updateSendState();
}

function moveSlash(delta) {
  if (!state.slash) return;
  const buttons = Array.from(el.menuLayer.querySelectorAll(".menu-item"));
  if (!buttons.length) return;
  state.slash.index = (state.slash.index + delta + buttons.length) % buttons.length;
  buttons.forEach((button, index) => button.classList.toggle("active", index === state.slash.index));
  buttons[state.slash.index].scrollIntoView({ block: "nearest" });
}

function chooseSlash() {
  if (!state.slash) return false;
  const buttons = Array.from(el.menuLayer.querySelectorAll(".menu-item"));
  const button = buttons[state.slash.index];
  if (button) button.click();
  return true;
}

/* ------------------------------------------------------------------ */
/* menus                                                               */
/* ------------------------------------------------------------------ */

function closeMenu() {
  el.menuLayer.hidden = true;
  el.menuLayer.innerHTML = "";
  el.menuLayer.onclick = null;
  state.menuAnchor = null;
  if (state.slash) state.slash = null;
}

function openMenu(anchor, items, options) {
  const opts = options || {};
  closeMenu();
  state.menuAnchor = anchor;
  el.menuLayer.hidden = false;
  const menu = document.createElement("div");
  menu.className = "menu" + (opts.className ? " " + opts.className : "");

  if (opts.html) {
    menu.innerHTML = opts.html;
  } else {
  for (const item of items) {
    if (!item) continue;
    if (item.sep) {
      const sep = document.createElement("div");
      sep.className = "menu-sep";
      menu.appendChild(sep);
      continue;
    }
    if (item.labelOnly) {
      const label = document.createElement("div");
      label.className = "menu-label";
      label.textContent = item.label;
      menu.appendChild(label);
      continue;
    }
    if (item.info) {
      const row = document.createElement("div");
      row.className = "menu-info";
      row.innerHTML = "<span>" + escapeHtml(item.info[0]) + "</span><b>" + escapeHtml(item.info[1]) + "</b>";
      menu.appendChild(row);
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "menu-item" + (item.active ? " active" : "") + (item.danger ? " danger" : "");
    let html = "";
    if (item.icon) html += '<span class="mi-ico">' + ICON(item.icon) + "</span>";
    html += '<span class="grow"><span class="mi-label">' + escapeHtml(item.label) + "</span>";
    if (item.sub) html += '<span class="sub">' + escapeHtml(item.sub) + "</span>";
    html += "</span>";
    if (item.badge) html += '<span class="badge">' + escapeHtml(item.badge) + "</span>";
    if (item.active) html += '<span class="check">' + ICON("check") + "</span>";
    button.innerHTML = html;
    button.addEventListener("click", () => {
      closeMenu();
      if (item.onClick) item.onClick();
    });
    menu.appendChild(button);
  }
  }

  el.menuLayer.appendChild(menu);

  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  let left = opts.align === "right" ? rect.right - width : rect.left;
  left = clamp(left, 8, window.innerWidth - width - 8);
  let top = rect.bottom + 6;
  const preferUp = opts.preferUp || top + height > window.innerHeight - 8;
  if (preferUp) {
    const floor = opts.above ? opts.above.getBoundingClientRect().top : rect.top;
    top = Math.max(8, floor - height - 8);
  }
  menu.style.left = left + "px";
  menu.style.top = top + "px";

  el.menuLayer.onclick = (event) => {
    if (event.target === el.menuLayer) closeMenu();
  };
}

function openModelMenu(anchor) {
  const models = state.models || [];
  const items = [{ label: "选择模型", labelOnly: true }];
  for (const model of models) {
    items.push({
      label: model.name || model.id,
      sub: (model.provider ? model.provider + " · " : "") + model.id + " · " + fmtTokens(model.contextWindow) + " ctx",
      active: state.model && state.model.id === model.id,
      onClick: () => selectModel(model),
    });
  }
  if (!models.length) items.push({ label: "没有可用模型", labelOnly: true });
  openMenu(anchor, items, { align: "left", preferUp: true, above: el.composer });
}

/* ---------- 记住上次选用的模型与思考强度 ---------- */
/* pi 的 RPC 接口 set_model / set_thinking_level 不写全局默认值，
 * 所以新建会话时总会回到模型默认（思考强度是 high）。
 * 这里在浏览器本地存一份，新建会话后自己套用回去。 */

const MODEL_PREF_KEY = "piwebui.model";
const THINK_PREF_KEY = "piwebui.thinkingLevel";

function readModelPref() {
  try {
    const raw = localStorage.getItem(MODEL_PREF_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.provider && parsed.id ? parsed : null;
  } catch {
    return null;
  }
}

function writeModelPref(model) {
  if (!model || !model.provider || !model.id) return;
  try {
    localStorage.setItem(MODEL_PREF_KEY, JSON.stringify({ provider: model.provider, id: model.id }));
  } catch {
    /* ignore */
  }
}

function readThinkPref() {
  try {
    return localStorage.getItem(THINK_PREF_KEY) || "";
  } catch {
    return "";
  }
}

function writeThinkPref(level) {
  try {
    localStorage.setItem(THINK_PREF_KEY, level);
  } catch {
    /* ignore */
  }
}

/** 新建会话后套用上次选用的模型和思考强度；失败就保持 pi 的默认值。 */
async function applySavedDefaults() {
  if (!state.key) return;
  const wanted = readModelPref();
  if (wanted && state.models.some((model) => model.provider === wanted.provider && model.id === wanted.id)) {
    const same = state.model && state.model.provider === wanted.provider && state.model.id === wanted.id;
    if (!same) {
      try {
        const result = await api("/api/command", {
          key: state.key,
          command: { type: "set_model", provider: wanted.provider, modelId: wanted.id },
        });
        if (result.success !== false) {
          state.model = result.data && result.data.id ? result.data : wanted;
          // 切模型会把思考强度重置成模型默认档，重新取一次可用档位
          state.thinkingLevels = await loadThinkingLevels();
        }
      } catch {
        /* 模型不可用就保持默认 */
      }
    }
  }

  const level = readThinkPref();
  const levels = state.thinkingLevels || [];
  if (level && level !== state.thinkingLevel && levels.includes(level)) {
    try {
      const result = await api("/api/command", {
        key: state.key,
        command: { type: "set_thinking_level", level },
      });
      if (result.success !== false) state.thinkingLevel = level;
    } catch {
      /* 档位不被支持就保持默认 */
    }
  }

  updateChips();
}

async function selectModel(model) {
  if (!state.key) return;
  try {
    const result = await api("/api/command", {
      key: state.key,
      command: { type: "set_model", provider: model.provider, modelId: model.id },
    });
    if (result.success === false) {
      toast("切换模型失败：" + (result.error || "pi 拒绝了该模型"), "error");
      return;
    }
    state.model = result.data && result.data.id ? result.data : model;
    writeModelPref(state.model);
    state.thinkingLevels = await loadThinkingLevels();
    updateChips();
    toast("已切换到 " + (state.model.name || state.model.id));
  } catch (error) {
    toast("切换模型失败：" + error.message, "error");
  }
}

async function loadThinkingLevels() {
  try {
    const data = await api("/api/session/snapshot", { key: state.key });
    return data.thinkingLevels || ["off"];
  } catch {
    return state.thinkingLevels;
  }
}

function openContextMenu(anchor) {
  const stats = state.stats || {};
  const usage = stats.contextUsage || {};
  const tokens = stats.tokens || {};
  const percent = usage.percent === null || usage.percent === undefined ? "—" : Number(usage.percent).toFixed(1) + "%";
  openMenu(
    anchor,
    [
      { label: "会话统计", labelOnly: true },
      { info: ["上下文占用", percent] },
      { info: ["已用", fmtTokens(usage.tokens) + " / " + fmtTokens(usage.contextWindow)] },
      { info: ["用户消息", stats.userMessages || 0] },
      { info: ["助手消息", stats.assistantMessages || 0] },
      { info: ["工具调用", stats.toolCalls || 0] },
      { info: ["输入 tokens", fmtTokens(tokens.input)] },
      { info: ["输出 tokens", fmtTokens(tokens.output)] },
      { info: ["缓存读取", fmtTokens(tokens.cacheRead)] },
      { info: ["累计 tokens", fmtTokens(tokens.total)] },
      { info: ["费用", fmtCost(stats.cost)] },
      { sep: true },
      { label: "压缩上下文", icon: "refresh", onClick: () => compactSession() },
    ],
    { align: "left", preferUp: true, above: el.composer },
  );
}

function openThinkMenu(anchor) {
  const levels = state.thinkingLevels && state.thinkingLevels.length ? state.thinkingLevels : ["off"];
  const items = [{ label: "思考深度", labelOnly: true }];
  for (const level of levels) {
    items.push({
      label: level,
      active: state.thinkingLevel === level,
      onClick: () => selectThink(level),
    });
  }
  openMenu(anchor, items, { align: "left", preferUp: true, above: el.composer });
}

async function selectThink(level) {
  if (!state.key) return;
  try {
    const result = await api("/api/command", {
      key: state.key,
      command: { type: "set_thinking_level", level },
    });
    if (result.success === false) {
      toast("切换思考深度失败：" + (result.error || "pi 拒绝了这个级别"), "error");
      return;
    }
    state.thinkingLevel = level;
    writeThinkPref(level);
    updateChips();
  } catch (error) {
    toast("切换思考深度失败：" + error.message, "error");
  }
}

function currentSessionMeta() {
  if (!state.file) return null;
  return state.sessions.find((session) => session.file === state.file) || null;
}

function openSessionMenu(anchor, file) {
  const session = state.sessions.find((item) => item.file === file);
  if (!session) return;
  openMenu(
    anchor,
    [
      {
        label: "取消归档",
        icon: "archive",
        onClick: () => setArchived(file, false),
      },
      {
        label: "删除会话",
        icon: "trash",
        danger: true,
        onClick: () => deleteSession(file),
      },
    ],
    { align: "right" },
  );
}

function deleteSession(file) {
  const session = state.sessions.find((item) => item.file === file);
  const label = session ? session.name || session.title : "这个会话";
  openModal({
    title: "删除会话",
    body: "<p>「" + escapeHtml(label) + "」的会话文件会被永久删除，无法恢复。</p>",
    actions: [
      { label: "取消" },
      {
        label: "删除",
        kind: "danger",
        onClick: async () => {
          try {
            await api("/api/session/delete", { file });
            toast("会话已删除");
            if (state.file === file) await newSession();
            else await refreshSessions();
          } catch (error) {
            toast("删除失败：" + error.message, "error");
          }
        },
      },
    ],
  });
}

async function setArchived(file, archived) {
  if (!file) return;
  try {
    await api("/api/archive", { file, archived });
    toast(archived ? "已归档" : "已取消归档");
    await refreshSessions();
  } catch (error) {
    toast("操作失败：" + error.message, "error");
  }
}

async function setPinned(file, pinned) {
  if (!file) return;
  try {
    await api("/api/pin", { file, pinned });
    toast(pinned ? "已置顶" : "已取消置顶");
    await refreshSessions();
  } catch (error) {
    toast("操作失败：" + error.message, "error");
  }
}

function openMoreMenu(anchor) {
  const current = currentSessionMeta();
  const items = [];
  items.push(
    { label: "完成时通知", icon: "bell", active: readNotifyPref(), onClick: () => toggleNotify() },
    { sep: true },
    { label: "重命名会话", icon: "edit", onClick: () => renameSession() },
    {
      label: "复制会话 ID",
      icon: "copy",
      onClick: async () => {
        try {
          await navigator.clipboard.writeText((state.key || "").replace(/^s:/, ""));
          toast("会话 ID 已复制");
        } catch {
          toast("复制失败", "error");
        }
      },
    },
  );
  // 只有浏览器给了安装事件、且当前不是已安装的独立窗口时才显示。
  if (state.installPrompt && !isStandalone()) {
    items.push({ label: "安装到桌面", icon: "down", onClick: () => promptInstall() });
  }
  if (current) {
    items.push(
      { sep: true },
      {
        label: current.archived ? "取消归档" : "归档会话",
        icon: "archive",
        onClick: () => setArchived(current.file, !current.archived),
      },
    );
  }
  openMenu(anchor, items, { align: "right" });
}

/* ------------------------------------------------------------------ */
/* modal + stats + rename                                              */
/* ------------------------------------------------------------------ */

function openModal(options) {
  el.modalLayer.hidden = false;
  el.modalLayer.innerHTML = "";
  const card = document.createElement("div");
  card.className = "modal";
  card.innerHTML =
    '<div class="modal-head"><h3>' + escapeHtml(options.title || "") + "</h3>" +
    '<button class="icon-btn" type="button" data-close>' + ICON("x") + "</button></div>" +
    '<div class="modal-body">' + (options.body || "") + "</div>" +
    '<div class="modal-foot"></div>';
  const foot = card.querySelector(".modal-foot");
  for (const action of options.actions || []) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn " + (action.kind || "");
    button.textContent = action.label;
    button.addEventListener("click", () => {
      const keep = action.onClick ? action.onClick(card) : undefined;
      if (keep !== false) close();
    });
    foot.appendChild(button);
  }
  el.modalLayer.appendChild(card);
  el.modalLayer.onclick = (event) => {
    if (event.target === el.modalLayer) close();
  };

  function close() {
    el.modalLayer.hidden = true;
    el.modalLayer.innerHTML = "";
    el.modalLayer.onclick = null;
    if (options.onClose) options.onClose();
  }

  card.querySelector("[data-close]").addEventListener("click", close);
  return { card, close };
}

function renameSession() {
  openModal({
    title: "重命名会话",
    body: '<input class="field" id="renameInput" value="' + escapeHtml(state.sessionName || sessionTitle()) + '">',
    actions: [
      { label: "取消" },
      {
        label: "保存",
        kind: "primary",
        onClick: (card) => {
          const value = card.querySelector("#renameInput").value.trim();
          saveName(value);
        },
      },
    ],
    onClose: () => {},
  });
  const input = el.modalLayer.querySelector("#renameInput");
  if (input) {
    input.focus();
    input.select();
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        const value = input.value.trim();
        el.modalLayer.hidden = true;
        el.modalLayer.innerHTML = "";
        saveName(value);
      }
    });
  }
}

async function saveName(name) {
  if (!state.key) return;
  if (!name) {
    toast("名字不能为空", "error");
    return;
  }
  try {
    await api("/api/rename", { key: state.key, name });
    state.sessionName = name;
    updateHeader();
    refreshSessions();
    toast("已重命名");
  } catch (error) {
    toast("重命名失败：" + error.message, "error");
  }
}

async function compactSession() {
  if (!state.key) return;
  toast("正在压缩上下文…");
  try {
    const result = await api("/api/command", { key: state.key, command: { type: "compact" } });
    if (result.success === false) {
      toast("压缩失败：" + (result.error || "未知错误"), "error");
      return;
    }
    toast("上下文已压缩");
    refreshStats();
  } catch (error) {
    toast("压缩失败：" + error.message, "error");
  }
}

/* ------------------------------------------------------------------ */
/* extension dialogs                                                   */
/* ------------------------------------------------------------------ */

function handleUiRequest(request) {
  if (!request || !request.method) return;
  if (request.method === "notify") {
    toast(request.message || "", request.notifyType === "error" ? "error" : "");
    return;
  }
  if (request.method === "setTitle") {
    document.title = request.title || "Easy-Pi WebUI";
    return;
  }
  if (request.method === "set_editor_text") {
    el.input.value = request.text || "";
    autosize();
    updateSendState();
    return;
  }
  if (request.method === "setStatus") {
    if (request.statusText) setStatus(request.statusText);
    return;
  }
  if (request.method === "setWidget" || request.method === "setWorkingMessage") return;
  if (["confirm", "select", "input", "editor"].includes(request.method)) showUiDialog(request);
}

function respondUi(id, payload) {
  if (!state.key) return;
  api("/api/ui", { key: state.key, id, payload }).catch((error) => toast("响应失败：" + error.message, "error"));
}

function showUiDialog(request) {
  const id = request.id;
  let dialog = null;
  let responded = false;
  let timer = 0;

  const dismiss = () => {
    if (timer) clearTimeout(timer);
    if (responded) return;
    responded = true;
    respondUi(id, { cancelled: true });
  };

  const finish = (payload) => {
    responded = true;
    if (timer) clearTimeout(timer);
    respondUi(id, payload);
    if (dialog) dialog.close();
  };

  if (request.timeout) {
    timer = setTimeout(() => {
      if (dialog) dialog.close();
    }, request.timeout + 300);
  }

  if (request.method === "confirm") {
    dialog = openModal({
      title: request.title || "确认",
      body: "<p>" + escapeHtml(request.message || "") + "</p>",
      actions: [
        { label: "拒绝", onClick: () => finish({ confirmed: false }) },
        { label: "允许", kind: "primary", onClick: () => finish({ confirmed: true }) },
      ],
      onClose: dismiss,
    });
    return;
  }

  if (request.method === "select") {
    const options = Array.isArray(request.options) ? request.options : [];
    dialog = openModal({
      title: request.title || "请选择",
      body: '<div class="options"></div>',
      actions: [{ label: "取消", onClick: () => finish({ cancelled: true }) }],
      onClose: dismiss,
    });
    const box = dialog.card.querySelector(".options");
    for (const option of options) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = option;
      button.addEventListener("click", () => finish({ value: option }));
      box.appendChild(button);
    }
    return;
  }

  if (request.method === "input") {
    dialog = openModal({
      title: request.title || "输入",
      body: '<input class="field" id="uiInput" placeholder="' + escapeHtml(request.placeholder || "") + '">',
      actions: [
        { label: "取消", onClick: () => finish({ cancelled: true }) },
        {
          label: "确定",
          kind: "primary",
          onClick: (card) => {
            const value = card.querySelector("#uiInput").value;
            finish({ value });
          },
        },
      ],
      onClose: dismiss,
    });
    const input = dialog.card.querySelector("#uiInput");
    input.focus();
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") finish({ value: input.value });
    });
    return;
  }

  if (request.method === "editor") {
    dialog = openModal({
      title: request.title || "编辑",
      body: '<textarea class="field" id="uiEditor"></textarea>',
      actions: [
        { label: "取消", onClick: () => finish({ cancelled: true }) },
        {
          label: "保存",
          kind: "primary",
          onClick: (card) => finish({ value: card.querySelector("#uiEditor").value }),
        },
      ],
      onClose: dismiss,
    });
    const area = dialog.card.querySelector("#uiEditor");
    area.value = request.prefill || "";
    area.focus();
  }
}

/* ------------------------------------------------------------------ */
/* theme + shortcuts + wiring                                          */
/* ------------------------------------------------------------------ */

const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");

function resolvedTheme(mode) {
  if (mode === "system") return systemTheme.matches ? "dark" : "light";
  return mode === "light" ? "light" : "dark";
}

function applyTheme(mode) {
  const next = mode === "light" || mode === "system" ? mode : "dark";
  const resolved = resolvedTheme(next);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.mode = next;
  const label = next === "system" ? "跟随系统" : next === "dark" ? "深色" : "浅色";
  el.themeBtn.title = "外观：" + label;
  el.themeBtn.setAttribute("aria-label", "外观：" + label);
  try {
    localStorage.setItem("piwebui.theme", next);
  } catch {
    /* ignore */
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", resolved === "dark" ? "#181c22" : "#f7f9fc");
}

function openThemeMenu(anchor) {
  const current = document.documentElement.dataset.mode || "dark";
  openMenu(
    anchor,
    [
      { label: "浅色", icon: "sun", active: current === "light", onClick: () => applyTheme("light") },
      { label: "深色", icon: "moon", active: current === "dark", onClick: () => applyTheme("dark") },
      { label: "跟随系统", icon: "monitor", active: current === "system", onClick: () => applyTheme("system") },
    ],
    { align: "right" },
  );
}

function sidebarVisible() {
  if (window.innerWidth <= 900) return el.app.classList.contains("sidebar-open");
  return !el.app.classList.contains("sidebar-hidden");
}

function syncNavToggle() {
  const label = sidebarVisible() ? "收起侧栏" : "展开侧栏";
  el.menuBtn.title = label;
  el.menuBtn.setAttribute("aria-label", label);
}

function toggleSidebar() {
  if (window.innerWidth <= 900) {
    el.app.classList.toggle("sidebar-open");
  } else {
    el.app.classList.toggle("sidebar-hidden");
    try {
      localStorage.setItem("piwebui.sidebar", el.app.classList.contains("sidebar-hidden") ? "hidden" : "shown");
    } catch {
      /* ignore */
    }
  }
  syncNavToggle();
  requestAnimationFrame(updateRailVisibility);
}

function initSidebarResizer() {
  try {
    const saved = Number(localStorage.getItem("piwebui.sidebarWidth") || 0);
    if (saved >= 220 && saved <= 520 && window.innerWidth > 900) {
      const width = Math.min(saved, Math.round(window.innerWidth * 0.45));
      el.app.style.setProperty("--sidebar-w", Math.round(width) + "px");
    }
  } catch {
    /* ignore */
  }

  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  const onMove = (event) => {
    if (!dragging) return;
    const max = Math.max(260, Math.min(520, Math.round(window.innerWidth * 0.45)));
    const width = clamp(startWidth + event.clientX - startX, 220, max);
    el.app.style.setProperty("--sidebar-w", Math.round(width) + "px");
  };

  const stop = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("resizing");
    try {
      localStorage.setItem("piwebui.sidebarWidth", String(Math.round(el.sidebar.getBoundingClientRect().width)));
    } catch {
      /* ignore */
    }
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", stop);
    renderRail();
  };

  el.resizer.addEventListener("pointerdown", (event) => {
    if (window.innerWidth <= 900) return;
    event.preventDefault();
    dragging = true;
    startX = event.clientX;
    startWidth = el.sidebar.getBoundingClientRect().width;
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
  });

  el.resizer.addEventListener("dblclick", () => {
    el.app.style.setProperty("--sidebar-w", "248px");
    try {
      localStorage.setItem("piwebui.sidebarWidth", "248");
    } catch {
      /* ignore */
    }
    renderRail();
  });
}

function bindEvents() {
  el.newChat.addEventListener("click", () => newSession().catch((error) => toast("新建失败：" + error.message, "error")));
  el.brand.addEventListener("click", (event) => {
    event.preventDefault();
    newSession().catch(() => {});
  });

  el.sessionList.addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-toggle-archive]");
    if (toggle) {
      state.archivedOpen = !state.archivedOpen;
      renderSessions();
      return;
    }

    const pinButton = event.target.closest("[data-pin-file]");
    if (pinButton) {
      event.stopPropagation();
      const file = pinButton.getAttribute("data-pin-file");
      const session = state.sessions.find((item) => item.file === file);
      setPinned(file, !(session && session.pinned));
      return;
    }

    const archiveButton = event.target.closest("[data-archive-file]");
    if (archiveButton) {
      event.stopPropagation();
      setArchived(archiveButton.getAttribute("data-archive-file"), true);
      return;
    }

    const menuButton = event.target.closest("[data-menu-file]");
    if (menuButton) {
      event.stopPropagation();
      openSessionMenu(menuButton, menuButton.getAttribute("data-menu-file"));
      return;
    }

    const button = event.target.closest("[data-file]");
    if (!button) return;
    const file = button.getAttribute("data-file");
    openSession(file)
      .then(() => {
        if (window.innerWidth <= 900) el.app.classList.remove("sidebar-open");
      })
      .catch((error) => toast("打开会话失败：" + error.message, "error"));
  });

  el.search.addEventListener("input", () => {
    state.filter = el.search.value;
    renderSessions();
  });

  el.menuBtn.addEventListener("click", toggleSidebar);
  el.scrim.addEventListener("click", () => {
    el.app.classList.remove("sidebar-open");
    syncNavToggle();
  });

  el.themeBtn.addEventListener("click", () => openThemeMenu(el.themeBtn));
  el.moreBtn.addEventListener("click", () => openMoreMenu(el.moreBtn));
  el.workspaceChip.addEventListener("click", () => (state.needsWorkspace ? openWorkspacePicker() : openWorkspaceMenu()));
  el.emptyPickBtn.addEventListener("click", openWorkspacePicker);
  el.modelChip.addEventListener("click", () => openModelMenu(el.modelChip));
  el.thinkChip.addEventListener("click", () => openThinkMenu(el.thinkChip));
  el.ctxChip.addEventListener("click", () => openContextMenu(el.ctxChip));

  el.attachBtn.addEventListener("click", () => el.fileInput.click());
  el.fileInput.addEventListener("change", () => {
    addFiles(el.fileInput.files || []);
    el.fileInput.value = "";
  });

  el.input.addEventListener("input", () => {
    autosize();
    updateSendState();
    updateSlash();
  });

  el.input.addEventListener("keydown", (event) => {
    // IME 组合中一律不当作发送：部分旧版 Safari 只报 keyCode 229 而不给 isComposing
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey) {
      if (state.slash && chooseSlash()) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      if (!state.streaming && el.sendBtn.disabled) return;
      sendMessage();
    }
    if (state.slash && event.key === "ArrowDown") {
      event.preventDefault();
      moveSlash(1);
    }
    if (state.slash && event.key === "ArrowUp") {
      event.preventDefault();
      moveSlash(-1);
    }
    if (state.slash && event.key === "Tab") {
      event.preventDefault();
      chooseSlash();
    }
    if (event.key === "Escape" && state.slash) {
      event.preventDefault();
      event.stopPropagation();
      closeSlash();
    }
  });

  el.sendBtn.addEventListener("click", () => {
    if (state.streaming) abortRun();
    else sendMessage();
  });

  el.suggestions.addEventListener("click", (event) => {
    const button = event.target.closest("[data-suggest]");
    if (!button) return;
    el.input.value = button.getAttribute("data-suggest");
    autosize();
    updateSendState();
    el.input.focus();
  });

  el.thread.addEventListener("scroll", () => {
    el.toBottom.hidden = scrollNearBottom();
  });
  el.toBottom.addEventListener("click", () => scrollBottom(true));

  el.messages.addEventListener("click", (event) => {
    const procToggle = event.target.closest("[data-proc-toggle]");
    if (procToggle) {
      const group = procToggle.closest(".proc");
      if (group) {
        const key = group.getAttribute("data-proc-key");
        const open = !(state.procOpen.get(key) || false);
        if (open) state.procOpen.set(key, true);
        else state.procOpen.delete(key);
        group.classList.toggle("open", open);
        procToggle.setAttribute("aria-expanded", open ? "true" : "false");
        const body = group.querySelector(".proc-body");
        if (body) {
          // 折叠时组体是空的，展开才按需把卡片填进去。
          if (open && !body.innerHTML) {
            const segment = findProcSegment(key);
            if (segment) body.innerHTML = segment.members.map(procMemberHtml).join("");
          }
          body.hidden = !open;
        }
      }
      return;
    }

    const toggle = event.target.closest("[data-tool-toggle]");
    if (toggle) {
      const card = toggle.closest(".tool");
      const body = card.querySelector(".tool-body");
      const open = body.hidden;
      body.hidden = !open;
      card.classList.toggle("open", open);
      state.toolOpen.set(card.getAttribute("data-tool-id"), open);
      return;
    }

    const copy = event.target.closest("[data-copy]");
    if (copy) {
      const code = copy.closest(".code");
      const pre = code ? code.querySelector("pre") : null;
      if (pre) {
        navigator.clipboard.writeText(pre.textContent || "").then(
          () => {
            copy.textContent = "已复制";
            setTimeout(() => (copy.textContent = "复制"), 1400);
          },
          () => toast("复制失败", "error"),
        );
      }
      return;
    }

    const action = event.target.closest("[data-act]");
    if (action) {
      const act = action.getAttribute("data-act");
      if (act === "edit-user" || act === "regen-user" || act === "regen-bot") {
        handleForkAction(act, action);
        return;
      }
      const node = action.closest(".msg");
      if (!node) return;
      // 只复制正文，不要把过程摘要、卡片内容、「复制 / 编辑 / 重新生成」这些按钮文字带进去。
      const parts = [];
      const bubble = node.querySelector(".bubble");
      if (bubble) {
        parts.push(bubble.innerText);
      } else {
        for (const child of node.querySelectorAll(".body > .markdown")) parts.push(child.innerText);
      }
      const text = parts.join("\n").trim();
      if (text) {
        navigator.clipboard.writeText(text).then(
          () => toast("已复制"),
          () => toast("复制失败", "error"),
        );
      }
    }
  });

  el.messages.addEventListener(
    "toggle",
    (event) => {
      if (event.target.classList && event.target.classList.contains("think")) {
        state.openThink = event.target.open;
      }
    },
    true,
  );

  el.composer.addEventListener("dragover", (event) => {
    event.preventDefault();
    el.composer.classList.add("dragover");
  });
  el.composer.addEventListener("dragleave", () => el.composer.classList.remove("dragover"));
  el.composer.addEventListener("drop", (event) => {
    event.preventDefault();
    el.composer.classList.remove("dragover");
    if (event.dataTransfer && event.dataTransfer.files) addFiles(event.dataTransfer.files);
  });

  document.addEventListener("paste", (event) => {
    if (document.activeElement !== el.input) return;
    const items = event.clipboardData ? Array.from(event.clipboardData.items) : [];
    const files = items
      .filter((item) => item.type && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (files.length) {
      event.preventDefault();
      addFiles(files);
    }
  });

  el.attachRow.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove]");
    if (!button) return;
    state.attachments.splice(Number(button.getAttribute("data-remove")), 1);
    renderAttachments();
  });

  document.addEventListener("pointerdown", (event) => {
    if (el.menuLayer.hidden) return;
    if (event.target.closest && event.target.closest(".menu")) return;
    if (state.menuAnchor && state.menuAnchor.contains(event.target)) return;
    closeMenu();
  }, true);

  document.addEventListener("keydown", (event) => {
    if (!el.modalLayer.hidden) {
      if (event.key === "Escape") {
        const closeButton = el.modalLayer.querySelector("[data-close]");
        if (closeButton) closeButton.click();
      }
      return;
    }
    const meta = event.metaKey || event.ctrlKey;
    if (meta && event.key.toLowerCase() === "n") {
      event.preventDefault();
      newSession().catch(() => {});
      return;
    }
    if (meta && event.key.toLowerCase() === "b") {
      event.preventDefault();
      toggleSidebar();
      return;
    }
    if (event.key === "Escape") {
      if (!el.modalLayer.hidden) return;
      if (!el.menuLayer.hidden) {
        closeMenu();
        return;
      }
      if (state.streaming) {
        event.preventDefault();
        abortRun();
      }
    }
  });

  window.addEventListener("beforeunload", () => {
    if (state.es) state.es.close();
  });
  window.addEventListener("resize", () => {
    syncNavToggle();
    renderRail();
    autosize();
  });
  // 软键盘弹出会改变 visualViewport 而不是 window 尺寸，跟着收一下输入框。
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", autosize);
  }
  window.addEventListener("focus", () => markSeen());
  document.addEventListener("visibilitychange", () => {
    if (isViewing()) markSeen();
  });
  bindRail();
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  bindEvents();
  setupInstallPrompt();
  registerServiceWorker();
  initSidebarResizer();

  let theme = "system";
  try {
    theme = localStorage.getItem("piwebui.theme") || "system";
    if (localStorage.getItem("piwebui.sidebar") === "hidden" && window.innerWidth > 900) {
      el.app.classList.add("sidebar-hidden");
    }
  } catch {
    /* ignore */
  }
  applyTheme(theme === "light" || theme === "system" ? theme : "dark");
  connectSessionEvents();
  systemTheme.addEventListener("change", () => {
    if (document.documentElement.dataset.mode === "system") applyTheme("system");
  });
  syncNavToggle();
  autosize();
  updateSendState();

  try {
    const bootstrap = await api("/api/bootstrap");
    state.workspace = bootstrap.workspace || "";
    state.needsWorkspace = Boolean(bootstrap.needsWorkspace);
    state.workspaceError = bootstrap.workspaceError || "";
    state.piVersion = bootstrap.piVersion || "";
    state.sessions = bootstrap.sessions || [];
    if (state.workspace) rememberWorkspace(state.workspace);
    updateWorkspace();
    updateWorkspaceGate();
    renderSessions();
    updateHeader();

    // 未选择工作区：不恢复、不新建会话，绝不让后端 spawn pi。
    if (state.needsWorkspace) {
      renderThread();
      if (state.workspaceError) toast(state.workspaceError, "error");
      openWorkspacePicker();
      return;
    }

    let last = null;
    try {
      last = JSON.parse(localStorage.getItem("piwebui.last") || "null");
    } catch {
      last = null;
    }
    const existing = last && last.file ? state.sessions.find((session) => session.file === last.file) : null;
    if (existing) await openSession(existing.file);
    else await newSession();
  } catch (error) {
    setStatus("后端未连接");
    toast("无法连接后端：" + error.message, "error");
  }
}

boot();