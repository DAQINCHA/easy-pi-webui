import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { escapeHtml, renderMarkdown } from "../../public/js/markdown.js";
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
    "  rememberSessionName: typeof rememberSessionName === 'function' ? rememberSessionName : undefined,\n" +
    "  applySessionList: typeof applySessionList === 'function' ? applySessionList : undefined,\n" +
    "  nextSessionsSeq: typeof nextSessionsSeq === 'function' ? nextSessionsSeq : undefined,\n" +
    "  sessionNames: typeof sessionNames !== 'undefined' ? sessionNames : undefined,\n" +
    "};\n";
}

function unrefTimeout(fn, ms, ...args) {
  const timer = setTimeout(fn, ms, ...args);
  timer.unref?.();
  return timer;
}

function makeClassList() {
  const set = new Set();
  return {
    add: (...names) => names.forEach((name) => set.add(name)),
    remove: (...names) => names.forEach((name) => set.delete(name)),
    contains: (name) => set.has(name),
    toggle: (name, force) => {
      const on = force === undefined ? !set.has(name) : Boolean(force);
      if (on) set.add(name);
      else set.delete(name);
      return on;
    },
    values: () => [...set],
  };
}

export function makeElement(id = "") {
  const children = [];
  const node = {
    id,
    tagName: "DIV",
    className: "",
    innerHTML: "",
    textContent: "",
    innerText: "",
    value: "",
    hidden: false,
    disabled: false,
    checked: false,
    parentNode: null,
    dataset: {},
    style: {},
    classList: makeClassList(),
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    clientWidth: 900,
    offsetHeight: 0,
    get children() {
      return children;
    },
    get firstElementChild() {
      return children[0] || null;
    },
    get lastElementChild() {
      return children[children.length - 1] || null;
    },
    get nextElementSibling() {
      const siblings = node.parentNode ? node.parentNode.children : [];
      const index = siblings.indexOf(node);
      return index === -1 ? null : siblings[index + 1] || null;
    },
    appendChild(child) {
      child.parentNode = node;
      children.push(child);
      return child;
    },
    insertBefore(child, before) {
      child.parentNode = node;
      const index = before ? children.indexOf(before) : -1;
      if (index === -1) children.push(child);
      else children.splice(index, 0, child);
      return child;
    },
    removeChild(child) {
      const index = children.indexOf(child);
      if (index !== -1) children.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    remove() {
      if (node.parentNode) node.parentNode.removeChild(node);
    },
    contains(child) {
      for (let current = child; current; current = current.parentNode) {
        if (current === node) return true;
      }
      return false;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
    getAttribute() {
      return null;
    },
    setAttribute() {},
    removeAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    blur() {},
    select() {},
    click() {},
    getBoundingClientRect() {
      return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
    },
    scrollIntoView() {},
    scrollTo() {},
  };
  return node;
}

function makeDocument() {
  const elements = new Map();
  const documentElement = makeElement("html");
  const body = makeElement("body");
  return {
    documentElement,
    body,
    activeElement: body,
    visibilityState: "visible",
    title: "",
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    createElement(tag) {
      const node = makeElement("");
      node.tagName = String(tag || "div").toUpperCase();
      return node;
    },
    createTextNode(text) {
      return { textContent: String(text) };
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
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
  return { ...app, document, window, localStorage, fetchCalls: calls };
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
