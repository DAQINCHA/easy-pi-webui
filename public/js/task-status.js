/**
 * 用已有的 SSE / RPC 事件推导给人看的任务状态。
 * 纯函数：无 DOM、无网络、无依赖，方便 node:test 直接导入。
 * 不编造百分比或预计时间，也不把单个工具失败当成整轮失败。
 */

export const PHASE = Object.freeze({
  IDLE: "idle",
  THINKING: "thinking",
  WRITING: "writing",
  TOOL: "tool",
  WAITING: "waiting",
  WORKING: "working",
  RETRYING: "retrying",
  COMPLETED: "completed",
  FAILED: "failed",
  STOPPED: "stopped",
  DISCONNECTED: "disconnected",
  UNKNOWN: "unknown",
});

const DIALOG_METHODS = new Set(["confirm", "select", "input", "editor"]);

const TOOL_META = {
  read: { verb: "读取文件", activity: (path) => (path ? "正在读取「" + path + "」" : "正在读取文件") },
  write: { verb: "写入文件", activity: (path) => (path ? "正在写入「" + path + "」" : "正在写入文件") },
  edit: { verb: "修改文件", activity: (path) => (path ? "正在修改「" + path + "」" : "正在修改文件") },
  bash: { verb: "运行命令", activity: () => "正在运行命令" },
  codemode: { verb: "运行脚本", activity: () => "正在运行脚本" },
  grep: { verb: "搜索", activity: () => "正在搜索" },
  glob: { verb: "查找文件", activity: () => "正在查找文件" },
  ls: { verb: "查看目录", activity: () => "正在查看目录" },
  find: { verb: "查找文件", activity: () => "正在查找文件" },
};

export function clipText(text, limit) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  if (value.length <= limit) return value;
  return value.slice(0, limit).replace(/[，,。.；;：:\s]+$/, "") + "…";
}

export function baseName(path) {
  const normalized = String(path || "").replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const name = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  return name || String(path || "");
}

export function toolPathOf(toolOrArgs) {
  if (!toolOrArgs || typeof toolOrArgs !== "object") return "";
  const args = toolOrArgs.args || toolOrArgs.arguments || toolOrArgs;
  if (!args || typeof args !== "object") return "";
  return typeof args.path === "string" ? args.path : "";
}

export function isFileChangingTool(name) {
  return name === "edit" || name === "write";
}

export function toolVerb(name) {
  const value = String(name || "");
  if (TOOL_META[value]) return TOOL_META[value].verb;
  if (value.startsWith("mcp__")) {
    const rest = value.slice(5);
    return rest ? "使用扩展「" + rest + "」" : "使用扩展工具";
  }
  return value ? "使用工具「" + value + "」" : "使用工具";
}

export function toolActivity(tool) {
  const name = String((tool && tool.name) || "");
  const path = baseName(toolPathOf(tool));
  if (TOOL_META[name]) return TOOL_META[name].activity(path);
  if (name.startsWith("mcp__")) return "正在" + toolVerb(name);
  return name ? "正在使用工具「" + name + "」" : "正在使用工具";
}

export function waitingLabel(waiting) {
  const method = waiting && waiting.method;
  if (method === "select") return "等待你选择";
  if (method === "input") return "等待你输入";
  if (method === "editor") return "等待你编辑";
  return "等待你确认";
}

export function createTaskState(sessionKey = null) {
  return {
    sessionKey,
    connection: "idle",
    replaying: false,
    streaming: false,
    thinking: false,
    writing: false,
    retrying: false,
    retryNote: "",
    tools: {},
    waiting: null,
    aborted: false,
    agentError: "",
    turnFiles: [],
    queue: 0,
    settledKind: null,
    settledFresh: false,
    processExit: null,
    phase: PHASE.IDLE,
  };
}

function cloneState(state) {
  return {
    ...state,
    tools: { ...state.tools },
    turnFiles: Array.isArray(state.turnFiles) ? state.turnFiles.slice() : [],
    waiting: state.waiting ? { ...state.waiting } : null,
    processExit: state.processExit ? { ...state.processExit } : null,
  };
}

function addTurnFile(next, path) {
  if (typeof path !== "string" || !path) return;
  if (!next.turnFiles.includes(path)) next.turnFiles.push(path);
}

function runningTools(state) {
  return Object.values(state.tools).filter((tool) => tool && tool.running);
}

