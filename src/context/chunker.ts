export type Chunk = { path: string; startLine: number; endLine: number; symbol?: string; kind: "function" | "class" | "window"; text: string };

const MAX_LINES = 120;
const WINDOW = 40;
const indentOf = (l: string) => l.length - l.trimStart().length;
const blank = (l: string) => l.trim() === "";

type Range = { s: number; e: number; symbol: string; kind: "function" | "class" }; // 0-based inclusive

function trimEnd(lines: string[], s: number, e: number): number {
  while (e > s && blank(lines[e])) e--;
  return e;
}

function pythonRanges(lines: string[]): Range[] {
  const re = /^(\s*)(?:async\s+def|def|class)\s+([A-Za-z_]\w*)/;
  const out: Range[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const isClass = /^\s*class\b/.test(lines[i]);
    let s = i;
    while (s > 0 && /^\s*@/.test(lines[s - 1]) && indentOf(lines[s - 1]) === indent) s--;
    // skip a multi-line signature
    let depth = 0, k = i, bodyStart = i + 1;
    for (; k < lines.length; k++) {
      const code = lines[k].split("#")[0];
      for (const ch of code) { if ("([{".includes(ch)) depth++; else if (")]}".includes(ch)) depth--; }
      if (depth <= 0 && code.trimEnd().endsWith(":")) { bodyStart = k + 1; break; }
    }
    let e = bodyStart - 1;
    for (let j = bodyStart; j < lines.length; j++) {
      if (blank(lines[j])) continue;
      const ind = indentOf(lines[j]);
      if (ind <= indent) break;
      if (isClass && ind > indent && re.test(lines[j])) {
        // class header ends where the first nested def/class (and its decorators) begins
        let h = j;
        while (h > bodyStart && /^\s*@/.test(lines[h - 1])) h--;
        e = h - 1;
        break;
      }
      e = j;
    }
    e = trimEnd(lines, s, e);
    out.push({ s, e: Math.min(e, s + MAX_LINES - 1), symbol: m[2], kind: isClass ? "class" : "function" });
  }
  return out;
}

function jsRanges(lines: string[]): Range[] {
  const re = /^(?:export\s+)?(?:default\s+)?(?:(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)|(class)\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>)/;
  const starts: { i: number; symbol: string; kind: "function" | "class" }[] = [];
  lines.forEach((l, i) => {
    const m = re.exec(l);
    if (m) starts.push({ i, symbol: (m[1] ?? m[3] ?? m[4])!, kind: m[2] ? "class" : "function" });
  });
  return starts.map((st, idx) => {
    const next = idx + 1 < starts.length ? starts[idx + 1].i - 1 : lines.length - 1;
    const e = trimEnd(lines, st.i, next);
    return { s: st.i, e: Math.min(e, st.i + MAX_LINES - 1), symbol: st.symbol, kind: st.kind };
  });
}

export function chunkFile(path: string, text: string): Chunk[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  let ranges: Range[] = [];
  if (ext === "py") ranges = pythonRanges(lines);
  else if (["js", "jsx", "ts", "tsx", "mjs", "cjs"].includes(ext)) ranges = jsRanges(lines);

  const chunks: Chunk[] = ranges.map((r) => ({
    path, startLine: r.s + 1, endLine: r.e + 1, symbol: r.symbol, kind: r.kind, text: lines.slice(r.s, r.e + 1).join("\n"),
  }));
  // cover everything not inside a symbol chunk with fixed windows
  const covered = new Array(lines.length).fill(false);
  for (const r of ranges) for (let i = r.s; i <= r.e; i++) covered[i] = true;
  for (let i = 0; i < lines.length; ) {
    if (covered[i]) { i++; continue; }
    let j = i;
    while (j < lines.length && !covered[j]) j++;
    for (let s = i; s < j; s += WINDOW) {
      const e = Math.min(s + WINDOW, j) - 1;
      const slice = lines.slice(s, e + 1);
      if (slice.filter((l) => !blank(l)).length >= 2)
        chunks.push({ path, startLine: s + 1, endLine: e + 1, kind: "window", text: slice.join("\n") });
    }
    i = j;
  }
  return chunks.sort((a, b) => a.startLine - b.startLine);
}
