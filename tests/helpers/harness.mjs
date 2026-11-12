import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");
export const FAKE_PI = join(HERE, "fake-pi.mjs");

export async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.on("error", reject);
  });
}

export function makeTempHome() {
  const dir = mkdtempSync(join(tmpdir(), "easy-pi-webui-test-"));
  mkdirSync(join(dir, "home"), { recursive: true });
  mkdirSync(join(dir, "ws"), { recursive: true });
  mkdirSync(join(dir, "sessions"), { recursive: true });
  return {
    dir,
    home: join(dir, "home"),
    workspace: join(dir, "ws"),
    sessions: join(dir, "sessions"),
    log: join(dir, "fakepi.log"),
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function startServer(opts = {}) {
  const envHome = makeTempHome();
  const port = opts.port || await freePort();
  if (port === 30142) throw new Error("refusing to bind 30142");
  const workspace = opts.workspace || envHome.workspace;
  const env = {
    ...process.env,
    HOME: envHome.home,
    PORT: String(port),
    HOST: "127.0.0.1",
    PI_WORKSPACE: workspace,
    PI_BIN: opts.piBin || FAKE_PI,
    PI_AUTO_TITLE: "0",
    PI_SESSION_DIR: envHome.sessions,
    FAKEPI_LOG: envHome.log,
    FAKEPI_SESSION_ID: "fake-session-1",
    FAKEPI_SESSION_FILE: join(envHome.sessions, "fake.jsonl"),
  };
  delete env.PI_WEBUI_PORT;
  const child = spawn(process.execPath, [join(ROOT, "server.js"), "--port", String(port), "--host", "127.0.0.1", "--workspace", workspace], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server start timeout\n" + output)), 8000);
    const onData = () => {
      if (output.includes("listening on")) {
        clearTimeout(timer);
        resolve(true);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("server exited early " + code + "\n" + output));
    });
  });
  void ready;
  const base = `http://127.0.0.1:${port}`;
  return {
    port,
    base,
    envHome,
    workspace,
    child,
    async stop() {
      if (child.exitCode != null) {
        envHome.cleanup();
        return;
      }
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* ignore */ }
        }, 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        try { child.kill("SIGTERM"); } catch { resolve(); }
      });
      envHome.cleanup();
    },
  };
}

export async function upload(base, filename, body, headers = {}) {
  const res = await fetch(base + "/api/upload", {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-filename": encodeURIComponent(filename),
      ...headers,
    },
    body,
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

export async function fileReq(base, path, mode = "meta") {
  const url = base + "/api/file?path=" + encodeURIComponent(path) + "&mode=" + mode;
  const res = await fetch(url);
  const contentType = res.headers.get("content-type") || "";
  let data = null;
  if (contentType.includes("application/json")) data = await res.json();
  else data = Buffer.from(await res.arrayBuffer());
  return { res, data };
}