function failedToolCount(state) {
  return Object.values(state.tools).filter((tool) => tool && tool.isError && !tool.running).length;
}

function setTool(next, id, patch) {
  const key = String(id || "");
  if (!key) return;
  const prev = next.tools[key] || { id: key, name: "", args: {}, running: false, isError: false };
  next.tools[key] = { ...prev, ...patch, id: key };
}

export function derivePhase(state) {
  if (state.connection === "down" || state.connection === "reconnecting") {
    return PHASE.DISCONNECTED;
  }
  if (state.waiting && (!state.settledKind || state.streaming)) {
    return PHASE.WAITING;
  }
  if (state.streaming) {
    if (state.retrying) return PHASE.RETRYING;
    if (runningTools(state).length) return PHASE.TOOL;
    if (state.thinking && !state.writing) return PHASE.THINKING;
    if (state.writing) return PHASE.WRITING;
    return PHASE.WORKING;
  }
  if (state.settledKind === "stopped" || state.aborted) return PHASE.STOPPED;
  if (state.settledKind === "failed" || (state.agentError && state.settledKind)) return PHASE.FAILED;
  if (state.settledKind === "completed") return PHASE.COMPLETED;
  if (state.processExit && !state.processExit.intentional && !state.settledKind) return PHASE.FAILED;
  return PHASE.IDLE;
}

function applyAssistantEvent(next, ev) {
  if (!ev || !ev.type) return;
  switch (ev.type) {
    case "thinking_start":
    case "thinking_delta":
      next.thinking = true;
      break;
    case "thinking_end":
      next.thinking = false;
      break;
    case "text_start":
    case "text_delta":
      next.writing = true;
      next.thinking = false;
      break;
    case "text_end":
      next.writing = false;
      break;
    case "toolcall_start":
      next.thinking = false;
      setTool(next, ev.id, { name: ev.toolName || ev.name || "", running: true, isError: false });
      break;
    case "toolcall_end":
      if (ev.toolCall) {
        const call = ev.toolCall;
        const args = call.arguments || {};
        setTool(next, call.id || ev.id, { name: call.name || "", args, running: true, isError: false });
        if (isFileChangingTool(call.name)) addTurnFile(next, args.path);
      }
      break;
    default:
      break;
  }
}

export function collectTurnFiles(messages, options) {
  const opts = options || {};
  const list = Array.isArray(messages) ? messages : [];
  let start = 0;
  if (opts.onlyLastTurn !== false) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i] && list[i].role === "user") {
        start = i;
        break;
      }
    }
  }
  const files = [];
  for (let i = start; i < list.length; i += 1) {
    const message = list[i];
    if (!message) continue;
    if (message.role === "user" && i !== start) break;
    const blocks = Array.isArray(message.content) ? message.content : [];
    for (const block of blocks) {
      if (!block) continue;
      const type = block.type;
      if (type !== "toolCall" && type !== "tool_use" && type !== "toolcall") continue;
      const name = block.name || block.toolName || "";
      const path = toolPathOf(block);
      if (isFileChangingTool(name) && path && !files.includes(path)) files.push(path);
    }
  }
  return files;
}

function hydrateInto(base, snapshot) {
  const snap = snapshot || {};
  const key = snap.key || base.sessionKey;
  const next = createTaskState(key);
  next.connection = base.connection && base.connection !== "idle" ? base.connection : "open";
  next.replaying = false;
  next.streaming = Boolean(snap.state && snap.state.isStreaming);
  const pending = (snap.pendingUi || []).filter((item) => item && DIALOG_METHODS.has(item.method));
  if (pending.length) {
    const last = pending[pending.length - 1];
    next.waiting = { id: last.id, method: last.method, title: last.title || "" };
  }
  next.turnFiles = collectTurnFiles(snap.messages || [], { onlyLastTurn: true });
  return next;
}

function finalize(state) {
  state.phase = derivePhase(state);
  return state;
}

