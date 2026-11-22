import * as vscode from "vscode";
import path from "node:path";
import type { ReviewItem } from "../host";

const ORIG = "forge-original";
const PROP = "forge-proposed";

/** Per-hunk review: native diff editor per file + CodeLens to accept/reject each hunk. */
export class VscodeReview implements vscode.CodeLensProvider, vscode.TextDocumentContentProvider {
  private items = new Map<string, ReviewItem>();
  private accepted = new Map<string, Set<number>>();
  private finish: ((m: Map<string, Set<number>>) => void) | null = null;
  private lenses = new vscode.EventEmitter<void>();
  private contents = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChangeCodeLenses = this.lenses.event;
  readonly onDidChange = this.contents.event;
  private status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  constructor(private root: string) {}

  register(ctx: vscode.ExtensionContext): void {
    ctx.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(ORIG, this),
      vscode.workspace.registerTextDocumentContentProvider(PROP, this),
      vscode.languages.registerCodeLensProvider({ scheme: PROP }, this),
      vscode.commands.registerCommand("forgeAgent.hunk.toggle", (abs: string, id: number) => this.toggle(abs, id)),
      vscode.commands.registerCommand("forgeAgent.review.apply", () => this.apply()),
      vscode.commands.registerCommand("forgeAgent.review.rejectAll", () => this.rejectAll()),
      this.status,
    );
  }

  private rel(abs: string) { return path.relative(this.root, abs).split(path.sep).join("/"); }
  private uri(scheme: string, item: ReviewItem) { return vscode.Uri.from({ scheme, path: "/" + this.rel(item.abs), query: item.abs }); }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const item = this.items.get(uri.query);
    if (!item) return "";
    return uri.scheme === ORIG ? item.original ?? "" : item.proposed;
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const item = this.items.get(doc.uri.query);
    if (!item) return [];
    const acc = this.accepted.get(item.abs) ?? new Set<number>();
    const top = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
    const total = [...this.items.values()].reduce((n, i) => n + i.hunks.length, 0);
    const okCount = [...this.accepted.values()].reduce((n, s) => n + s.size, 0);
    const out = [
      new vscode.CodeLens(top, { title: `$(check-all) Apply ${okCount} of ${total} hunk(s)`, command: "forgeAgent.review.apply" }),
      new vscode.CodeLens(top, { title: "$(close-all) Reject all", command: "forgeAgent.review.rejectAll" }),
    ];
    for (const h of item.hunks) {
      const lead = Math.max(0, h.lines.findIndex((l) => l[0] !== " "));
      const line = Math.max(0, Math.min(doc.lineCount - 1, h.newStart - 1 + lead));
      const on = acc.has(h.id);
      out.push(new vscode.CodeLens(new vscode.Range(new vscode.Position(line, 0), new vscode.Position(line, 0)), {
        title: on ? `$(check) Hunk ${h.id}/${item.hunks.length} accepted — click to reject` : `$(circle-slash) Hunk ${h.id}/${item.hunks.length} rejected — click to accept`,
        command: "forgeAgent.hunk.toggle", arguments: [item.abs, h.id],
      }));
    }
    return out;
  }

  review(items: ReviewItem[], signal: AbortSignal): Promise<Map<string, Set<number>>> {
    this.finish?.(new Map());
    this.items = new Map(items.map((i) => [i.abs, i]));
    this.accepted = new Map(items.map((i) => [i.abs, new Set(i.hunks.map((h) => h.id))]));
    return new Promise((resolve) => {
      this.finish = (m) => { this.finish = null; void this.cleanup(); resolve(m); };
      if (signal.aborted) { this.finish(new Map()); return; }
      signal.addEventListener("abort", () => this.finish?.(new Map()), { once: true });
      this.updateStatus();
      void (async () => {
        for (const item of items) {
          if (!this.finish) return;
          await vscode.commands.executeCommand("vscode.diff", this.uri(ORIG, item), this.uri(PROP, item), `Forge: ${this.rel(item.abs)} — review hunks`, { preview: false });
        }
        this.lenses.fire();
        const choice = await vscode.window.showInformationMessage(
          `Forge Agent proposed changes in ${items.length} file(s). Accept or reject each hunk with the CodeLens above it, then apply.`, "Apply accepted", "Reject all");
        if (choice === "Apply accepted") this.apply(); else if (choice === "Reject all") this.rejectAll();
      })();
    });
  }

  private toggle(abs: string, id: number): void {
    const s = this.accepted.get(abs);
    if (!s) return;
    if (s.has(id)) s.delete(id); else s.add(id);
    this.updateStatus();
    this.lenses.fire();
  }

  private apply(): void { this.finish?.(new Map([...this.accepted].map(([k, v]) => [k, new Set(v)]))); }
  private rejectAll(): void { this.finish?.(new Map()); }

  private updateStatus(): void {
    const total = [...this.items.values()].reduce((n, i) => n + i.hunks.length, 0);
    const ok = [...this.accepted.values()].reduce((n, s) => n + s.size, 0);
    this.status.text = `$(git-pull-request) Forge review: ${ok}/${total} hunks accepted — click to apply`;
    this.status.command = "forgeAgent.review.apply";
    this.status.show();
  }

  private async cleanup(): Promise<void> {
    this.status.hide();
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputTextDiff && (t.input as vscode.TabInputTextDiff).modified.scheme === PROP);
    try { await vscode.window.tabGroups.close(tabs); } catch { /* tabs already closed */ }
    this.items = new Map();
    this.accepted = new Map();
    this.lenses.fire();
  }
}
