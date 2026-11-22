import fs from "node:fs";
import path from "node:path";

const outside = (root: string, abs: string) => {
  const rel = path.relative(root, abs);
  return rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
};

/** Real path of the nearest existing ancestor (following symlinks), with the not-yet-existing tail re-appended. */
function realWithTail(abs: string): string {
  let cur = abs; const tail: string[] = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...tail.reverse()); }
    catch { const parent = path.dirname(cur); if (parent === cur) return abs; tail.push(path.basename(cur)); cur = parent; }
  }
}

export function resolveInWorkspace(root: string, p: string): string {
  const abs = path.resolve(root, p);
  if (outside(root, abs)) throw new Error("outside workspace");
  let realRoot: string;
  try { realRoot = fs.realpathSync(root); } catch { return abs; }
  if (outside(realRoot, realWithTail(abs))) throw new Error("outside workspace");
  return abs;
}
