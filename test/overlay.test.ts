import { describe, it, expect } from "vitest";
import { Overlay } from "../src/workspace/overlay";
import { resolveInWorkspace } from "../src/workspace/paths";

const mk = (files: Record<string, string>) =>
  new Overlay(async (abs) => (abs in files ? files[abs] : null));

describe("overlay", () => {
  it("stages an edit without touching the source and composes two edits", async () => {
    const files = { "/r/a.py": "x = 1\ny = 2\n" };
    const o = mk(files);
    await o.stageEdit("/r/a.py", "x = 1", "x = 10");
    await o.stageEdit("/r/a.py", "y = 2", "y = 20");
    const s = o.staged().get("/r/a.py")!;
    expect(s.original).toBe("x = 1\ny = 2\n");
    expect(s.proposed).toBe("x = 10\ny = 20\n");
    expect(files["/r/a.py"]).toBe("x = 1\ny = 2\n");
  });

  it("throws 'old_text not found' and stages nothing", async () => {
    const o = mk({ "/r/a.py": "x = 1\n" });
    await expect(o.stageEdit("/r/a.py", "zzz", "q")).rejects.toThrow("old_text not found");
    expect(o.staged().size).toBe(0);
  });

  it("throws 'old_text matches 2 places' for ambiguous text and stages nothing", async () => {
    const o = mk({ "/r/a.py": "a\na\n" });
    await expect(o.stageEdit("/r/a.py", "a", "b")).rejects.toThrow("old_text matches 2 places");
    expect(o.staged().size).toBe(0);
  });

  it("creates a new file when old_text is empty, refuses when the file exists", async () => {
    const o = mk({ "/r/a.py": "x\n" });
    await o.stageEdit("/r/new.py", undefined, "hello\n");
    expect(o.staged().get("/r/new.py")).toEqual({ original: null, proposed: "hello\n" });
    await expect(o.stageEdit("/r/a.py", "", "n")).rejects.toThrow(/already exists/);
  });

  it("matches old_text written with LF against a CRLF file and keeps CRLF", async () => {
    const o = mk({ "/r/w.txt": "a\r\nb\r\nc\r\n" });
    await o.stageEdit("/r/w.txt", "a\nb", "a\nB");
    expect(o.staged().get("/r/w.txt")!.proposed).toBe("a\r\nB\r\nc\r\n");
  });

  it("clear() empties the overlay", async () => {
    const o = mk({ "/r/a.py": "x\n" });
    await o.stageEdit("/r/a.py", "x", "y");
    o.clear();
    expect(o.staged().size).toBe(0);
  });
});

describe("resolveInWorkspace", () => {
  it("accepts relative and inside-absolute paths", () => {
    expect(resolveInWorkspace("/r", "src/a.py")).toBe("/r/src/a.py");
    expect(resolveInWorkspace("/r", "/r/src/a.py")).toBe("/r/src/a.py");
  });
  it("rejects escapes", () => {
    expect(() => resolveInWorkspace("/r", "../x")).toThrow("outside workspace");
    expect(() => resolveInWorkspace("/r", "/etc/passwd")).toThrow("outside workspace");
    expect(() => resolveInWorkspace("/r", "a/../../x")).toThrow("outside workspace");
  });
});
