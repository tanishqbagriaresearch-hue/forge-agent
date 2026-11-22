import fs from "node:fs/promises";
import path from "node:path";
import type { Host, ReviewItem } from "./host";

/** Editor-less Host used by tests and the e2e harness. Reads/writes the real filesystem. */
export class HeadlessHost implements Host {
  messages: { kind: string; msg: string }[] = [];
  reviews: ReviewItem[][] = [];
  commands: string[] = [];
  constructor(
    public root: string,
    private decide: (items: ReviewItem[]) => Map<string, Set<number>> | Promise<Map<string, Set<number>>> = (items) =>
      new Map(items.map((i) => [i.abs, new Set(i.hunks.map((h) => h.id))])),
    private allowCommands = true,
  ) {}

  async readFile(abs: string): Promise<string | null> {
    try { return await fs.readFile(abs, "utf8"); } catch { return null; }
  }
  async applyFiles(files: { abs: string; content: string | null }[]): Promise<void> {
    for (const f of files) {
      if (f.content === null) await fs.rm(f.abs, { force: true });
      else { await fs.mkdir(path.dirname(f.abs), { recursive: true }); await fs.writeFile(f.abs, f.content); }
    }
  }
  async reviewChanges(items: ReviewItem[], signal: AbortSignal): Promise<Map<string, Set<number>>> {
    this.reviews.push(items);
    if (signal.aborted) return new Map();
    return this.decide(items);
  }
  async confirmCommand(cmd: string): Promise<boolean> { this.commands.push(cmd); return this.allowCommands; }
  notify(kind: "info" | "error", msg: string): void { this.messages.push({ kind, msg }); }
}
