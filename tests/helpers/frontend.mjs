import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { escapeHtml, parseAttachmentBlock, parseSkillBlock, renderMarkdown } from "../../public/js/markdown.js";
import {
  PHASE,
  connectionLabel,
  createTaskState,
  describeTask,
  reduceTaskState,
  shouldNotifyDone,
} from "../../public/js/task-status.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const APP = readFileSync(join(ROOT, "public/js/app.js"), "utf8");

/** app.js 顶部是 ES import，vm 里直接注入依赖；boot() 也不跑。 */
function appSource() {
  const start = APP.indexOf("const $ =");
  if (start === -1) throw new Error("app.js shape changed: const $ not found");
  return APP.slice(start).replace(/\nboot\(\);\s*$/, "\n") + "\nglobalThis.__app = {\n" +
    "  state, el, handleEvent, applySnapshot, saveName, refreshSessions, renderSessions, resync,\n" +
    "  sessionsForSidebar, sessionItemHtml, renameSession, updateHeader,\n" +
    "  renderThread, refreshCurrentTurn, turnNodes, turnContext, buildTurns, turnSegments,\n" +
    "  procStats, procHtml, procMemberHtml, findProcSegment, updateToolDom, bindEvents,\n" +
    "  syncProcNode: typeof syncProcNode === 'function' ? syncProcNode : undefined,\n" +
    "  patchAssistantNode: typeof patchAssistantNode === 'function' ? patchAssistantNode : undefined,\n" +
    "  reconcileBody: typeof reconcileBody === 'function' ? reconcileBody : undefined,\n" +
    "  rememberSessionName: typeof rememberSessionName === 'function' ? rememberSessionName : undefined,\n" +
    "  applySessionList: typeof applySessionList === 'function' ? applySessionList : undefined,\n" +
    "  nextSessionsSeq: typeof nextSessionsSeq === 'function' ? nextSessionsSeq : undefined,\n" +
    "  sessionNames: typeof sessionNames !== 'undefined' ? sessionNames : undefined,\n" +
    "  visiblePromptText: typeof visiblePromptText === 'function' ? visiblePromptText : undefined,\n" +
    "  userVisibleText: typeof userVisibleText === 'function' ? userVisibleText : undefined,\n" +
    "  requestBodyBytes: typeof requestBodyBytes === 'function' ? requestBodyBytes : undefined,\n" +
    "  requestTooLarge: typeof requestTooLarge === 'function' ? requestTooLarge : undefined,\n" +
    "  requestTooLargeMessage: typeof requestTooLargeMessage === 'function' ? requestTooLargeMessage : undefined,\n" +
    "  sendMessage: typeof sendMessage === 'function' ? sendMessage : undefined,\n" +
    "  addOptimisticUser: typeof addOptimisticUser === 'function' ? addOptimisticUser : undefined,\n" +
    "  settleOptimisticUser: typeof settleOptimisticUser === 'function' ? settleOptimisticUser : undefined,\n" +
    "  clearOptimistic: typeof clearOptimistic === 'function' ? clearOptimistic : undefined,\n" +
    "  updateSendState: typeof updateSendState === 'function' ? updateSendState : undefined,\n" +
    "  finishMessage: typeof finishMessage === 'function' ? finishMessage : undefined,\n" +
    "  renderQueue: typeof renderQueue === 'function' ? renderQueue : undefined,\n" +
    "  queueItems: typeof queueItems === 'function' ? queueItems : undefined,\n" +
    "  queueSummary: typeof queueSummary === 'function' ? queueSummary : undefined,\n" +
    "  applyQueueUpdate: typeof applyQueueUpdate === 'function' ? applyQueueUpdate : undefined,\n" +
    "  clearQueued: typeof clearQueued === 'function' ? clearQueued : undefined,\n" +
    "  insertQueuedItem: typeof insertQueuedItem === 'function' ? insertQueuedItem : undefined,\n" +
    "  cancelQueuedItem: typeof cancelQueuedItem === 'function' ? cancelQueuedItem : undefined,\n" +
    "};\n";
}

function unrefTimeout(fn, ms, ...args) {
  const timer = setTimeout(fn, ms, ...args);
  timer.unref?.();
  return timer;
}

/* ----------------------------- tiny DOM ---------------------------- */

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/*
 * 结构变更记录：最小 DOM 必须像浏览器一样，把「移动已有节点」建模成
 * remove + insert（传统 DOM 的 appendChild/insertBefore/replaceWith 都是摘下再插回），
 * 这样测试才能证明转圈节点真的留在原地，而不是只证明对象身份没变。
 */
