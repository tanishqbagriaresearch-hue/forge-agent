// Minimal fake of the `vscode` module, enough to activate the extension in unit tests.
type Cb = (...a: any[]) => any;
export const registered = new Map<string, Cb>();
export const executed: { cmd: string; args: any[] }[] = [];
export class Disposable { constructor(private f: () => void = () => {}) {} dispose() { this.f(); } static from(...d: { dispose(): any }[]) { return new Disposable(() => d.forEach((x) => x.dispose())); } }
export class EventEmitter<T> { private l: ((e: T) => any)[] = []; event = (f: (e: T) => any) => { this.l.push(f); return new Disposable(); }; fire(e: T) { this.l.forEach((f) => f(e)); } dispose() {} }
export class Position { constructor(public line: number, public character: number) {} }
export class Range { constructor(public start: Position, public end: Position) {} }
export class CodeLens { constructor(public range: Range, public command?: any) {} }
export const Uri = {
  file: (p: string) => ({ scheme: "file", fsPath: p, path: p, query: "", toString: () => "file://" + p }),
  from: (o: any) => ({ ...o, fsPath: o.path, toString: () => `${o.scheme}:${o.path}?${o.query ?? ""}` }),
  joinPath: (b: any, ...s: string[]) => Uri.file([b.fsPath, ...s].join("/")),
};
export enum StatusBarAlignment { Left = 1, Right = 2 }
export enum ProgressLocation { Notification = 15 }
export enum ViewColumn { Active = -1 }
export class WorkspaceEdit { ops: any[] = []; replace(...a: any[]) { this.ops.push(["replace", ...a]); } createFile(...a: any[]) { this.ops.push(["create", ...a]); } deleteFile(...a: any[]) { this.ops.push(["delete", ...a]); } insert(...a: any[]) { this.ops.push(["insert", ...a]); } }
export class TabInputTextDiff { constructor(public original: any, public modified: any) {} }

const statusItem = () => ({ text: "", tooltip: "", command: undefined as any, show() {}, hide() {}, dispose() {} });
export const commands = {
  registerCommand: (id: string, cb: Cb) => { registered.set(id, cb); return new Disposable(() => registered.delete(id)); },
  executeCommand: async (cmd: string, ...args: any[]) => { executed.push({ cmd, args }); },
};
export const window = {
  createStatusBarItem: statusItem,
  registerWebviewViewProvider: () => new Disposable(),
  showInformationMessage: async () => undefined, showErrorMessage: async () => undefined, showWarningMessage: async () => undefined,
  showInputBox: async () => undefined, showQuickPick: async () => undefined, showTextDocument: async () => undefined,
  createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
  withProgress: async (_o: any, task: Cb) => task({ report() {} }, { onCancellationRequested: () => new Disposable(), isCancellationRequested: false }),
  tabGroups: { all: [] as any[], close: async () => true },
  activeTextEditor: undefined as any,
};
export const workspace = {
  workspaceFolders: [] as any[],
  getConfiguration: () => ({ get: (_k: string, d: any) => d }),
  onDidChangeConfiguration: () => new Disposable(),
  createFileSystemWatcher: () => ({ onDidChange: () => new Disposable(), onDidCreate: () => new Disposable(), onDidDelete: () => new Disposable(), dispose() {} }),
  registerTextDocumentContentProvider: () => new Disposable(),
  textDocuments: [] as any[],
  fs: { readFile: async () => new Uint8Array() },
  openTextDocument: async () => ({ getText: () => "", save: async () => true, positionAt: (n: number) => new Position(0, n), lineCount: 0 }),
  applyEdit: async () => true,
};
export const languages = { registerCodeLensProvider: () => new Disposable() };
export const env = { openExternal: async () => true };
