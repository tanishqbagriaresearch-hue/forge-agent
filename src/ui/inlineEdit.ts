import * as vscode from "vscode";
import path from "node:path";

/** Builds the scoped prompt for an inline edit of the current selection, or returns undefined when there is none. */
export async function buildInlineEditPrompt(root: string): Promise<string | undefined> {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.selection.isEmpty) {
    void vscode.window.showInformationMessage("Select some code first, then run Forge: Edit Selection.");
    return undefined;
  }
  const instruction = await vscode.window.showInputBox({
    prompt: "Forge: describe the change to the selected code",
    placeHolder: "e.g. Treat 'off' as false too, and update the docstring",
    ignoreFocusOut: true,
  });
  if (!instruction) return undefined;
  const sel = ed.selection;
  const startLine = sel.start.line + 1;
  const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
  const rel = path.relative(root, ed.document.uri.fsPath).split(path.sep).join("/");
  return `File: ${rel}\nLines ${startLine}-${endLine}:\n${ed.document.getText(sel)}\nInstruction: ${instruction}\nOnly edit inside this region unless the instruction requires otherwise.`;
}
