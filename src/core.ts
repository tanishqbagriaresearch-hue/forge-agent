import type { Host } from "./host";
import { Overlay } from "./workspace/overlay";
import { UndoStack } from "./workspace/snapshot";
import { ContextIndex } from "./context/index";
import { EditorTools, type Activity, type ReviewState } from "./mcp/tools";
import { startEditorMcp } from "./mcp/server";
import { AgentRunner, type RunEvents } from "./agent/runner";
import { upsertMcpServer } from "./forge/provision";
import type { TrueForgeLike } from "./forge/client";

export type CoreOptions = {
  host: Host; baseUrl: string; models: string[]; events: RunEvents;
  mcpName?: string; mcpPort?: number; tokenBudget?: number;
  onActivity?: (a: Activity) => void; autoApproveCommands?: RegExp[];
  retries?: number; baseMs?: number; client?: TrueForgeLike;
  /** Registers the MCP server with TrueForge. Defaults to upsertMcpServer. */
  provision?: (mcpUrl: string) => Promise<void>;
};

export type Core = {
  runner: AgentRunner; undo: UndoStack; index: ContextIndex; review: ReviewState; overlay: Overlay;
  mcpUrl: string; close(): Promise<void>;
  undoLast(): Promise<{ ok: boolean; message: string }>;
};

export async function createCore(o: CoreOptions): Promise<Core> {
  const { host } = o;
  const mcpName = o.mcpName ?? "forge-editor";
  const overlay = new Overlay((p) => host.readFile(p));
  const undo = new UndoStack();
  const index = await ContextIndex.build(host.root);
  const review: ReviewState = { decisions: null, signal: new AbortController().signal };
  const tools = new EditorTools({ host, overlay, undo, index, review, onActivity: o.onActivity ?? (() => {}), tokenBudget: o.tokenBudget ?? 6000 });
  const mcp = await startEditorMcp(tools, o.mcpPort ?? 0);
  await (o.provision ?? ((url: string) => upsertMcpServer(o.baseUrl, mcpName, url)))(mcp.url);
  const runner = new AgentRunner({
    baseUrl: o.baseUrl, models: o.models, mcpName, host, review, overlay, events: o.events, client: o.client,
    retries: o.retries, baseMs: o.baseMs, autoApproveCommands: o.autoApproveCommands,
  });

  async function undoLast() {
    const entry = undo.pop();
    if (!entry) return { ok: false, message: "Nothing to undo." };
    for (const f of entry.files) {
      if ((await host.readFile(f.abs)) !== f.after) {
        undo.push(entry);
        return { ok: false, message: `Cannot undo "${entry.label}": ${f.abs} has changed since the agent edited it.` };
      }
    }
    await host.applyFiles(entry.files.map((f) => ({ abs: f.abs, content: f.before })));
    return { ok: true, message: `Undid: ${entry.label}` };
  }

  return { runner, undo, index, review, overlay, mcpUrl: mcp.url, close: () => mcp.close(), undoLast };
}
