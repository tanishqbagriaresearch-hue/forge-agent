import { eolOf } from "./hunks";
export type Staged = { original: string | null; proposed: string };

const lf = (t: string) => t.replace(/\r\n/g, "\n");

export class Overlay {
  private entries = new Map<string, Staged>();
  constructor(private read: (abs: string) => Promise<string | null>) {}

  async stageEdit(abs: string, oldText: string | undefined, newText: string): Promise<void> {
    const existing = this.entries.get(abs);
    const original = existing ? existing.original : await this.read(abs);
    const current = existing ? existing.proposed : original;
    if (oldText === undefined || oldText === "") {
      if (current !== null) throw new Error(`file already exists: ${abs}`);
      this.entries.set(abs, { original: null, proposed: newText });
      return;
    }
    if (current === null) throw new Error(`file not found: ${abs}`);
    const eol = eolOf(current);
    const body = lf(current);
    const needle = lf(oldText);
    const count = body.split(needle).length - 1;
    if (count === 0) throw new Error("old_text not found");
    if (count > 1) throw new Error(`old_text matches ${count} places`);
    const idx = body.indexOf(needle);
    const next = body.slice(0, idx) + lf(newText) + body.slice(idx + needle.length);
    this.entries.set(abs, { original, proposed: next.replace(/\n/g, eol) });
  }

  staged(): Map<string, Staged> { return new Map(this.entries); }
  baseline(abs: string): string | null { return this.entries.get(abs)?.original ?? null; }
  clear(): void { this.entries.clear(); }
}
