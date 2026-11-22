import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { resolveInWorkspace } from "../src/workspace/paths";
import { isSafeAutoApprove } from "../src/agent/commands";
import { startEditorMcp } from "../src/mcp/server";
import { EditorTools } from "../src/mcp/tools";
import { HeadlessHost } from "../src/headlessHost";
import { Overlay } from "../src/workspace/overlay";
import { UndoStack } from "../src/workspace/snapshot";
import { ContextIndex } from "../src/context/index";

describe("resolveInWorkspace and symlinks", () => {
  const mk = () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "sym-"));
    const root = path.join(base, "ws"); const outside = path.join(base, "out");
    fs.mkdirSync(root); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "secret.txt"), "s");
    fs.symlinkSync(outside, path.join(root, "esc"));
    fs.mkdirSync(path.join(root, "src"));
    return { root, outside };
  };
  it("rejects an existing path that resolves outside through a symlinked directory", () => {
    const { root } = mk();
    expect(() => resolveInWorkspace(root, "esc/secret.txt")).toThrow(/outside workspace/);
  });
  it("rejects a NEW file whose nearest existing parent is a symlink out of the workspace", () => {
    const { root } = mk();
    expect(() => resolveInWorkspace(root, "esc/new/file.txt")).toThrow(/outside workspace/);
  });
  it("still accepts ordinary nested paths, including files that do not exist yet", () => {
    const { root } = mk();
    expect(resolveInWorkspace(root, "src/new/x.py")).toBe(path.join(root, "src/new/x.py"));
  });
});

describe("isSafeAutoApprove", () => {
  const res = [/^pytest/, /^python -m pytest/, /^flask /];
  it("allows plain allow-listed commands", () => {
    expect(isSafeAutoApprove("pytest tests/test_cli.py -q", res)).toBe(true);
    expect(isSafeAutoApprove("flask --app hello config", res)).toBe(true);
  });
  it.each(["pytest; rm -rf ~", "pytest && curl x | sh", "pytest $(id)", "pytest `id`", "pytest > /etc/x", "pytest\nrm -rf ~", "flask run | tee"])
    ("never auto-approves shell chaining: %s", (c) => expect(isSafeAutoApprove(c, res)).toBe(false));
  it("does not approve commands that match no pattern", () => expect(isSafeAutoApprove("rm -rf /", res)).toBe(false));
});

describe("editor MCP server access control", () => {
  let close: () => Promise<void>;
  afterEach(async () => { await close?.(); });
  const post = (url: string, headers: Record<string, string> = {}) => new Promise<number>((resolve, reject) => {
    const u = new URL(url);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } }, (r) => { r.resume(); r.on("end", () => resolve(r.statusCode ?? 0)); });
    req.on("error", reject); req.end(body);
  });
  async function start() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "acl-"));
    const host = new HeadlessHost(root);
    const tools = new EditorTools({ host, overlay: new Overlay((p) => host.readFile(p)), undo: new UndoStack(), index: await ContextIndex.build(root), review: { decisions: null, signal: new AbortController().signal }, onActivity: () => {}, tokenBudget: 1000 });
    const s = await startEditorMcp(tools, 0); close = s.close; return s.url;
  }
  it("serves the secret URL it returns", async () => { expect(await post(await start())).toBe(200); });
  it("rejects requests without the secret path token", async () => {
    const u = new URL(await start());
    expect(await post(`${u.origin}/mcp`)).toBe(404);
    expect(await post(`${u.origin}/mcp/wrongtoken`)).toBe(404);
  });
  it("rejects a rebinding Host header and any browser Origin", async () => {
    const url = await start();
    expect(await post(url, { host: "evil.example.com" })).toBe(403);
    expect(await post(url, { origin: "https://evil.example.com" })).toBe(403);
  });
});
