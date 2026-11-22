import { describe, it, expect } from "vitest";
import { withFallback, isRetryable, isAuthError } from "../src/forge/resilience";

const mkOpts = () => {
  const events: { kind: string; model: string }[] = [];
  const sleeps: number[] = [];
  return {
    events, sleeps,
    o: { retries: 2, baseMs: 100, sleep: async (ms: number) => { sleeps.push(ms); }, onEvent: (e: { kind: string; model: string }) => events.push(e) } as any,
  };
};

describe("classification", () => {
  it("treats network and 5xx/429 as retryable", () => {
    for (const m of ["connect ECONNREFUSED 127.0.0.1:1", "fetch failed", "Connection error.", "503 Service Unavailable", "429 rate limit", "request timed out"])
      expect(isRetryable(new Error(m)), m).toBe(true);
  });
  it("treats TrueForge's connection wording as retryable", () => {
    for (const m of ["[Model Error] Cannot connect to API: bad port", "[Model Error] Cannot connect to API: other side closed"])
      expect(isRetryable(new Error(m)), m).toBe(true);
  });
  it("treats 401/403/invalid key as auth errors and not retryable", () => {
    for (const m of ["401 Unauthorized", "Incorrect API key provided", "403 Forbidden", "invalid api key"]) {
      expect(isAuthError(new Error(m)), m).toBe(true);
      expect(isRetryable(new Error(m)), m).toBe(false);
    }
  });
  it("reads statusCode from SDK-style errors", () => {
    expect(isAuthError(Object.assign(new Error("x"), { statusCode: 401 }))).toBe(true);
    expect(isRetryable(Object.assign(new Error("x"), { statusCode: 502 }))).toBe(true);
  });
});

describe("withFallback", () => {
  it("retries twice with exponential backoff, then falls back to the next model", async () => {
    const { o, events, sleeps } = mkOpts();
    const tried: string[] = [];
    const r = await withFallback(["a", "b"], async (m) => {
      tried.push(m);
      if (m === "a") throw new Error("ECONNREFUSED");
      return "ok-" + m;
    }, o);
    expect(r).toBe("ok-b");
    expect(tried).toEqual(["a", "a", "a", "b"]);
    expect(sleeps).toEqual([100, 200]);
    expect(events.map((e) => e.kind)).toEqual(["retry", "retry", "fallback"]);
  });

  it("falls back immediately on an auth error without retrying", async () => {
    const { o, sleeps } = mkOpts();
    const tried: string[] = [];
    const r = await withFallback(["a", "b"], async (m) => {
      tried.push(m);
      if (m === "a") throw new Error("401 Unauthorized");
      return m;
    }, o);
    expect(r).toBe("b");
    expect(tried).toEqual(["a", "b"]);
    expect(sleeps).toEqual([]);
  });

  it("rejects with the last error after every model fails and emits failed", async () => {
    const { o, events } = mkOpts();
    await expect(withFallback(["a", "b"], async (m) => { throw new Error("401 bad key " + m); }, o)).rejects.toThrow("bad key b");
    expect(events.at(-1)!.kind).toBe("failed");
  });

  it("does not retry non-retryable, non-auth errors and does not fall back", async () => {
    const { o } = mkOpts();
    const tried: string[] = [];
    await expect(withFallback(["a", "b"], async (m) => { tried.push(m); throw new Error("schema exploded"); }, o)).rejects.toThrow("schema exploded");
    expect(tried).toEqual(["a"]);
  });

  it("falls back without retrying on other [Model Error] failures", async () => {
    const { o, sleeps } = mkOpts();
    const tried: string[] = [];
    const r = await withFallback(["a", "b"], async (m) => {
      tried.push(m);
      if (m === "a") throw new Error("[Model Error] Request failed (404): Not Found");
      return m;
    }, o);
    expect(r).toBe("b");
    expect(tried).toEqual(["a", "b"]);
    expect(sleeps).toEqual([]);
  });
});
