import { diffArrays } from "diff";

export type Hunk = { id: number; oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] };

const CONTEXT = 3;
const lf = (t: string) => t.replace(/\r\n/g, "\n");
const eolOf = (t: string) => (t.includes("\r\n") ? "\r\n" : "\n");
type Op = { t: " " | "-" | "+"; line: string };

export function computeHunks(oldText: string, newText: string): Hunk[] {
  const a = lf(oldText).split("\n");
  const b = lf(newText).split("\n");
  const ops: Op[] = [];
  for (const part of diffArrays(a, b)) {
    const t = part.added ? "+" : part.removed ? "-" : " ";
    for (const line of part.value) ops.push({ t, line });
  }
  // find change blocks, then merge those whose equal-gap is <= 2*CONTEXT
  const blocks: { s: number; e: number }[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].t === " ") continue;
    let j = i;
    while (j + 1 < ops.length && ops[j + 1].t !== " ") j++;
    blocks.push({ s: i, e: j });
    i = j;
  }
  const merged: { s: number; e: number }[] = [];
  for (const bl of blocks) {
    const last = merged[merged.length - 1];
    if (last && bl.s - last.e - 1 <= 2 * CONTEXT) last.e = bl.e;
    else merged.push({ ...bl });
  }
  // prefix counts of old/new lines consumed before each op index
  const oldBefore: number[] = [], newBefore: number[] = [];
  let o = 0, n = 0;
  for (const op of ops) {
    oldBefore.push(o); newBefore.push(n);
    if (op.t !== "+") o++;
    if (op.t !== "-") n++;
  }
  return merged.map((m, idx) => {
    const s = Math.max(0, m.s - CONTEXT);
    const e = Math.min(ops.length - 1, m.e + CONTEXT);
    const slice = ops.slice(s, e + 1);
    return {
      id: idx + 1,
      oldStart: oldBefore[s] + 1,
      newStart: newBefore[s] + 1,
      oldLines: slice.filter((x) => x.t !== "+").length,
      newLines: slice.filter((x) => x.t !== "-").length,
      lines: slice.map((x) => x.t + x.line),
    };
  });
}

export function applyHunks(oldText: string, hunks: Hunk[], acceptedIds: Set<number>): string {
  const eol = eolOf(oldText);
  const src = lf(oldText).split("\n");
  const out: string[] = [];
  let i = 0;
  for (const h of [...hunks].sort((x, y) => x.oldStart - y.oldStart)) {
    while (i < h.oldStart - 1) out.push(src[i++]);
    if (acceptedIds.has(h.id)) {
      for (const l of h.lines) if (l[0] !== "-") out.push(l.slice(1));
    } else {
      for (const l of h.lines) if (l[0] !== "+") out.push(l.slice(1));
    }
    i += h.oldLines;
  }
  while (i < src.length) out.push(src[i++]);
  return out.join("\n").replace(/\n/g, eol);
}
