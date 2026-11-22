export type UndoEntry = { label: string; files: { abs: string; before: string | null; after: string | null }[] };

export class UndoStack {
  private stack: UndoEntry[] = [];
  push(e: UndoEntry): void { this.stack.push(e); }
  pop(): UndoEntry | undefined { return this.stack.pop(); }
  size(): number { return this.stack.length; }
}
