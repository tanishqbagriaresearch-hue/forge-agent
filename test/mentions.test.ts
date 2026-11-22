import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseMentions, expandMentions } from "../src/context/mentions";
import { ContextIndex } from "../src/context/index";

describe("mentions", () => {
  it("parses @file and @sym: mentions", () => {
    const m = parseMentions("fix @src/a.py and @sym:foo now, mail me@x.com");
    expect(m.files).toEqual(["src/a.py"]);
    expect(m.symbols).toEqual(["foo"]);
  });
  it("expands files and symbols within the budget and flags truncation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "men-"));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src/a.py"), "def foo():\n    return 1\n" + "# pad\n".repeat(500));
    const idx = await ContextIndex.build(root);
    const out = await expandMentions({ files: ["src/a.py"], symbols: ["foo"], text: "" }, idx, root, 100);
    expect(out).toContain('<context file="src/a.py"');
    expect(out).toContain("[truncated]");
    expect(Math.ceil(out.length / 4)).toBeLessThan(400);
  });
  it("reports missing files instead of throwing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "men-"));
    const idx = await ContextIndex.build(root);
    const out = await expandMentions({ files: ["nope.py"], symbols: [], text: "" }, idx, root, 500);
    expect(out).toContain("not found");
  });
});
