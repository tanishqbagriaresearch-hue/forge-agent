import fs from "node:fs/promises";
import path from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules", "venv", ".venv", "__pycache__", "dist", ".tox", ".mypy_cache", ".pytest_cache", ".idea", ".vscode-test"]);

export async function listFiles(root: string, opts: { maxBytes?: number } = {}): Promise<string[]> {
  const maxBytes = opts.maxBytes ?? 400_000;
  const out: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await visit(abs);
      } else if (e.isFile()) {
        try {
          const st = await fs.stat(abs);
          if (st.size > maxBytes) continue;
          const fh = await fs.open(abs, "r");
          const buf = Buffer.alloc(Math.min(4096, st.size));
          await fh.read(buf, 0, buf.length, 0);
          await fh.close();
          if (buf.includes(0)) continue;
          out.push(path.relative(root, abs).split(path.sep).join("/"));
        } catch { /* unreadable: skip */ }
      }
    }
  }
  await visit(root);
  return out;
}
