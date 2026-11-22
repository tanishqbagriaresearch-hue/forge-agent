import { describe, it, expect } from "vitest";
import { computeHunks, applyHunks } from "../src/workspace/hunks";

const lines = (n: number, edits: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => edits[i + 1] ?? `line${i + 1}`).join("\n") + "\n";

describe("hunks", () => {
  it("yields one hunk for one change", () => {
    const hs = computeHunks("a\nb\nc\n", "a\nB\nc\n");
    expect(hs).toHaveLength(1);
    expect(hs[0].id).toBe(1);
    expect(hs[0].lines).toContain("-b");
    expect(hs[0].lines).toContain("+B");
  });

  it("yields two hunks for distant changes and applies only the accepted one", () => {
    const oldT = lines(30);
    const newT = lines(30, { 2: "TWO", 25: "TWENTYFIVE" });
    const hs = computeHunks(oldT, newT);
    expect(hs.map((h) => h.id)).toEqual([1, 2]);
    const only2 = applyHunks(oldT, hs, new Set([2]));
    expect(only2).toBe(lines(30, { 25: "TWENTYFIVE" }));
    expect(applyHunks(oldT, hs, new Set([1, 2]))).toBe(newT);
    expect(applyHunks(oldT, hs, new Set())).toBe(oldT);
  });

  it("keeps CRLF line endings", () => {
    const oldT = "a\r\nb\r\nc\r\n";
    const hs = computeHunks(oldT, "a\r\nB\r\nc\r\n");
    expect(applyHunks(oldT, hs, new Set([1]))).toBe("a\r\nB\r\nc\r\n");
    expect(applyHunks(oldT, hs, new Set())).toBe(oldT);
  });

  it("preserves a missing trailing newline", () => {
    const oldT = "a\nb";
    const hs = computeHunks(oldT, "a\nB");
    expect(applyHunks(oldT, hs, new Set([1]))).toBe("a\nB");
    const hs2 = computeHunks("a\nb", "a\nb\nc");
    expect(applyHunks("a\nb", hs2, new Set([1]))).toBe("a\nb\nc");
  });

  it("handles creation of a file from empty", () => {
    const hs = computeHunks("", "x\ny\n");
    expect(applyHunks("", hs, new Set([1]))).toBe("x\ny\n");
  });

  it("returns no hunks for identical text", () => {
    expect(computeHunks("same\n", "same\n")).toEqual([]);
  });
});

describe("mixed line endings", () => {
  it("keeps each untouched line's own ending (LF-dominant file)", () => {
    const oldT = "a\r\nb\nc\n";
    const hs = computeHunks(oldT, "a\nB\nc\n");
    expect(applyHunks(oldT, hs, new Set([1]))).toBe("a\r\nB\nc\n");
  });
  it("uses the dominant ending for new lines (CRLF-dominant file)", () => {
    const oldT = "a\r\nb\r\nc\n";
    const hs = computeHunks(oldT, "a\r\nB\r\nc\r\n");
    expect(applyHunks(oldT, hs, new Set([1]))).toBe("a\r\nB\r\nc\n");
  });
  it("rejecting every hunk returns the file byte-for-byte", () => {
    const oldT = "a\r\nb\nc";
    expect(applyHunks(oldT, computeHunks(oldT, "a\nB\nc"), new Set())).toBe(oldT);
  });
});
