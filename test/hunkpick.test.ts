import { describe, it, expect } from "vitest";
import { hunkPickItems, decisionsFromPicks } from "../src/ui/hunkPick";
import { computeHunks } from "../src/workspace/hunks";

const item = (abs: string, a: string, b: string) => ({ abs, original: a, proposed: b, hunks: computeHunks(a, b) });
const lines = (n: number, ch: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => ch[i + 1] ?? `l${i + 1}`).join("\n") + "\n";

describe("hunk picker (works without CodeLens)", () => {
  const items = [item("/w/a.py", lines(40), lines(40, { 2: "A", 38: "B" })), item("/w/b.py", lines(5), lines(5, { 3: "C" }))];
  it("lists every hunk of every file, labelled with relative path and counts", () => {
    const picks = hunkPickItems(items, "/w");
    expect(picks.map((p) => p.label)).toEqual(["a.py · hunk 1/2", "a.py · hunk 2/2", "b.py · hunk 1/1"]);
    expect(picks.every((p) => p.description?.match(/^\+\d+ −\d+/))).toBe(true);
  });
  it("turns the picked entries back into per-file accepted hunk ids", () => {
    const picks = hunkPickItems(items, "/w");
    const m = decisionsFromPicks([picks[0], picks[2]]);
    expect([...m.get("/w/a.py")!]).toEqual([1]);
    expect([...m.get("/w/b.py")!]).toEqual([1]);
  });
  it("no picks means nothing accepted", () => expect(decisionsFromPicks([]).size).toBe(0));
});
