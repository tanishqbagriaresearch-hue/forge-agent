import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Host } from "../host";
import type { Overlay } from "../workspace/overlay";
import type { UndoStack } from "../workspace/snapshot";
import type { ContextIndex } from "../context/index";
import { estimateTokens } from "../context/index";
import { computeHunks, applyHunks } from "../workspace/hunks";
import { resolveInWorkspace } from "../workspace/paths";
import { listFiles } from "../workspace/walk";

export type Activity = { tool: string; summary: string; files?: { path: string; why?: string }[] };
export type ReviewState = { decisions: Map<string, Set<number>> | null; signal: AbortSignal };
export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export type EditorToolsDeps = {
  host: Host; overlay: Overlay; undo: UndoStack; index: ContextIndex;
  review: ReviewState; onActivity: (a: Activity) => void; tokenBudget: number;
};

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
const MAX_READ = 60_000;
const MAX_OUT = 20_000;

function globToRegex(glob: string): RegExp {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, "(?:.*/)?");
  return new RegExp(`^${re}$`);
}

export class EditorTools {
  constructor(private d: EditorToolsDeps) {}
  private rel(abs: string) { return path.relative(this.d.host.root, abs).split(path.sep).join("/"); }
  private guard<A>(fn: (a: A) => Promise<ToolResult>) {
    return async (a: A): Promise<ToolResult> => {
      try { return await fn(a); } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
    };
  }

  read_file = this.guard(async (a: { path: string; start_line?: number; end_line?: number }) => {
    const abs = resolveInWorkspace(this.d.host.root, a.path);
    const text = await this.d.host.readFile(abs);
    if (text === null) return fail(`file not found: ${a.path}`);
    const lines = text.split("\n");
    const s = Math.max(1, a.start_line ?? 1), e = Math.min(lines.length, a.end_line ?? lines.length);
    let body = lines.slice(s - 1, e).join("\n");
    let note = "";
    if (body.length > MAX_READ) { body = body.slice(0, MAX_READ); note = "\n[truncated: use start_line/end_line to read more]"; }
    this.d.onActivity({ tool: "read_file", summary: `read ${a.path}:${s}-${e}`, files: [{ path: a.path }] });
    return ok(`${a.path} (lines ${s}-${e} of ${lines.length})\n${body}${note}`);
  });

  list_dir = this.guard(async (a: { path: string }) => {
    const abs = resolveInWorkspace(this.d.host.root, a.path || ".");
    const entries = await fs.readdir(abs, { withFileTypes: true });
    this.d.onActivity({ tool: "list_dir", summary: `list ${a.path || "."}` });
    return ok(entries.filter((e) => e.name !== ".git").map((e) => e.name + (e.isDirectory() ? "/" : "")).sort().join("\n"));
  });