let uidSeq = 0;

function nextUid() {
  uidSeq += 1;
  return uidSeq;
}

function traceConnected(node) {
  const trace = node && node._trace;
  if (!trace || !trace.root) return false;
  for (let current = node; current; current = current.parentNode) {
    if (current === trace.root) return true;
  }
  return false;
}

function recordOp(node, op, extra) {
  const trace = node && node._trace;
  if (!trace) return;
  trace.ops.push({
    op,
    uid: node._uid,
    kind: node.tagName ? node.tagName.toLowerCase() : "#text",
    className: node.className || "",
    parent: node.parentNode ? node.parentNode._uid : null,
    connected: traceConnected(node),
    ...extra,
  });
}

function decodeEntities(text) {
  return String(text)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function escapeText(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(text) {
  return escapeText(text).replace(/"/g, "&quot;");
}

function datasetKey(name) {
  return String(name)
    .slice(5)
    .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function makeClassList(node) {
  const read = () => String(node.className || "").split(/\s+/).filter(Boolean);
  const write = (list) => {
    node.className = list.join(" ");
  };
  return {
    add: (...names) => {
      const set = new Set(read());
      names.forEach((name) => set.add(name));
      write([...set]);
    },
    remove: (...names) => {
      const set = new Set(read());
      names.forEach((name) => set.delete(name));
      write([...set]);
    },
    contains: (name) => read().includes(name),
    toggle: (name, force) => {
      const set = new Set(read());
      const on = force === undefined ? !set.has(name) : Boolean(force);
      if (on) set.add(name);
      else set.delete(name);
      write([...set]);
      return on;
    },
    values: () => read(),
  };
}

function makeTextNode(text, trace = null) {
  const node = {
    nodeType: 3,
    textContent: String(text),
    parentNode: null,
    _uid: nextUid(),
    _trace: trace,
    _detaches: 0,
    _attaches: 0,
    get childNodes() {
      return [];
    },
    get children() {
      return [];
    },
    get nextSibling() {
      if (!node.parentNode) return null;
      const list = node.parentNode.childNodes;
      const index = list.indexOf(node);
      return index === -1 ? null : list[index + 1] || null;
    },
    remove() {
      detach(node, "remove");
    },
  };
  return node;
}

function detach(node, reason) {
  const parent = node && node.parentNode;
  if (!parent) return;
  recordOp(node, "remove", { reason: reason || "remove" });
  node._detaches = (node._detaches || 0) + 1;
  const list = parent.childNodes;
  const index = list ? list.indexOf(node) : -1;
  if (index !== -1) list.splice(index, 1);
  if (typeof parent._touch === "function") parent._touch();
  node.parentNode = null;
}

function attach(node, parent) {
  node.parentNode = parent;
  node._attaches = (node._attaches || 0) + 1;
  recordOp(node, "insert", {});
}

export function makeElement(id = "", tagName = "div", trace = null) {
  const childNodes = [];
  const attrs = new Map();
  const listeners = new Map();
  const lower = String(tagName || "div").toLowerCase();
  let htmlCache = "";
  let hasCache = false;
  let dirty = false;

  const node = {
    nodeType: 1,
    id: id || "",
    tagName: lower.toUpperCase(),
    className: "",
    hidden: false,
    disabled: false,
    checked: false,
    value: "",
    title: "",
    type: "",
    open: false,
    parentNode: null,
    dataset: {},
    _uid: nextUid(),
    _trace: trace,
    _detaches: 0,
    _attaches: 0,
    style: { setProperty() {}, getPropertyValue: () => "" },
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    clientWidth: 900,
    offsetHeight: 0,
    _attrs: attrs,
    _text: "",
    classList: null,
    get childNodes() {
      return childNodes;
    },
    get children() {
      return childNodes.filter((child) => child.nodeType === 1);
    },
    get firstElementChild() {
      return node.children[0] || null;
    },
    get lastElementChild() {
      const items = node.children;
      return items[items.length - 1] || null;
    },
    get nextSibling() {
      if (!node.parentNode) return null;
      const list = node.parentNode.childNodes;
      const index = list.indexOf(node);
      return index === -1 ? null : list[index + 1] || null;
    },
    get nextElementSibling() {
      if (!node.parentNode) return null;
      const siblings = node.parentNode.children;
      const index = siblings.indexOf(node);
      return index === -1 ? null : siblings[index + 1] || null;
    },
    get innerHTML() {
      if (!dirty && hasCache) return htmlCache;
      return childNodes.map(serializeNode).join("");
    },
    set innerHTML(value) {
      htmlCache = value == null ? "" : String(value);
      hasCache = true;
      dirty = false;
      for (const child of childNodes.slice()) detach(child, "innerHTML");
      childNodes.length = 0;
      for (const child of parseHtml(htmlCache, node._trace)) {
        child.parentNode = node;
        childNodes.push(child);
      }
    },
    get textContent() {
      if (!childNodes.length) return node._text;
      return childNodes.map((child) => child.textContent || "").join("");
    },
    set textContent(value) {
      node._text = value == null ? "" : String(value);
      for (const child of childNodes.slice()) detach(child, "textContent");
      childNodes.length = 0;
      htmlCache = "";
      hasCache = false;
      dirty = true;
    },
    get innerText() {
      return node.textContent;
    },
    set innerText(value) {
      node.textContent = value;
    },
    _touch() {
      dirty = true;
    },
    appendChild(child) {
      detach(child, "appendChild");
      childNodes.push(child);
      attach(child, node);
      dirty = true;
      return child;
    },
    insertBefore(child, before) {
      detach(child, "insertBefore");
      const index = before ? childNodes.indexOf(before) : -1;
      if (index === -1) childNodes.push(child);
      else childNodes.splice(index, 0, child);
      attach(child, node);
      dirty = true;
      return child;
    },
    removeChild(child) {
      detach(child, "removeChild");
      dirty = true;
      return child;
    },
    remove() {
      detach(node, "remove");
    },
    replaceWith(next) {
      const parent = node.parentNode;
      if (!parent || !next) return;
      const list = parent.childNodes;
      const index = list.indexOf(node);
      // 传统 DOM：先把要插入的节点摘下（如果它已连接），再把旧节点移除，最后插入。
      detach(next, "replaceWith");
      detach(node, "replaceWith");
      if (index === -1) list.push(next);
      else list.splice(index, 0, next);
      attach(next, parent);
      if (typeof parent._touch === "function") parent._touch();
    },
    contains(child) {
      for (let current = child; current; current = current.parentNode) {
        if (current === node) return true;
      }
      return false;
    },
    querySelector(selector) {
      return queryAll(node, selector)[0] || null;
    },
    querySelectorAll(selector) {
      return queryAll(node, selector);
    },
    closest(selector) {
      const compounds = String(selector || "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map(parseCompound);
      for (let current = node; current && current.nodeType === 1; current = current.parentNode) {
        if (compounds.some((compound) => matchesCompound(current, compound))) return current;
      }
      return null;
    },
    getAttribute(name) {
      return attrs.has(name) ? attrs.get(name) : null;
    },
    hasAttribute(name) {
      return attrs.has(name);
    },
    setAttribute(name, value) {
      const text = value == null ? "" : String(value);
      attrs.set(name, text);
      if (name === "class") node.className = text;
      else if (name === "id") node.id = text;
      else if (name === "hidden") node.hidden = true;
      else if (name.startsWith("data-")) node.dataset[datasetKey(name)] = text;
    },
    removeAttribute(name) {
      attrs.delete(name);
      if (name === "class") node.className = "";
      else if (name === "hidden") node.hidden = false;
      else if (name.startsWith("data-")) delete node.dataset[datasetKey(name)];
    },
    addEventListener(type, fn) {
      const list = listeners.get(type) || [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      const index = list.indexOf(fn);
      if (index !== -1) list.splice(index, 1);
    },
    emit(type, event) {
      const payload = event || {};
      if (!payload.target) payload.target = node;
      if (!payload.preventDefault) payload.preventDefault = () => {};
      if (!payload.stopPropagation) payload.stopPropagation = () => {};
      for (const fn of listeners.get(type) || []) fn(payload);
      return payload;
    },
    click() {
      return node.emit("click");
    },
    focus() {},
    blur() {},
    select() {},
    getBoundingClientRect() {
      return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
    },
    scrollIntoView() {},
    scrollTo() {},
  };
  node.classList = makeClassList(node);
  return node;
}

function serializeNode(node) {
  if (node.nodeType === 3) return escapeText(node.textContent);
  const tag = node.tagName.toLowerCase();
  let out = "<" + tag;
  for (const [name, value] of node._attrs || []) {
    out += value === "" ? " " + name : ' ' + name + '="' + escapeAttr(value) + '"';
  }
  if (node.className && !(node._attrs && node._attrs.has("class"))) {
    out += ' class="' + escapeAttr(node.className) + '"';
  }
  if (node.hidden && !(node._attrs && node._attrs.has("hidden"))) out += " hidden";
  if (VOID_TAGS.has(tag)) return out + ">";
  out += ">";
  out += (node.childNodes || []).map(serializeNode).join("");
  return out + "</" + tag + ">";
}

function tagEnd(source, start) {
  let quote = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const ch = source[index];
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") return index;
  }
  return -1;
}

function parseAttrs(text, element) {
  const re = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = re.exec(text))) {
    const value = match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4] !== undefined ? match[4] : "";
    element.setAttribute(match[1], decodeEntities(value));
  }
}

function parseHtml(html, trace = null) {
  const roots = [];
  const stack = [{ childNodes: roots }];
  const source = String(html == null ? "" : html);
  let index = 0;

  const pushText = (text) => {
    if (!text) return;
    const parent = stack[stack.length - 1];
    const textNode = makeTextNode(decodeEntities(text), trace);
    textNode.parentNode = parent;
    parent.childNodes.push(textNode);
  };

  while (index < source.length) {
    const lt = source.indexOf("<", index);
    if (lt === -1) {
      pushText(source.slice(index));
      break;
    }
    if (lt > index) pushText(source.slice(index, lt));
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      index = end === -1 ? source.length : end + 3;
      continue;
    }
    const gt = tagEnd(source, lt);
    if (gt === -1) {
      pushText(source.slice(lt));
      break;
    }
    const raw = source.slice(lt + 1, gt).trim();
    index = gt + 1;
    if (!raw) continue;
    if (raw[0] === "/") {
      const name = raw.slice(1).trim().toLowerCase();
      for (let depth = stack.length - 1; depth >= 1; depth -= 1) {
        if (stack[depth].tagName.toLowerCase() === name) {
          stack.length = depth;
          break;
        }
      }
      continue;
    }
    if (raw[0] === "!" || raw[0] === "?") continue;
    const selfClose = raw.endsWith("/");
    const body = selfClose ? raw.slice(0, -1) : raw;
    const match = /^([a-zA-Z][\w:-]*)([\s\S]*)$/.exec(body);
    if (!match) continue;
    const element = makeElement("", match[1], trace);
    parseAttrs(match[2], element);
    const parent = stack[stack.length - 1];
    element.parentNode = parent;
    parent.childNodes.push(element);
    if (!selfClose && !VOID_TAGS.has(match[1].toLowerCase())) stack.push(element);
  }
  return roots;
}

function parseCompound(selector) {
  const compound = { tag: null, classes: [], attrs: [] };
  let index = 0;
  while (index < selector.length) {
    const ch = selector[index];
    if (ch === ".") {
      const match = /^\.([\w-]+)/.exec(selector.slice(index));
      if (!match) {
        index += 1;
        continue;
      }
      compound.classes.push(match[1]);
      index += match[0].length;
      continue;
    }
    if (ch === "[") {
      const end = selector.indexOf("]", index);
      if (end === -1) break;
      const inner = selector.slice(index + 1, end).trim();
      const match = /^([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]]*)))?$/.exec(inner);
      if (match) {
        compound.attrs.push({
          name: match[1],
          value: match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4],
        });
      }
      index = end + 1;
      continue;
    }
    if (ch === "*") {
      index += 1;
      continue;
    }
    if (/[a-zA-Z]/.test(ch)) {
      const match = /^[a-zA-Z][\w-]*/.exec(selector.slice(index));
      compound.tag = match[0].toLowerCase();
      index += match[0].length;
      continue;
    }
    index += 1;
  }
  return compound;
}

