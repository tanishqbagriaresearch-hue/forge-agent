import fs from "node:fs/promises";
import { resolveInWorkspace } from "../workspace/paths";
import type { ContextIndex } from "./index";
import { estimateTokens } from "./index";

export type Mentions = { files: string[]; symbols: string[]; text: string };

export function parseMentions(input: string): Mentions {
  const files: string[] = [], symbols: string[] = [];
  for (const m of input.matchAll(/(?:^|\s)@sym:([A-Za-z_][\w.]*)/g)) symbols.push(m[1]);
  for (const m of input.matchAll(/(?:^|\s)@((?!sym:)[\w./\-]*[\w\-]\.[A-Za-z0-9]+)(?![\w@])/g)) files.push(m[1]);
  return { files, symbols, text: input };
}

export async function expandMentions(m: Mentions, index: ContextIndex, root: string, budgetTokens: number): Promise<string> {
  let remaining = budgetTokens;
  const blocks: string[] = [];
  const fit = (s: string) => {
    const max = Math.max(0, remaining * 4);
    if (s.length <= max) { remaining -= estimateTokens(s); return s; }
    remaining = 0;
    return s.slice(0, max) + "\n[truncated]";
  };
  for (const f of m.files) {
    try {
      const text = await fs.readFile(resolveInWorkspace(root, f), "utf8");
      blocks.push(`<context file="${f}">\n${fit(text)}\n</context>`);
    } catch {
      blocks.push(`<context file="${f}">not found</context>`);
    }
  }
  for (const s of m.symbols) {
    const chunks = index.findSymbol(s);
    if (!chunks.length) { blocks.push(`<context symbol="${s}">not found</context>`); continue; }
    if (remaining <= 0) { blocks.push(`<context symbol="${s}">[omitted: budget exhausted]</context>`); continue; }
    for (const c of chunks)
      blocks.push(`<context symbol="${s}" file="${c.path}" lines="${c.startLine}-${c.endLine}">\n${fit(c.text)}\n</context>`);
  }
  return blocks.join("\n");
}
