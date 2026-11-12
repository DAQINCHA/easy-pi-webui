#!/usr/bin/env node
/**
 * Minimal pi --mode rpc stand-in for tests. Never talks to a model.
 * Logs JSONL commands to FAKEPI_LOG when set.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write("fake-pi 0.0.0-test\n");
  process.exit(0);
}

if (process.argv.includes("--print")) {
  process.stdout.write("测试标题\n");
  process.exit(0);
}

if (!process.argv.includes("--mode") && !process.argv.includes("rpc")) {
  // allow `pi --mode rpc` only; other invocations stay quiet
}

const sessionId = process.env.FAKEPI_SESSION_ID || "fake-session-1";
const sessionFile = process.env.FAKEPI_SESSION_FILE || "";
const logFile = process.env.FAKEPI_LOG || "";

function logCommand(record) {
  if (!logFile) return;
  mkdirSync(dirname(logFile), { recursive: true });
  appendFileSync(logFile, JSON.stringify(record) + "\n");
}

function reply(id, data = {}) {
  process.stdout.write(JSON.stringify({ type: "response", id, success: true, data }) + "\n");
}

function handle(record) {
  if (!record || typeof record !== "object") return;
  logCommand(record);
  const id = record.id || "unknown";
  switch (record.type) {
    case "get_state":
      return reply(id, { sessionId, sessionFile, thinkingLevel: "off" });
    case "get_messages":
      return reply(id, { messages: [] });
    case "get_session_stats":
      return reply(id, {});
    case "get_available_models":
      return reply(id, { models: [] });
    case "get_available_thinking_levels":
      return reply(id, { levels: ["off"] });
    case "get_commands":
      return reply(id, { commands: [] });
    case "get_fork_messages":
      return reply(id, { messages: [] });
    case "prompt":
    case "steer":
    case "follow_up":
    case "abort":
    case "set_model":
    case "set_thinking_level":
    case "set_session_name":
    case "compact":
      return reply(id, { disposition: "started" });
    default:
      return reply(id, {});
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line));
  } catch {
    process.stderr.write("fake-pi: bad json\n");
  }
});