export function reduceTaskState(state, event) {
  if (!event || !event.type) return state || createTaskState();
  const current = state || createTaskState();
  const next = cloneState(current);

  switch (event.type) {
    case "__session": {
      const fresh = createTaskState(event.key || event.sessionKey || null);
      fresh.connection = current.connection;
      fresh.replaying = current.replaying;
      return finalize(fresh);
    }
    case "__replay":
      next.replaying = Boolean(event.on);
      break;
    case "__connection":
      next.connection = event.status || "idle";
      if (event.status === "reconnecting") next.replaying = true;
      break;
    case "__ui_resolved":
      if (!next.waiting || !event.id || next.waiting.id === event.id) {
        next.waiting = null;
      }
      break;
    case "__hydrate": {
      const snap = event.snapshot || event;
      const same = (snap.key || null) === next.sessionKey;
      const preserved = same
        ? {
            settledKind: next.settledKind,
            settledFresh: false,
            agentError: next.agentError,
            aborted: next.aborted,
            turnFiles: next.turnFiles,
            tools: next.tools,
          }
        : null;
      const hydrated = hydrateInto(next, snap);
      if (preserved) {
        if (!hydrated.turnFiles.length) hydrated.turnFiles = preserved.turnFiles.slice();
        hydrated.tools = { ...preserved.tools };
        hydrated.settledFresh = false;
        if (!hydrated.streaming) {
          hydrated.settledKind = preserved.settledKind;
          hydrated.agentError = preserved.agentError;
          hydrated.aborted = preserved.aborted;
        }
      }
      return finalize(hydrated);
    }
    case "agent_start":
      next.streaming = true;
      next.thinking = false;
      next.writing = false;
      next.retrying = false;
      next.retryNote = "";
      next.tools = {};
      next.waiting = null;
      next.aborted = false;
      next.agentError = "";
      next.turnFiles = [];
      next.settledKind = null;
      next.settledFresh = false;
      next.processExit = null;
      break;
    case "message_update":
      applyAssistantEvent(next, event.assistantMessageEvent || event.update || event);
      break;
    case "thinking_start":
    case "thinking_delta":
    case "thinking_end":
    case "text_start":
    case "text_delta":
    case "text_end":
    case "toolcall_start":
    case "toolcall_end":
      applyAssistantEvent(next, event);
      break;
    case "message_end":
      if (event.message && event.message.role === "assistant") {
        next.thinking = false;
        next.writing = false;
        const message = event.message;
        if (message.stopReason === "error" || message.errorMessage) {
          next.agentError = clipText(message.errorMessage || "模型请求失败", 80);
        }
      }
      break;
    case "tool_execution_start": {
      const name = event.toolName || event.name || "";
      const args = event.args || {};
      setTool(next, event.toolCallId || event.id, { name, args, running: true, isError: false });
      if (isFileChangingTool(name)) addTurnFile(next, args.path);
      next.thinking = false;
      break;
    }
    case "tool_execution_end": {
      const id = event.toolCallId || event.id;
      const prev = id ? next.tools[id] : null;
      setTool(next, id, {
        running: false,
        isError: Boolean(event.isError),
        name: (prev && prev.name) || event.toolName || "",
      });
      break;
    }
    case "agent_settled":
      next.streaming = false;
      next.thinking = false;
      next.writing = false;
      next.retrying = false;
      next.retryNote = "";
      next.aborted = Boolean(event.aborted);
      next.queue = 0;
      if (next.aborted) {
        next.settledKind = "stopped";
        next.agentError = "";
      } else if (next.agentError) {
        next.settledKind = "failed";
      } else {
        next.settledKind = "completed";
      }
      next.settledFresh = !next.replaying;
      break;
    case "queue_update": {
      const steering = Array.isArray(event.steering) ? event.steering.length : 0;
      const follow = Array.isArray(event.followUp) ? event.followUp.length : 0;
      next.queue = steering + follow;
      break;
    }
    case "auto_retry_start":
      next.retrying = true;
      next.retryNote = event.maxAttempts
        ? "请求失败，正在重试（" + event.attempt + "/" + event.maxAttempts + "）"
        : "请求失败，正在重试…";
      break;
    case "auto_retry_end":
      next.retrying = false;
      next.retryNote = "";
      if (event.success === false) {
        next.agentError = clipText(event.finalError || "重试失败", 80);
      } else if (event.success === true) {
        next.agentError = "";
      }
      break;
    case "extension_ui_request":
      if (DIALOG_METHODS.has(event.method)) {
        next.waiting = { id: event.id, method: event.method, title: event.title || "" };
      }
      break;
    case "bridge_exit":
      next.streaming = false;
      next.thinking = false;
      next.writing = false;
      next.retrying = false;
      next.processExit = { intentional: Boolean(event.intentional), code: event.code ?? null };
      if (!event.intentional && !next.settledKind) {
        next.agentError = next.agentError || "助手进程已退出";
        next.settledKind = "failed";
        next.settledFresh = !next.replaying;
      }
      break;
    default:
      return current;
  }

  return finalize(next);
}