function matchesCompound(node, compound) {
  if (compound.tag && String(node.tagName || "").toLowerCase() !== compound.tag) return false;
  const classes = String(node.className || "").split(/\s+/).filter(Boolean);
  for (const name of compound.classes) {
    if (!classes.includes(name)) return false;
  }
  for (const attr of compound.attrs) {
    if (!node.hasAttribute(attr.name)) return false;
    if (attr.value !== undefined && node.getAttribute(attr.name) !== attr.value) return false;
  }
  return true;
}

function collectElements(base) {
  const found = [];
  const walk = (parent) => {
    for (const child of parent.childNodes || []) {
      if (child.nodeType === 1) {
        found.push(child);
        walk(child);
      }
    }
  };
  walk(base);
  return found;
}

function queryAll(root, selector) {
  const results = [];
  const groups = String(selector || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  for (const group of groups) {
    const parts = group.split(/\s+/).filter(Boolean);
    let bases = [root];
    for (const part of parts) {
      const compound = parseCompound(part);
      const next = [];
      for (const base of bases) {
        for (const element of collectElements(base)) {
          if (matchesCompound(element, compound) && !next.includes(element)) next.push(element);
        }
      }
      bases = next;
    }
    for (const element of bases) {
      if (!results.includes(element)) results.push(element);
    }
  }
  return results;
}

function makeDocument() {
  const elements = new Map();
  const trace = { ops: [], root: null };
  const documentElement = makeElement("html", "html", trace);
  const body = makeElement("body", "body", trace);
  documentElement.appendChild(body);
  trace.root = documentElement;
  return {
    documentElement,
    body,
    trace,
    activeElement: body,
    visibilityState: "visible",
    title: "",
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id, "div", trace));
      return elements.get(id);
    },
    createElement(tag) {
      return makeElement("", tag || "div", trace);
    },
    createTextNode(text) {
      return makeTextNode(text, trace);
    },
    querySelector(selector) {
      return queryAll(documentElement, selector)[0] || null;
    },
    querySelectorAll(selector) {
      return queryAll(documentElement, selector);
    },
    addEventListener() {},
    removeEventListener() {},
    hasFocus() {
      return true;
    },
  };
}

