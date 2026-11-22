import * as vscode from "vscode";
import type { Host, ReviewItem } from "../host";
import type { VscodeReview } from "./review";

const aborted = (s: AbortSignal) => new Promise<undefined>((res) => s.addEventListener("abort", () => res(undefined), { once: true }));

export class VscodeHost implements Host {
  constructor(public root: string, private review: VscodeReview) {}

  async readFile(abs: string): Promise<string | null> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.uri.fsPath === abs);
    if (open) return open.getText();
    try { return Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(abs))).toString("utf8"); } catch { return null; }
  }

  /** One WorkspaceEdit for the whole batch, so it is atomic and also undoable with the editor's own Undo. */
  async applyFiles(files: { abs: string; content: string | null }[]): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    for (const f of files) {
      const uri = vscode.Uri.file(f.abs);
      if (f.content === null) { edit.deleteFile(uri, { ignoreIfNotExists: true }); continue; }
      if ((await this.readFile(f.abs)) === null) {
        edit.createFile(uri, { overwrite: true });
        edit.insert(uri, new vscode.Position(0, 0), f.content);
      } else {
        const doc = await vscode.workspace.openTextDocument(uri);
        edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), doc.positionAt(doc.getText().length)), f.content);
      }
    }
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error("VS Code rejected the workspace edit");
    for (const f of files) {
      if (f.content === null) continue;
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(f.abs));
      if (doc.isDirty) await doc.save();
    }
  }

  reviewChanges(items: ReviewItem[], signal: AbortSignal) { return this.review.review(items, signal); }

  async confirmCommand(cmd: string, signal: AbortSignal): Promise<boolean> {
    const pick = await Promise.race([
      vscode.window.showWarningMessage(`Forge Agent wants to run: ${cmd}`, "Run", "Deny"),
      aborted(signal),
    ]);
    return pick === "Run";
  }

  notify(kind: "info" | "error", msg: string): void {
    if (kind === "error") void vscode.window.showErrorMessage(msg); else void vscode.window.showInformationMessage(msg);
  }
}
