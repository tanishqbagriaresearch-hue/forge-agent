import path from "node:path";

export function resolveInWorkspace(root: string, p: string): string {
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) throw new Error("outside workspace");
  return abs;
}
