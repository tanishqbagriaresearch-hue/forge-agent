import { describe, it, expect } from "vitest";
import { UndoStack } from "../src/workspace/snapshot";

describe("UndoStack", () => {
  it("pops entries last-in-first-out and reports size", () => {
    const u = new UndoStack();
    u.push({ label: "one", files: [{ abs: "/r/a", before: "1", after: "2" }] });
    u.push({ label: "two", files: [{ abs: "/r/b", before: null, after: "x" }] });
    expect(u.size()).toBe(2);
    expect(u.pop()!.label).toBe("two");
    expect(u.pop()!.label).toBe("one");
    expect(u.pop()).toBeUndefined();
    expect(u.size()).toBe(0);
  });
});