  search_workspace = this.guard(async (a: { pattern: string; glob?: string; max_results?: number }) => {
    let re: RegExp;
    try { re = new RegExp(a.pattern); } catch (e) { return fail(`invalid regex: ${(e as Error).message}`); }
    const gre = a.glob ? globToRegex(a.glob) : null;
    const max = a.max_results ?? 50;
    const hits: string[] = [];
    const seen = new Set<string>();
    for (const rel of await listFiles(this.d.host.root)) {
      if (gre && !gre.test(rel)) continue;
      const text = await this.d.host.readFile(path.join(this.d.host.root, rel));
      if (text === null) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && hits.length < max; i++)
        if (re.test(lines[i])) { hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`); seen.add(rel); }
      if (hits.length >= max) break;
    }
    this.d.onActivity({ tool: "search_workspace", summary: `search /${a.pattern}/ → ${hits.length} hits`, files: [...seen].map((p) => ({ path: p, why: `matches /${a.pattern}/` })) });
    return ok(hits.length ? hits.join("\n") : "no matches");
  });

  find_symbol = this.guard(async (a: { name: string }) => {
    const found = this.d.index.findSymbol(a.name);
    this.d.onActivity({ tool: "find_symbol", summary: `find ${a.name} → ${found.length}`, files: found.map((c) => ({ path: `${c.path}:${c.startLine}-${c.endLine}`, why: `definition of ${a.name}` })) });
    if (!found.length) return ok(`no definition of ${a.name}`);
    return ok(found.map((c) => `${c.path}:${c.startLine}-${c.endLine} (${c.kind})\n${c.text.split("\n").slice(0, 60).join("\n")}`).join("\n\n"));
  });

  retrieve_context = this.guard(async (a: { query: string; budget_tokens?: number }) => {
    const budget = Math.min(a.budget_tokens ?? this.d.tokenBudget, this.d.tokenBudget * 2);
    const chunks = this.d.index.retrieve(a.query, budget);
    const used = chunks.reduce((n, c) => n + estimateTokens(c.text), 0);
    this.d.onActivity({
      tool: "retrieve_context",
      summary: `retrieve "${a.query}" → ${chunks.length} chunks, ~${used}/${budget} tokens`,
      files: chunks.map((c) => ({ path: `${c.path}:${c.startLine}-${c.endLine}`, why: c.why })),
    });
    if (!chunks.length) return ok("no relevant code found; try different keywords or search_workspace");
    const out = chunks.map((c, i) => `[${i + 1}] ${c.path}:${c.startLine}-${c.endLine}${c.symbol ? ` (${c.symbol})` : ""} — ${c.why}\n${c.text}`);
    return ok(`${out.join("\n\n")}\n\n(~${used} of ${budget} token budget used)`);
  });

  propose_edit = this.guard(async (a: { path: string; old_text?: string; new_text: string }) => {
    const abs = resolveInWorkspace(this.d.host.root, a.path);
    await this.d.overlay.stageEdit(abs, a.old_text, a.new_text);
    const n = this.d.overlay.staged().size;
    this.d.onActivity({ tool: "propose_edit", summary: `staged edit in ${a.path}`, files: [{ path: a.path, why: "edited" }] });
    return ok(`Staged edit for ${a.path} (${n} file(s) staged). Nothing is written to disk until apply_changes is approved by the user.`);
  });

  apply_changes = this.guard(async (a: { summary: string }) => {
    const { host, overlay, undo, review } = this.d;
    const staged = overlay.staged();
    if (!staged.size) return ok("nothing staged");
    if (!review.decisions) return fail("no review decisions recorded: the user has not approved these changes");
    const writes: { abs: string; content: string | null; before: string | null }[] = [];
    const report: string[] = [];
    for (const [abs, { original, proposed }] of staged) {
      const rel = this.rel(abs);
      if ((await host.readFile(abs)) !== original) { report.push(`SKIPPED ${rel}: file changed on disk since staging (conflict)`); continue; }
      const hunks = computeHunks(original ?? "", proposed);
      const acc = review.decisions.get(abs) ?? new Set<number>();
      if (!acc.size) { report.push(`REJECTED ${rel}: no hunks accepted`); continue; }
      writes.push({ abs, content: applyHunks(original ?? "", hunks, acc), before: original });
      const rejected = hunks.map((h) => h.id).filter((id) => !acc.has(id));
      report.push(`APPLIED ${rel}: hunks ${[...acc].sort().join(",")} of ${hunks.length}${rejected.length ? ` (rejected ${rejected.join(",")})` : ""}`);
    }
    if (writes.length) {
      await host.applyFiles(writes.map(({ abs, content }) => ({ abs, content })));
      undo.push({ label: a.summary, files: writes.map((w) => ({ abs: w.abs, before: w.before, after: w.content })) });
    }
    overlay.clear();
    review.decisions = null;
    this.d.onActivity({ tool: "apply_changes", summary: writes.length ? `applied ${writes.length} file(s)` : "no hunks accepted", files: writes.map((w) => ({ path: this.rel(w.abs), why: "applied" })) });
    return ok(writes.length ? report.join("\n") : `no hunks accepted\n${report.join("\n")}`);
  });

  run_command = this.guard(async (a: { command: string; timeout_seconds?: number }) => {
    const { host, review } = this.d;
    const timeoutMs = Math.min(a.timeout_seconds ?? 120, 600) * 1000;
    this.d.onActivity({ tool: "run_command", summary: `$ ${a.command}` });
    return await new Promise<ToolResult>((resolve) => {
      const child = spawn(a.command, { cwd: host.root, shell: true, detached: process.platform !== "win32" });
      let out = "";
      let settled = false;
      const done = (r: ToolResult) => { if (!settled) { settled = true; clearTimeout(timer); review.signal.removeEventListener("abort", onAbort); resolve(r); } };
      const kill = () => { try { process.platform === "win32" ? child.kill() : process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } };
      const onAbort = () => { kill(); done(ok("aborted: the run was cancelled")); };
      const timer = setTimeout(() => { kill(); done(ok(`timed out after ${timeoutMs / 1000}s\n${clip(out)}`)); }, timeoutMs);
      if (review.signal.aborted) return onAbort();
      review.signal.addEventListener("abort", onAbort);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("error", (e) => done(fail(`failed to start: ${e.message}`)));
      child.on("close", (code) => done(ok(`exit code ${code}\n${clip(out)}`)));
    });
  });
}

function clip(s: string): string {
  if (s.length <= MAX_OUT) return s;
  return s.slice(0, 4000) + `\n[truncated ${s.length - MAX_OUT + 0} chars]\n` + s.slice(-(MAX_OUT - 4500));
}
