import path from "node:path";
import type { ReviewItem } from "../host";

export type HunkPick = { label: string; description: string; detail?: string; picked: boolean; abs: string; id: number };

/** One checkbox row per hunk (VS Code hides CodeLens in diff editors by default, so this is the primary per-hunk control). */
export function hunkPickItems(items: ReviewItem[], root: string): HunkPick[] {
  const out: HunkPick[] = [];
  for (const it of items) {
    const rel = path.relative(root, it.abs).split(path.sep).join("/");
    for (const h of it.hunks) {
      const add = h.lines.filter((l) => l[0] === "+").length, del = h.lines.filter((l) => l[0] === "-").length;
      const first = h.lines.find((l) => l[0] === "+" || l[0] === "-");
      out.push({ label: `${rel} · hunk ${h.id}/${it.hunks.length}`, description: `+${add} −${del} (line ${h.newStart})`, detail: first?.slice(0, 120), picked: true, abs: it.abs, id: h.id });
    }
  }
  return out;
}

export function decisionsFromPicks(picks: readonly { abs: string; id: number }[]): Map<string, Set<number>> {
  const m = new Map<string, Set<number>>();
  for (const p of picks) { if (!m.has(p.abs)) m.set(p.abs, new Set()); m.get(p.abs)!.add(p.id); }
  return m;
}
