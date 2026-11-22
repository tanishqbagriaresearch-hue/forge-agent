import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listFiles } from "../src/workspace/walk";
import { chunkFile } from "../src/context/chunker";
import { Bm25 } from "../src/context/bm25";
import { ContextIndex } from "../src/context/index";

let root: string;
const w = (rel: string, body: string | Buffer) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-"));
  w("src/flask/helpers.py", [
    "import os",
    "",
    "def get_load_dotenv(default: bool = True) -> bool:",
    '    """Get whether the user has disabled loading default dotenv files."""',
    '    val = os.environ.get("FLASK_SKIP_DOTENV")',
    "    return not val",
    "",
    "def get_debug_flag() -> bool:",
    '    """Get whether debug mode should be enabled for the app, indicated by the',
    "    FLASK_DEBUG environment variable. The default is False.",
    '    """',
    '    val = os.environ.get("FLASK_DEBUG")',
    '    return bool(val and val.lower() not in {"0", "false", "no"})',
    "",
    "class Helper:",
    '    """Unrelated helper."""',
    "    def run(self):",
    "        return 1",
  ].join("\n") + "\n");
  w("src/flask/cli.py", [
    "import click",
    "",
    "@click.command('routes')",
    "def routes_command():",
    '    """Show all registered routes with endpoints and methods."""',
    "    pass",
    "",
    "def shell_command():",
    '    """Run an interactive Python shell in the context of a given application."""',
    "    pass",
  ].join("\n") + "\n");
  w("node_modules/dep/index.js", "function ignored() {}\n");
  w("bin.dat", Buffer.from([0, 1, 2, 0, 3]));
  w("big.txt", "x".repeat(500_000));
});

describe("walk", () => {
  it("lists text files, skipping node_modules, binary and oversized files", async () => {
    const files = (await listFiles(root)).sort();
    expect(files).toEqual(["src/flask/cli.py", "src/flask/helpers.py"]);
  });
});

describe("chunker", () => {
  it("makes symbol-level python chunks with line ranges", () => {
    const text = fs.readFileSync(path.join(root, "src/flask/helpers.py"), "utf8");
    const chunks = chunkFile("src/flask/helpers.py", text);
    const g = chunks.find((c) => c.symbol === "get_debug_flag")!;
    expect(g.kind).toBe("function");
    expect(g.startLine).toBe(8);
    expect(g.endLine).toBe(13);
    expect(g.text).toContain("FLASK_DEBUG");
    expect(chunks.find((c) => c.symbol === "Helper")).toBeTruthy();
  });
  it("caps chunk length at 120 lines", () => {
    const text = "def big():\n" + "    x = 1\n".repeat(400);
    const chunks = chunkFile("a.py", text);
    expect(Math.max(...chunks.map((c) => c.endLine - c.startLine + 1))).toBeLessThanOrEqual(120);
  });
  it("falls back to windows for unknown file types", () => {
    const chunks = chunkFile("notes.txt", "l\n".repeat(100));
    expect(chunks.every((c) => c.kind === "window")).toBe(true);
    expect(chunks.length).toBeGreaterThan(1);
  });
});

describe("bm25", () => {
  it("scores the matching doc highest and splits snake/camel case", () => {
    const b = new Bm25(["get_debug_flag environment", "unrelated routes", "getDebugFlag camelCase"]);
    const s = b.score("debug flag");
    expect(s[0]).toBeGreaterThan(s[1]);
    expect(s[2]).toBeGreaterThan(s[1]);
  });
});

describe("ContextIndex", () => {
  it("ranks get_debug_flag first for a debug-flag query and explains why", async () => {
    const idx = await ContextIndex.build(root);
    const r = idx.retrieve("debug flag environment variable", 4000);
    expect(r[0].symbol).toBe("get_debug_flag");
    expect(r[0].why).toMatch(/matched: .*debug/);
  });
  it("never exceeds the token budget and returns [] for budget 0", async () => {
    const idx = await ContextIndex.build(root);
    const r = idx.retrieve("debug flag environment variable routes shell", 120);
    const tokens = r.reduce((n, c) => n + Math.ceil(c.text.length / 4), 0);
    expect(tokens).toBeLessThanOrEqual(120);
    expect(idx.retrieve("debug", 0)).toEqual([]);
  });
  it("never returns two chunks covering the same lines", async () => {
    const idx = await ContextIndex.build(root);
    const r = idx.retrieve("flask helper debug dotenv", 4000);
    for (const a of r) for (const b of r) {
      if (a !== b && a.path === b.path) expect(a.endLine < b.startLine || b.endLine < a.startLine).toBe(true);
    }
  });
  it("findSymbol returns the definition range; update() reflects edits", async () => {
    const idx = await ContextIndex.build(root);
    const f = idx.findSymbol("get_debug_flag");
    expect(f).toHaveLength(1);
    expect([f[0].startLine, f[0].endLine]).toEqual([8, 13]);
    idx.update("src/flask/new.py", "def brand_new_function():\n    return 'zebra'\n");
    expect(idx.retrieve("zebra", 1000)[0].symbol).toBe("brand_new_function");
    idx.update("src/flask/new.py", null);
    expect(idx.retrieve("zebra", 1000)).toEqual([]);
  });
});
