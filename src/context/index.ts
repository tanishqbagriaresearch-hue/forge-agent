import fs from "node:fs/promises";
import path from "node:path";
import { listFiles } from "../workspace/walk";
import { chunkFile, type Chunk } from "./chunker";
import { Bm25, tokenize } from "./bm25";

export type RetrievedChunk = Chunk & { score: number; why: string };
const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "are", "all", "any", "its", "has", "have", "how", "what", "when", "where", "which", "should", "must", "will", "can", "not", "but", "add", "new"]);
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);
const docText = (c: Chunk) => `${c.path} ${c.symbol ?? ""} ${c.symbol ?? ""} ${c.text}`;

export class ContextIndex {
  private byPath = new Map<string, Chunk[]>();
  private flat: Chunk[] = [];
  private tokenSets: Set<string>[] = [];
  private bm: Bm25 | null = null;
  private dirty = true;

  static async build(root: string): Promise<ContextIndex> {
    const idx = new ContextIndex();
    for (const rel of await listFiles(root)) {
      try { idx.byPath.set(rel, chunkFile(rel, await fs.readFile(path.join(root, rel), "utf8"))); } catch { /* skip */ }
    }
    return idx;
  }

  update(p: string, text: string | null): void {
    if (text === null) this.byPath.delete(p); else this.byPath.set(p, chunkFile(p, text));
    this.dirty = true;
  }

  private ensure(): void {
    if (!this.dirty && this.bm) return;
    this.flat = [...this.byPath.values()].flat();
    const docs = this.flat.map(docText);
    this.tokenSets = docs.map((d) => new Set(tokenize(d)));
    this.bm = new Bm25(docs);
    this.dirty = false;
  }

  retrieve(query: string, budgetTokens: number): RetrievedChunk[] {
    if (budgetTokens <= 0) return [];
    this.ensure();
    const qTerms = [...new Set(tokenize(query))].filter((t) => !STOP.has(t));
    const scores = this.bm!.score(qTerms.join(" "));
    const order = scores.map((s, i) => ({ s, i })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 60);
    const picked: RetrievedChunk[] = [];
    let used = 0;
    for (const { s, i } of order) {
      const c = this.flat[i];
      const cost = estimateTokens(c.text);
      if (used + cost > budgetTokens) continue;
      if (picked.some((p) => p.path === c.path && !(p.endLine < c.startLine || c.endLine < p.startLine))) continue;
      const matched = qTerms.filter((t) => this.tokenSets[i].has(t));
      picked.push({ ...c, score: s, why: `matched: ${matched.join(", ")}` });
      used += cost;
    }
    return picked;
  }

  findSymbol(name: string): Chunk[] {
    this.ensure();
    return this.flat.filter((c) => c.symbol === name);
  }

  fileCount(): number { return this.byPath.size; }
}
