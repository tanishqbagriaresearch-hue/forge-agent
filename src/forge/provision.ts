export type ModelSpec = { name: string; modelId: string; baseUrl: string; apiKey: string };

async function put(baseUrl: string, path: string, body: unknown, f: typeof fetch): Promise<void> {
  const res = await f(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`TrueForge ${path} failed: ${res.status} ${text.slice(0, 300)}`);
  }
}

export async function upsertModelProvider(baseUrl: string, m: ModelSpec, f: typeof fetch = fetch): Promise<void> {
  await put(
    baseUrl,
    "/api/v1/settings/model-providers",
    {
      manifest: {
        type: "openai",
        base_url: m.baseUrl,
        auth: { api_key: m.apiKey },
        models: [{ model_id: m.modelId, name: m.name, properties: {} }],
      },
    },
    f,
  );
}

export async function upsertMcpServer(baseUrl: string, name: string, url: string, f: typeof fetch = fetch): Promise<void> {
  await put(
    baseUrl,
    "/api/v1/settings/mcp-servers",
    { manifest: { type: "remote", name, url, description: "Forge Agent editor tools (read, search, retrieve, stage, apply, run)" } },
    f,
  );
}
