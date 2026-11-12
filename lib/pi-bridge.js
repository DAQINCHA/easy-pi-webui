import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { TREE_EXTENSION_PATH } from "./tree-nav.js";

const EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", homedir() + "/.local/bin", homedir() + "/.pi/agent/bin"];

export function buildEnv() {
  const env = { ...process.env };
  const parts = String(env.PATH || "").split(":").filter(Boolean);
  for (const dir of EXTRA_PATH) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  env.PATH = parts.join(":");
  return env;
}

let pendingSeq = 0;

/**
 * One pi process in RPC mode. Speaks JSONL on stdin/stdout and keeps a small
 * replay buffer so a browser that reconnects does not lose streamed deltas.
 */
export class PiBridge extends EventEmitter {
  constructor({ cwd, sessionFile = null, extensionPath = TREE_EXTENSION_PATH } = {}) {
    super();
    this.cwd = cwd;
    this.sessionFile = sessionFile;
    this.extensionPath = extensionPath;
    this.key = null;
    this.child = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.events = [];
    this.seq = 0;
    this.stderrTail = "";
    this.exited = false;
    this.intentionalClose = false;
    this.lastActivity = Date.now();
  }

  start() {
    const bin = process.env.PI_BIN || "pi";
    const args = ["--mode", "rpc"];
    if (this.sessionFile) args.push("--session", this.sessionFile);
    // Load the repo-bundled tree command without --no-ext, so user extensions stay enabled.
    const extension = this.extensionPath || TREE_EXTENSION_PATH;
    if (extension && existsSync(extension) && process.env.PI_NO_TREE_EXTENSION !== "1") {
      args.push("--extension", extension);
    }

    this.child = spawn(bin, args, {
      cwd: this.cwd,
      env: buildEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.on("data", (chunk) => this.#onStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-8000);
      this.emit("stderr", chunk.toString("utf8"));
    });
    this.child.on("error", (error) => this.#failAll(error));
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      this.#failAll(new Error(`pi exited (${code ?? signal})`));
      this.emit("exit", { code, signal, stderr: this.stderrTail, intentional: this.intentionalClose });
    });

    return this;
  }

  #onStdout(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let index;
    while ((index = this.buffer.indexOf(10)) !== -1) {
      let line = this.buffer.subarray(0, index).toString("utf8");
      this.buffer = this.buffer.subarray(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        this.emit("stderr", "unparseable record: " + line.slice(0, 200) + "\n");
        continue;
      }
      this.#handleRecord(record);
    }
  }

  #handleRecord(record) {
    this.lastActivity = Date.now();

    if (record.type === "response" && record.id && this.pending.has(record.id)) {
      const { resolve, timer } = this.pending.get(record.id);
      clearTimeout(timer);
      this.pending.delete(record.id);
      resolve(record);
      return;
    }

    this.emit("record", this.#push(record));
  }

  #push(record) {
    const item = { seq: ++this.seq, record };
    this.events.push(item);
    if (this.events.length > 1200) this.events.splice(0, this.events.length - 1200);
    return item;
  }

  eventsSince(lastSeq) {
    if (!lastSeq) return [];
    return this.events.filter((item) => item.seq > lastSeq);
  }

  send(command, timeoutMs = 45000) {
    if (!this.child || this.exited) return Promise.reject(new Error("pi process is not running"));
    const id = command.id || `c${++pendingSeq}`;
    const payload = { ...command, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`command timed out: ${command.type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      const ok = this.child.stdin.write(JSON.stringify(payload) + "\n", "utf8");
      if (!ok) this.child.stdin.once("drain", () => {});
    });
  }

  async respondUi(id, payload) {
    return this.send({ type: "extension_ui_response", id, ...payload });
  }

  #failAll(error) {
    for (const [id, { reject, timer }] of this.pending) {
      clearTimeout(timer);
      reject(error);
      this.pending.delete(id);
    }
  }

  dispose() {
    if (!this.child || this.exited) return;
    this.intentionalClose = true;
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    const child = this.child;
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, 2500);
    timer.unref?.();
    child.once("exit", () => clearTimeout(timer));
  }
}