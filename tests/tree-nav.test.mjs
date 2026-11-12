import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FileAccessError } from "../lib/files.js";
import {
  ALTERNATE_SUFFIX,
  RETRY_WARNING,
  TREE_COMMAND_NAME,
  TREE_EXTENSION_PATH,
  branchTitle,
  expectedLeafAfterNavigate,
  extractPrompt,
  fileFingerprint,
  findUserEntry,
  reservedTreeCommand,
  resolveTreeCommand,
  sessionBusyReason,
  treeCommandMessage,
} from "../lib/tree-nav.js";

describe("tree-nav helpers", () => {
  it("builds a safe slash command and rejects injection", () => {
    assert.equal(treeCommandMessage(TREE_COMMAND_NAME, "u1"), "/easy-pi-webui-tree u1");
    assert.equal(reservedTreeCommand("/easy-pi-webui-tree u1"), TREE_COMMAND_NAME);
    assert.equal(reservedTreeCommand("/easy-pi-webui-tree:1 abc"), "easy-pi-webui-tree:1");
    assert.equal(reservedTreeCommand("please /easy-pi-webui-tree u1"), null);
    assert.throws(() => treeCommandMessage(TREE_COMMAND_NAME, "u1; rm -rf /"), FileAccessError);
    assert.throws(() => treeCommandMessage("tree navi", "u1"), FileAccessError);
    assert.throws(() => treeCommandMessage(TREE_COMMAND_NAME, "u1\n/other"), FileAccessError);
  });

  it("resolves the tree command only from the bundled extension path", () => {
    const commands = [
      { name: TREE_COMMAND_NAME, source: "extension", sourceInfo: { path: TREE_EXTENSION_PATH } },
    ];
    assert.equal(resolveTreeCommand(commands), TREE_COMMAND_NAME);
    assert.throws(() => resolveTreeCommand([]), FileAccessError);
    assert.throws(() => resolveTreeCommand([
      { name: TREE_COMMAND_NAME, source: "extension", sourceInfo: { path: "/tmp/other-ext.ts" } },
    ]), FileAccessError);
    const suffixed = resolveTreeCommand([
      { name: TREE_COMMAND_NAME + ":1", source: "extension", sourceInfo: { path: TREE_EXTENSION_PATH } },
    ]);
    assert.equal(suffixed, TREE_COMMAND_NAME + ":1");
    assert.match(RETRY_WARNING, /不会自动回滚/);
  });

  it("extracts prompts, keeps images, and refuses incomplete attachments", () => {
    const ok = extractPrompt({
      message: {
        role: "user",
        content: [
          { type: "text", text: "看这张图" },
          { type: "image", mimeType: "image/png", data: "QUFB" },
        ],
      },
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.text, "看这张图");
    assert.equal(ok.images.length, 1);
    assert.equal(ok.images[0].data, "QUFB");

    const missing = extractPrompt({
      message: { role: "user", content: [{ type: "image", mimeType: "image/png" }] },
    });
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /附件不完整/);
  });

  it("finds the user prompt behind an assistant reply and computes the parent leaf", () => {
    const entries = [
      { id: "mc", parentId: "", type: "model_change" },
      { id: "u1", parentId: "mc", type: "message", message: { role: "user", content: "请安装 nginx" } },
      { id: "tr1", parentId: "u1", type: "message", message: { role: "toolResult", content: "ok" } },
      { id: "a1", parentId: "tr1", type: "message", message: { role: "assistant", content: "装好了" } },
    ];
    const user = findUserEntry(entries, "a1", "assistant");
    assert.equal(user.id, "u1");
    assert.equal(expectedLeafAfterNavigate(user), "mc");
    assert.throws(() => findUserEntry(entries, "nope", "assistant"), FileAccessError);
  });

  it("explains busy states and titles an alternate session", () => {
    assert.match(sessionBusyReason({ streaming: true }), /进行/);
    assert.match(sessionBusyReason({ compacting: true }), /进行/);
    assert.match(sessionBusyReason({ pendingUi: true }), /确认/);
    assert.equal(sessionBusyReason({}), "");
    assert.equal(branchTitle("整理会议", ALTERNATE_SUFFIX), "整理会议 · 另一分支");
    const dir = mkdtempSync(join(tmpdir(), "tree-nav-fp-"));
    const file = join(dir, "a.jsonl");
    writeFileSync(file, "hello\n");
    const fp = fileFingerprint(file);
    assert.equal(fp.size, 6);
    assert.equal(fp.hash.length, 64);
  });
});
