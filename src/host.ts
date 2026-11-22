import type { Hunk } from "./workspace/hunks";

export type ReviewItem = { abs: string; original: string | null; proposed: string; hunks: Hunk[] };

/** Everything the agent logic needs from the editor. VS Code implements it; tests/e2e use a headless one. */
export interface Host {
  root: string;
  readFile(abs: string): Promise<string | null>;
  /** Atomic batch: content null deletes the file. */
  applyFiles(files: { abs: string; content: string | null }[]): Promise<void>;
  /** Returns accepted hunk ids per file (absent/empty = nothing accepted). Must resolve (empty map) when signal aborts. */
  reviewChanges(items: ReviewItem[], signal: AbortSignal): Promise<Map<string, Set<number>>>;
  confirmCommand(cmd: string, signal: AbortSignal): Promise<boolean>;
  notify(kind: "info" | "error", msg: string): void;
}
