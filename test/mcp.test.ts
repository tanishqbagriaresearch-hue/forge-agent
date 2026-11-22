import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startEditorMcp } from "../src/mcp/server";
import { EditorTools, type ReviewState, type Activity } from "../src/mcp/tools";
import { HeadlessHost } from "../src/headlessHost";
import { Overlay } from "../src/workspace/overlay";
import { UndoStack } from "../src/workspace/snapshot";
import { ContextIndex } from "../src/context/index";

let root: string, host: HeadlessHost, undo: UndoStack, review: ReviewState, activity: Activity[];
let srv: { url: string; close(): Promise<void> }, client: Client, abort: AbortController;
const thirty = (e: Record<number, string> = {}) => Array.from({ length: 30 }, (_, i) => e[i + 1] ?? `line${i + 1}`).join("\n") + "\n";
const text = (r: any) => (r.content as { text: string }[]).map((c) => c.text).join("\n");
const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/a.py"), thirty());
  fs.writeFileSync(path.join(root, "src/dbg.py"), 'def get_debug_flag():\n    """FLASK_DEBUG environment variable."""\n    return False\n');
  host = new HeadlessHost(root);
  undo = new UndoStack();
  abort = new AbortController();
  review = { decisions: null, signal: abort.signal };
  activity = [];
  const tools = new EditorTools({
    host, overlay: new Overlay((p) => host.readFile(p)), undo, index: await ContextIndex.build(root),
    review, onActivity: (a) => activity.push(a), tokenBudget: 2000,
  });
  srv = await startEditorMcp(tools, 0);
  client = new Client({ name: "t", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(srv.url)));
});
afterEach(async () => { await client.close(); await srv.close(); });

describe("editor MCP", () => {
  it("lists all eight tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["apply_changes", "find_symbol", "list_dir", "propose_edit", "read_file", "retrieve_context", "run_command", "search_workspace"]);
  });

  it("propose_edit stages without touching disk", async () => {
    const r = await call("propose_edit", { path: "src/a.py", old_text: "line2\n", new_text: "TWO\n" });
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(root, "src/a.py"), "utf8")).toBe(thirty());
    expect(text(await call("read_file", { path: "src/a.py", start_line: 2, end_line: 2 }))).toContain("line2");
  });

  it("propose_edit reports missing and ambiguous old_text as errors", async () => {
    const miss = await call("propose_edit", { path: "src/a.py", old_text: "nope", new_text: "x" });
    expect(miss.isError).toBe(true);
    expect(text(miss)).toContain("old_text not found");
    const amb = await call("propose_edit", { path: "src/a.py", old_text: "line1", new_text: "x" }); // line1, line10..19
    expect(text(amb)).toContain("old_text matches");
  });

  it("apply_changes writes only accepted hunks and pushes undo", async () => {
    await call("propose_edit", { path: "src/a.py", old_text: "line2\n", new_text: "TWO\n" });
    await call("propose_edit", { path: "src/a.py", old_text: "line25\n", new_text: "TWENTYFIVE\n" });
    const abs = path.join(root, "src/a.py");
    review.decisions = new Map([[abs, new Set([1])]]);
    const r = await call("apply_changes", { summary: "edit a.py" });
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(abs, "utf8")).toBe(thirty({ 2: "TWO" }));
    expect(undo.size()).toBe(1);
    expect(text(r)).toContain("APPLIED src/a.py");
  });

  it("apply_changes writes nothing when no hunks are accepted", async () => {
    await call("propose_edit", { path: "src/a.py", old_text: "line2\n", new_text: "TWO\n" });
    review.decisions = new Map();
    const r = await call("apply_changes", { summary: "x" });
    expect(text(r)).toMatch(/no hunks accepted/i);
    expect(fs.readFileSync(path.join(root, "src/a.py"), "utf8")).toBe(thirty());
    expect(undo.size()).toBe(0);
  });

  it("apply_changes refuses without recorded review decisions", async () => {
    await call("propose_edit", { path: "src/a.py", old_text: "line2\n", new_text: "TWO\n" });
    review.decisions = null;
    const r = await call("apply_changes", { summary: "x" });
    expect(r.isError).toBe(true);
    expect(fs.readFileSync(path.join(root, "src/a.py"), "utf8")).toBe(thirty());
  });

  it("apply_changes skips a file modified on disk after staging", async () => {
    await call("propose_edit", { path: "src/a.py", old_text: "line2\n", new_text: "TWO\n" });
    const abs = path.join(root, "src/a.py");
    fs.writeFileSync(abs, "externally changed\n");
    review.decisions = new Map([[abs, new Set([1])]]);
    const r = await call("apply_changes", { summary: "x" });
    expect(text(r)).toMatch(/conflict/i);
    expect(fs.readFileSync(abs, "utf8")).toBe("externally changed\n");
  });

  it("rejects paths outside the workspace in every path-taking tool", async () => {
    for (const [name, args] of [
      ["read_file", { path: "../etc/passwd" }],
      ["list_dir", { path: "/etc" }],
      ["propose_edit", { path: "../x.py", new_text: "x" }],
    ] as const) {
      const r = await call(name, args);
      expect(r.isError, name).toBe(true);
      expect(text(r)).toContain("outside workspace");
    }
  });

  it("retrieve_context returns ranked chunks with why, within budget, and emits activity", async () => {
    const r = await call("retrieve_context", { query: "debug flag environment variable", budget_tokens: 500 });
    const t = text(r);
    expect(t).toContain("src/dbg.py");
    expect(t).toContain("matched:");
    expect(Math.ceil(t.length / 4)).toBeLessThan(900);
    const a = activity.find((x) => x.tool === "retrieve_context")!;
    expect(a.files![0].path).toContain("src/dbg.py");
    expect(a.files![0].why).toContain("matched");
  });

  it("search_workspace and find_symbol locate code", async () => {
    expect(text(await call("search_workspace", { pattern: "FLASK_DEBUG" }))).toContain("src/dbg.py:2");
    expect(text(await call("find_symbol", { name: "get_debug_flag" }))).toContain("src/dbg.py:1-3");
    expect((await call("search_workspace", { pattern: "(" })).isError).toBe(true);
  });

  it("run_command runs in the workspace root, truncates long output", async () => {
    const r1 = await call("run_command", { command: "echo hi && pwd" });
    expect(text(r1)).toContain("exit code 0");
    expect(text(r1)).toContain("hi");
    expect(text(r1)).toContain(fs.realpathSync(root));
    const r2 = await call("run_command", { command: `node -e "console.log('x'.repeat(40000))"` });
    expect(text(r2).length).toBeLessThan(21000);
    expect(text(r2)).toContain("[truncated");
  });

  it("run_command stops when the run is aborted", async () => {
    const p = call("run_command", { command: "sleep 30", timeout_seconds: 60 });
    setTimeout(() => abort.abort(), 200);
    const t0 = Date.now();
    const r = await p;
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(text(r)).toMatch(/aborted/i);
  });
});
