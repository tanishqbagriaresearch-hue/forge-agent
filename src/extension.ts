import * as vscode from "vscode";
import path from "node:path";
import { createCore, undoLastChange, type Core } from "./core";
import { UndoStack } from "./workspace/snapshot";
import { readConfig } from "./config";
import { VscodeReview } from "./ui/review";
import { VscodeHost } from "./ui/vscodeHost";
import { AgentPanel } from "./ui/panel";
import { buildInlineEditPrompt } from "./ui/inlineEdit";
import { runWithProgress, explainStartError, isRunActive, type Hub } from "./ui/run";
import { parseMentions, expandMentions } from "./context/mentions";
import { upsertModelProvider, specFromProviderCfg } from "./forge/provision";
import { isIgnoredPath } from "./workspace/walk";
import type { RunEvents } from "./agent/runner";

let activeCore: Core | undefined;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const reg = (id: string, fn: (...a: any[]) => any) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    for (const id of ["forgeAgent.inlineEdit", "forgeAgent.openPanel", "forgeAgent.stop", "forgeAgent.undo", "forgeAgent.switchModel", "forgeAgent.hunk.toggle", "forgeAgent.review.apply", "forgeAgent.review.rejectAll"])
      reg(id, async () => { void vscode.window.showInformationMessage("Forge Agent: open a folder first."); });
    return;
  }
  const root = folder.uri.fsPath;
  const review = new VscodeReview(root);
  review.register(ctx);
  const host = new VscodeHost(root, review);
  const hub: Hub = {};
  const undoStack = new UndoStack(); // survives core restarts (settings changes)
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusBar.text = "$(tools) Forge";
  statusBar.tooltip = "Forge Agent";
  statusBar.command = "forgeAgent.openPanel";
  statusBar.show();
  ctx.subscriptions.push(statusBar);

  const setRunning = (r: boolean) => {
    void vscode.commands.executeCommand("setContext", "forgeAgent.running", r);
    statusBar.text = r ? "$(sync~spin) Forge: working — click to stop" : "$(tools) Forge";
    statusBar.command = r ? "forgeAgent.stop" : "forgeAgent.openPanel";
  };

  let panel: AgentPanel;
  const events: RunEvents = {
    delta: (text) => panel.post({ type: "delta", text }),
    toolCall: (name, args) => { hub.onToolCall?.(name); panel.post({ type: "toolCall", name, args }); },
    toolResult: (name, text) => panel.post({ type: "toolResult", name, text }),
    status: (status, detail) => panel.post({ type: "status", status, detail }),
    notice: (text) => panel.post({ type: "notice", text }),
  };

  let starting: Promise<Core> | undefined;
  const orderedModels = () => {
    const cfg = readConfig();
    const saved = ctx.workspaceState.get<string>("forgeAgent.model");
    return saved && cfg.models.includes(saved) ? [saved, ...cfg.models.filter((m) => m !== saved)] : cfg.models;
  };
  const getCore = (): Promise<Core> =>
    (starting ??= (async () => {
      const cfg = readConfig();
      if (!cfg.models.length) throw new Error('set "forgeAgent.models" to one or more TrueForge model references (provider/name)');
      for (const p of cfg.providers) {
        const apiKey = p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined;
        if (p.apiKeyEnv && !apiKey) { events.notice(`Skipping provider ${p.provider}: environment variable ${p.apiKeyEnv} is not set.`); continue; }
        await upsertModelProvider(cfg.baseUrl, specFromProviderCfg(p, apiKey));
      }
      const core = await createCore({
        host, undo: undoStack, baseUrl: cfg.baseUrl, models: orderedModels(), events, mcpPort: cfg.mcpPort, tokenBudget: cfg.tokenBudget,
        onActivity: (a) => panel.post({ type: "activity", ...a }),
        autoApproveCommands: cfg.autoApproveCommands.map((r) => new RegExp(r)),
      });
      activeCore = core;
      panel.post({ type: "models", models: orderedModels(), current: orderedModels()[0] });
      return core;
    })().catch((e) => { starting = undefined; throw e; }));

  const afterRun = () => panel.post({ type: "undoState", size: undoStack.size() });
  const deps = { getCore, setRunning, hub, afterRun };

  panel = new AgentPanel(ctx.extensionUri, {
    send: async (text) => {
      if (isRunActive()) { panel.post({ type: "notice", text: "Forge is already working on a request; stop it first or wait for it to finish." }); return; }
      let prompt = text;
      try {
        const core = await getCore();
        const m = parseMentions(text);
        const extra = await expandMentions(m, core.index, root, Math.floor(readConfig().tokenBudget / 2));
        if (extra) prompt = `${text}\n\n${extra}`;
      } catch (e) { panel.post({ type: "notice", text: explainStartError(e) }); return; }
      panel.post({ type: "user", text });
      await runWithProgress(deps, prompt, "Forge Agent");
    },
    stop: () => { void activeCore?.runner.cancel(); },
    undo: () => { void vscode.commands.executeCommand("forgeAgent.undo"); },
    setModel: (m) => { void ctx.workspaceState.update("forgeAgent.model", m); activeCore?.runner.switchPrimary(m); },
  });
  ctx.subscriptions.push(vscode.window.registerWebviewViewProvider(AgentPanel.viewType, panel, { webviewOptions: { retainContextWhenHidden: true } }));

  reg("forgeAgent.openPanel", () => vscode.commands.executeCommand("workbench.view.extension.forge-agent"));
  reg("forgeAgent.inlineEdit", async () => {
    const prompt = await buildInlineEditPrompt(root);
    if (prompt) await runWithProgress(deps, prompt, "Forge: editing selection");
  });
  reg("forgeAgent.stop", async () => { await activeCore?.runner.cancel(); });
  reg("forgeAgent.undo", async () => {
    const r = await undoLastChange(undoStack, host);
    void (r.ok ? vscode.window.showInformationMessage(r.message) : vscode.window.showWarningMessage(r.message));
    afterRun();
  });
  reg("forgeAgent.switchModel", async () => {
    const pick = await vscode.window.showQuickPick(readConfig().models, { placeHolder: "Primary model (TrueForge reference); the others stay as fallbacks" });
    if (!pick) return;
    await ctx.workspaceState.update("forgeAgent.model", pick);
    activeCore?.runner.switchPrimary(pick);
    panel.post({ type: "models", models: orderedModels(), current: pick });
  });

  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  const upd = async (uri: vscode.Uri, del = false) => {
    const rel = path.relative(root, uri.fsPath).split(path.sep).join("/");
    if (!activeCore || rel.startsWith("..") || isIgnoredPath(rel)) return;
    activeCore.index.update(rel, del ? null : await host.readFile(uri.fsPath));
  };
  ctx.subscriptions.push(watcher, watcher.onDidChange((u) => void upd(u)), watcher.onDidCreate((u) => void upd(u)), watcher.onDidDelete((u) => void upd(u, true)),
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration("forgeAgent")) return;
      const old = activeCore; activeCore = undefined; starting = undefined;
      await old?.runner.cancel(); // never strand a running turn when its MCP server goes away
      await old?.close();
      void vscode.window.showInformationMessage("Forge Agent: configuration changed; it will reconnect on next use.");
    }));
}

export async function deactivate(): Promise<void> {
  const c = activeCore;
  activeCore = undefined;
  if (c) { await c.runner.cancel(); await c.close(); }
}
