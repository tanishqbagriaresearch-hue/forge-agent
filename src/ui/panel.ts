import * as vscode from "vscode";

export type PanelHandlers = { send(text: string): void; stop(): void; undo(): void; setModel(m: string): void };

export class AgentPanel implements vscode.WebviewViewProvider {
  static readonly viewType = "forgeAgent.panel";
  private view?: vscode.WebviewView;
  private backlog: unknown[] = [];

  constructor(private ext: vscode.Uri, private handlers: PanelHandlers) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.ext, "media")] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: any) => {
      if (m?.type === "send" && typeof m.text === "string") this.handlers.send(m.text);
      else if (m?.type === "stop") this.handlers.stop();
      else if (m?.type === "undo") this.handlers.undo();
      else if (m?.type === "model" && typeof m.model === "string") this.handlers.setModel(m.model);
    });
    view.onDidDispose(() => { this.view = undefined; });
    const pending = this.backlog; this.backlog = [];
    for (const m of pending) void view.webview.postMessage(m);
  }

  post(msg: unknown): void {
    if (this.view) void this.view.webview.postMessage(msg);
    else { this.backlog.push(msg); if (this.backlog.length > 500) this.backlog.shift(); }
  }

  private html(webview: vscode.Webview): string {
    const nonce = Array.from({ length: 24 }, () => Math.random().toString(36)[2]).join("");
    const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.ext, "media", f));
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri("panel.css")}"></head>
<body>
<div id="bar"><select id="model" title="Model (TrueForge reference)"></select><span id="status">idle</span></div>
<div id="log"></div>
<details id="ctxbox" open><summary>Context chosen by the agent</summary><ul id="ctx"></ul></details>
<div id="input"><textarea id="text" rows="3" placeholder="Describe a change. Use @path/to/file.py or @sym:name to attach context. Enter to send, Shift+Enter for a new line."></textarea>
<div id="buttons"><button id="send">Send</button><button id="stop" disabled>Stop</button><button id="undo" disabled>Undo last change</button></div></div>
<script nonce="${nonce}" src="${uri("panel.js")}"></script></body></html>`;
  }
}
