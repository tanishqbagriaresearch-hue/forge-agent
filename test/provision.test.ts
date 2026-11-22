import { describe, it, expect } from "vitest";
import { upsertModelProvider, upsertMcpServer } from "../src/forge/provision";

function fakeFetch(status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(status === 200 ? "{}" : "boom", { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("provision", () => {
  it("PUTs an openai-type provider with base_url, key and one model", async () => {
    const { f, calls } = fakeFetch();
    await upsertModelProvider(
      "http://localhost:8790",
      { name: "mockgood", modelId: "mock-1", baseUrl: "http://127.0.0.1:9999/v1", apiKey: "k" },
      f,
    );
    expect(calls[0].url).toBe("http://localhost:8790/api/v1/settings/model-providers");
    expect(calls[0].init.method).toBe("PUT");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.manifest.type).toBe("openai");
    expect(body.manifest.base_url).toBe("http://127.0.0.1:9999/v1");
    expect(body.manifest.auth.api_key).toBe("k");
    expect(body.manifest.models).toEqual([{ model_id: "mock-1", name: "mockgood", properties: {} }]);
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