export function reduceAll(events, initial) {
  return (events || []).reduce((state, event) => reduceTaskState(state, event), initial || createTaskState());
}

export function describeTask(state) {
  const current = state || createTaskState();
  const phase = current.phase || derivePhase(current);
  const files = Array.isArray(current.turnFiles) ? current.turnFiles : [];
  const failedTools = failedToolCount(current);
  const live = phase === "waiting" || phase === "failed" || phase === "disconnected" ? "assertive" : "polite";
  const showSpinner = ["thinking", "writing", "tool", "working", "retrying"].includes(phase);
  const toneMap = {
    thinking: "busy",
    writing: "busy",
    tool: "busy",
    working: "busy",
    retrying: "busy",
    waiting: "wait",
    completed: "done",
    failed: "error",
    stopped: "stop",
    disconnected: "warn",
    unknown: "warn",
    idle: "idle",
  };
  const tone = toneMap[phase] || "idle";

  let label = "";
  switch (phase) {
    case PHASE.THINKING:
      label = "正在思考";
      break;
    case PHASE.WRITING:
      label = "正在写回复";
      break;
    case PHASE.TOOL: {
      const running = runningTools(current);
      if (running.length === 1) label = toolActivity(running[0]);
      else if (running.length > 1) {
        label = "正在同时处理 " + running.length + " 项（" + running.map((tool) => toolVerb(tool.name)).join("、") + "）";
      } else {
        label = "正在使用工具";
      }
      break;
    }
    case PHASE.WAITING:
      label = waitingLabel(current.waiting);
      break;
    case PHASE.RETRYING:
      label = current.retryNote || "请求失败，正在重试…";
      break;
    case PHASE.WORKING:
      label = "正在处理你的请求";
      break;
    case PHASE.COMPLETED:
      label = "已完成";
      break;
    case PHASE.FAILED:
      label = current.agentError ? "没有完成：" + current.agentError : "没有完成";
      break;
    case PHASE.STOPPED:
      label = "已停止";
      break;
    case PHASE.DISCONNECTED:
      if (current.connection === "reconnecting") label = "连接已断开，正在重连…任务状态可能不是最新的";
      else if (current.connection === "down") label = "后端未连接，任务状态可能不是最新的";
      else label = "连接已断开，任务状态可能不是最新的";
      break;
    case PHASE.UNKNOWN:
      label = "状态未知";
      break;
    default:
      label = "";
  }

  let summary = "";
  if (phase === PHASE.COMPLETED) {
    summary = "已完成。";
    if (files.length) summary += "改了 " + files.length + " 个文件，点下面的文件名可预览或下载。";
    if (failedTools) summary += "其中有 " + failedTools + " 个步骤没有成功。";
  } else if (phase === PHASE.FAILED) {
    summary = current.agentError ? "没有完成：" + current.agentError + "。" : "没有完成。";
    if (files.length) summary += "已改的 " + files.length + " 个文件仍可在下面预览或下载。";
  } else if (phase === PHASE.STOPPED) {
    summary = "已停止。";
    if (files.length) summary += "已改的 " + files.length + " 个文件仍可在下面预览或下载。";
  }

  return {
    phase,
    label,
    tone,
    live,
    showSpinner,
    summary,
    files,
    settledFresh: Boolean(
      current.settledFresh && (phase === PHASE.COMPLETED || phase === PHASE.FAILED || phase === PHASE.STOPPED),
    ),
    waiting: phase === PHASE.WAITING,
  };
}

export function connectionLabel(state, extras) {
  const opts = extras || {};
  if (opts.needsWorkspace) return "请先选择工作目录";
  const connection = state && state.connection;
  if (connection === "open") return "已连接";
  if (connection === "reconnecting") return "连接中断，正在重连…";
  if (connection === "down" || opts.bootError) return "后端未连接";
  return "";
}

export function shouldNotifyDone(state) {
  return Boolean(state && state.settledFresh && state.settledKind === "completed" && !state.replaying);
}
