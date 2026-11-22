import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { EditorTools } from "./tools";

function buildServer(t: EditorTools): McpServer {
  const s = new McpServer({ name: "forge-editor", version: "0.1.0" });
  const ro = { readOnlyHint: true };
  s.registerTool("read_file", { description: "Read a file (optionally a line range) from the workspace.", inputSchema: { path: z.string(), start_line: z.number().int().optional(), end_line: z.number().int().optional() }, annotations: ro }, (a) => t.read_file(a));
  s.registerTool("list_dir", { description: "List a directory in the workspace.", inputSchema: { path: z.string() }, annotations: ro }, (a) => t.list_dir(a));
  s.registerTool("search_workspace", { description: "Regex search across workspace files. Optional glob like src/**/*.py.", inputSchema: { pattern: z.string(), glob: z.string().optional(), max_results: z.number().int().optional() }, annotations: ro }, (a) => t.search_workspace(a));
  s.registerTool("find_symbol", { description: "Find the definition (function/class) of a symbol by name.", inputSchema: { name: z.string() }, annotations: ro }, (a) => t.find_symbol(a));
  s.registerTool("retrieve_context", { description: "Ranked retrieval of relevant code chunks for a natural-language query, within a token budget. Call this FIRST when you do not know which files matter.", inputSchema: { query: z.string(), budget_tokens: z.number().int().optional() }, annotations: ro }, (a) => t.retrieve_context(a));
  s.registerTool("propose_edit", { description: "Stage an edit: replace old_text (must match exactly once) with new_text in a file. Omit old_text to create a new file. Nothing is written until apply_changes is approved by the user.", inputSchema: { path: z.string(), old_text: z.string().optional(), new_text: z.string() }, annotations: { readOnlyHint: false, destructiveHint: false } }, (a) => t.propose_edit(a));
  s.registerTool("apply_changes", { description: "Submit all staged edits for user review; the user accepts or rejects each hunk. Call once after all propose_edit calls.", inputSchema: { summary: z.string() }, annotations: { readOnlyHint: false, destructiveHint: false } }, (a) => t.apply_changes(a));
  s.registerTool("run_command", { description: "Run a shell command in the workspace root (e.g. tests). Requires user approval.", inputSchema: { command: z.string(), timeout_seconds: z.number().int().optional() }, annotations: { readOnlyHint: false, destructiveHint: false } }, (a) => t.run_command(a));
  return s;
}

export async function startEditorMcp(tools: EditorTools, port = 0): Promise<{ url: string; close(): Promise<void> }> {
  // Only TrueForge (which is told the secret URL) may call the editor tools: random path token, loopback Host only, no browser Origin.
  const token = crypto.randomBytes(24).toString("hex");
  const base = `/mcp/${token}`;
  let boundPort = 0;
  const server = http.createServer(async (req, res) => {
    const host = String(req.headers.host ?? "");
    if (req.headers.origin !== undefined || ![`127.0.0.1:${boundPort}`, `localhost:${boundPort}`].includes(host)) { res.statusCode = 403; res.end(); return; }
    if (req.url !== base && !req.url?.startsWith(base + "?")) { res.statusCode = 404; res.end(); return; }
    if (req.method !== "POST") { res.statusCode = 405; res.setHeader("allow", "POST"); res.end(); return; }
    let raw = "";
    for await (const c of req) raw += c;
    try {
      const mcp = buildServer(tools);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { transport.close(); mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
    } catch (e) {
      if (!res.headersSent) { res.statusCode = 500; res.end(String(e)); }
    }
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const p = (server.address() as AddressInfo).port;
  boundPort = p;
  return { url: `http://127.0.0.1:${p}${base}`, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