/**
 * Load the real public/js/app.js with a stub DOM. Returns the app internals so
 * tests can drive the actual event/rename/refresh paths without a browser.
 */
export function loadApp({ fetch: fetchImpl } = {}) {
  const document = makeDocument();
  const media = { matches: false, addEventListener() {}, removeEventListener() {} };
  const window = {
    innerWidth: 1200,
    innerHeight: 900,
    devicePixelRatio: 2,
    matchMedia: () => media,
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    location: { href: "http://localhost/" },
    visualViewport: null,
  };
  const localStorage = {
    store: new Map(),
    getItem(key) {
      return this.store.has(key) ? this.store.get(key) : null;
    },
    setItem(key, value) {
      this.store.set(key, String(value));
    },
    removeItem(key) {
      this.store.delete(key);
    },
  };
  const calls = [];
  const fetch = async (path, options) => {
    calls.push({ path, options });
    if (!fetchImpl) throw new Error("unexpected fetch " + path);
    return fetchImpl(path, options);
  };
  const context = {
    console,
    renderMarkdown,
    escapeHtml,
    parseSkillBlock,
    parseAttachmentBlock,
    PHASE,
    connectionLabel,
    createTaskState,
    describeTask,
    reduceTaskState,
    shouldNotifyDone,
    document,
    window,
    localStorage,
    fetch,
    navigator: { clipboard: { writeText: async () => {} }, serviceWorker: null, permissions: null },
    EventSource: class {
      constructor() {
        this.readyState = 0;
      }
      addEventListener() {}
      close() {}
    },
    AbortController,
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    Blob,
    File: globalThis.File || class {},
    FormData,
    Headers,
    Response,
    Request,
    structuredClone,
    crypto: globalThis.crypto,
    setTimeout: unrefTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (fn) => {
      fn(0);
      return 0;
    },
    cancelAnimationFrame() {},
    matchMedia: () => media,
    alert() {},
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(appSource(), context, { filename: "public/js/app.js" });
  const app = context.__app;
  if (!app) throw new Error("app internals were not exposed");
  // 把消息容器挂到文档里，结构变更记录才能判断节点是否仍然连接。
  if (app.el && app.el.messages && !app.el.messages.parentNode) {
    document.body.appendChild(app.el.messages);
  }
  return { ...app, document, window, localStorage, navigator: context.navigator, fetchCalls: calls, trace: document.trace };
}

/** Minimal fetch Response for app.js api(). */
export function jsonResponse(data, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Labels rendered in the sidebar list, in order. */
export function sidebarLabels(app) {
  const html = app.el.sessionList.innerHTML;
  const labels = [];
  const re = /<span class="t">([\s\S]*?)<\/span>/g;
  let match;
  while ((match = re.exec(html))) labels.push(decodeHtml(match[1]));
  return labels;
}

export function decodeHtml(text) {
  return String(text)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export { escapeHtml, renderMarkdown, PHASE, connectionLabel, createTaskState, describeTask, reduceTaskState, shouldNotifyDone };
