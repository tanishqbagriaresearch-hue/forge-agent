import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCore } from "../src/core";
import { HeadlessHost } from "../src/headlessHost";

async function mk() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "core-"));
  fs.writeFileSync(path.join(root, "a.py"), "def f():\n    return 1\n");
  const host = new HeadlessHost(root);
  const core = await createCore({
    host, baseUrl: "http://localhost:1", models: ["m/m"], tokenBudget: 1000,
    events: { delta() {}, toolCall() {}, toolResult() {}, status() {}, notice() {} },
    provision: async () => {},
  });
  return { root, host, core };
}

describe("core", () => {
  it("starts an editor MCP server and builds the index", async () => {
    const { core } = await mk();
    expect(core.mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(core.index.findSymbol("f")).toHaveLength(1);
    await core.close();
  });

  it("undoLast restores the previous content and reports the label", async () => {
    const { root, core } = await mk();
    const abs = path.join(root, "a.py");
    const before = fs.readFileSync(abs, "utf8");
    fs.writeFileSync(abs, "CHANGED\n");
    core.undo.push({ label: "edit a.py", files: [{ abs, before, after: "CHANGED\n" }] });
    const r = await core.undoLast();
    expect(r).toEqual({ ok: true, message: "Undid: edit a.py" });
    expect(fs.readFileSync(abs, "utf8")).toBe(before);
    await core.close();
  });

  it("undoLast deletes a file the agent created", async () => {
    const { root, core } = await mk();
    const abs = path.join(root, "new.py");
    fs.writeFileSync(abs, "x\n");
    core.undo.push({ label: "create", files: [{ abs, before: null, after: "x\n" }] });
    expect((await core.undoLast()).ok).toBe(true);
    expect(fs.existsSync(abs)).toBe(false);
    await core.close();
  });

  it("undoLast refuses to clobber a file edited since, and keeps the entry for later", async () => {
    const { root, core } = await mk();
    const abs = path.join(root, "a.py");
    core.undo.push({ label: "edit", files: [{ abs, before: "OLD\n", after: "AGENT\n" }] });
    fs.writeFileSync(abs, "USER EDITED AFTER\n");
    const r = await core.undoLast();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/changed since/i);
    expect(fs.readFileSync(abs, "utf8")).toBe("USER EDITED AFTER\n");
    expect(core.undo.size()).toBe(1);
    await core.close();
  });

  it("undoLast with nothing to undo says so", async () => {
    const { core } = await mk();
    expect(await core.undoLast()).toEqual({ ok: false, message: "Nothing to undo." });
    await core.close();
  });
});
