import { describe, it, expect } from "vitest";
import { upsertModelProvider, upsertMcpServer, modelRef, specFromProviderCfg, slugifyModelName } from "../src/forge/provision";

function fakeFetch(status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(status === 200 ? "{}" : "boom", { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("provision", () => {
  it("PUTs a custom provider (own base_url) with one model and optional key", async () => {
    const { f, calls } = fakeFetch();
    const spec = { provider: "mockgood", name: "mockgood", modelId: "mock-1", baseUrl: "http://127.0.0.1:9999/v1", apiKey: "k" };
    await upsertModelProvider("http://localhost:8790", spec, f);
    expect(calls[0].url).toBe("http://localhost:8790/api/v1/settings/model-providers");
    expect(calls[0].init.method).toBe("PUT");
    const m = JSON.parse(calls[0].init.body as string).manifest;
    expect(m.type).toBe("custom");
    expect(m.name).toBe("mockgood");
    expect(m.base_url).toBe("http://127.0.0.1:9999/v1");
    expect(m.auth).toEqual({ api_key: "k" });
    expect(m.models).toEqual([{ model_id: "mock-1", name: "mockgood", properties: {} }]);
    expect(modelRef(spec)).toBe("mockgood/mockgood");
  });

  it("omits auth when no key is given (keyless local models)", async () => {
    const { f, calls } = fakeFetch();
    await upsertModelProvider("http://localhost:8790", { provider: "local", name: "qwen", modelId: "q", baseUrl: "http://127.0.0.1:11434/v1" }, f);
    expect(JSON.parse(calls[0].init.body as string).manifest.auth).toBeUndefined();
  });

  it("explains the localhost allowlist when TrueForge blocks a local URL", async () => {
    const blocked = (async () => new Response('{"error":{"message":"Outbound URL blocked for host \\"127.0.0.1\\""}}', { status: 400 })) as unknown as typeof fetch;
    await expect(upsertMcpServer("http://localhost:8790", "forge-editor", "http://127.0.0.1:5/mcp", blocked)).rejects.toThrow(/OUTBOUND_URL_ALLOWED_HOSTS/);
  });

  it("PUTs a remote MCP server manifest", async () => {
    const { f, calls } = fakeFetch();
    await upsertMcpServer("http://localhost:8790", "forge-editor", "http://127.0.0.1:5000/mcp", f);
    expect(calls[0].url).toBe("http://localhost:8790/api/v1/settings/mcp-servers");
    const m = JSON.parse(calls[0].init.body as string).manifest;
    expect(m.type).toBe("remote");
    expect(m.name).toBe("forge-editor");
    expect(m.url).toBe("http://127.0.0.1:5000/mcp");
    expect(typeof m.description).toBe("string");
  });

  it("throws with the status code on non-2xx", async () => {
    const { f } = fakeFetch(500);
    await expect(upsertMcpServer("http://localhost:8790", "x-y", "http://a/mcp", f)).rejects.toThrow(/500/);
  });
});

describe("specFromProviderCfg", () => {
  it("defaults the model name to a slug of modelId (plain ids need no change), carrying the API key", () => {
    const spec = specFromProviderCfg({ provider: "primary", modelId: "gpt4plain", baseUrl: "https://x/v1" }, "key123");
    expect(modelRef(spec)).toBe("primary/gpt4plain");
    expect(spec.apiKey).toBe("key123");
  });
  it("still honours an explicit name override", () => {
    const spec = specFromProviderCfg({ provider: "primary", name: "custom", modelId: "gemini-2.5-flash", baseUrl: "https://x/v1" });
    expect(modelRef(spec)).toBe("primary/custom");
  });
});

describe("slugifyModelName", () => {
  it("replaces dots and other invalid characters with hyphens, lowercased", () => {
    expect(slugifyModelName("gemini-2.5-flash")).toBe("gemini-2-5-flash");
    expect(slugifyModelName("Llama_3.3:70B")).toBe("llama-3-3-70b");
  });
  it("ensures the result starts with a letter and ends alphanumeric", () => {
    expect(slugifyModelName("3.5-turbo")).toMatch(/^[a-z]/);
    expect(slugifyModelName("model.")).toMatch(/[a-z0-9]$/);
  });
});

describe("specFromProviderCfg with a dotted modelId (TrueForge's real naming rule)", () => {
  it("defaults name to a TrueForge-valid slug of modelId, so the ref is usable in forgeAgent.models", () => {
    const spec = specFromProviderCfg({ provider: "primary", modelId: "gemini-2.5-flash", baseUrl: "https://x/v1" });
    expect(modelRef(spec)).toBe("primary/gemini-2-5-flash");
    expect(spec.name).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/);
  });
});
