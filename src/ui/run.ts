import * as vscode from "vscode";
import type { Core } from "../core";

export type Hub = { onToolCall?: (name: string) => void };

/** Runs one agent request with a cancellable progress notification. Never throws. */
export async function runWithProgress(
  deps: { getCore(): Promise<Core>; setRunning(b: boolean): void; hub: Hub; afterRun(): void },
  prompt: string,
  title: string,
): Promise<void> {
  let core: Core;
  try { core = await deps.getCore(); } catch (e) { void vscode.window.showErrorMessage(explainStartError(e)); return; }
  deps.setRunning(true);
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
      token.onCancellationRequested(() => { void core.runner.cancel(); });
      deps.hub.onToolCall = (name) => progress.report({ message: name });
      const r = await core.runner.run(prompt);
      if (r.status === "cancelled") void vscode.window.showInformationMessage("Forge: cancelled. Nothing half-applied; use Undo if a change was already applied.");
      else if (r.status === "error") void vscode.window.showErrorMessage("Forge: the run failed (see the Forge Agent panel for details). No files were changed unless you accepted hunks.");
    });
  } finally {
    deps.hub.onToolCall = undefined;
    deps.setRunning(false);
    deps.afterRun();
  }
}

export function explainStartError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(m))
    return `Forge: cannot reach TrueForge. Start it with: OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' npx @truefoundry/trueforge@latest (then check forgeAgent.baseUrl). (${m})`;
  return `Forge: ${m}`;
}
