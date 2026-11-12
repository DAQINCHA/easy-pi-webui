/**
 * Official-extension bridge for easy-pi-webui.
 * Loaded only via `pi --extension` with an absolute path to this file.
 * Registers a slash command that calls navigateTree in the current session.
 * Does not write to stdout (RPC JSONL must stay clean) and does not send prompts.
 */
const COMMAND = "easy-pi-webui-tree";
const ENTRY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export default function (pi: { registerCommand: Function }) {
  pi.registerCommand(COMMAND, {
    description: "Internal WebUI tree navigation. Use the Edit / Retry buttons instead.",
    handler: async (args: string, ctx: {
      isIdle?: () => boolean;
      hasPendingMessages?: () => boolean;
      navigateTree: (id: string, options?: { summarize?: boolean }) => Promise<{ cancelled?: boolean; aborted?: boolean }>;
    }) => {
      const entryId = String(args || "").trim();
      if (!ENTRY_RE.test(entryId)) {
        throw new Error("invalid entry id");
      }
      if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
        throw new Error("session is busy");
      }
      if (typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages()) {
        throw new Error("session is busy");
      }
      const result = await ctx.navigateTree(entryId, { summarize: false });
      if (result && (result.cancelled || result.aborted)) {
        throw new Error("tree navigation cancelled");
      }
    },
  });
}
