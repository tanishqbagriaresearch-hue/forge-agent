/** One OpenAI-compatible endpoint. TrueForge addresses it as `<provider>/<name>`. */
export type ModelSpec = { provider: string; name: string; modelId: string; baseUrl: string; apiKey?: string };

export const modelRef = (m: Pick<ModelSpec, "provider" | "name">) => `${m.provider}/${m.name}`;

const LOCAL_HINT =
  " TrueForge blocks private/loopback URLs by default. Start it with OUTBOUND_URL_ALLOWED_HOSTS='[\"127.0.0.1\"]' (or NETWORK_POLICY_ENABLED=false) so it can reach your local model and the extension's MCP server.";

async function put(baseUrl: string, path: string, body: unknown, f: typeof fetch): Promise<void> {
  const res = await f(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const hint = /Outbound URL blocked/i.test(text) ? LOCAL_HINT : "";
    throw new Error(`TrueForge ${path} failed: ${res.status} ${text.slice(0, 300)}.${hint}`);
  }
}

export async function upsertModelProvider(baseUrl: string, m: ModelSpec, f: typeof fetch = fetch): Promise<void> {
  await put(
    baseUrl,
    "/api/v1/settings/model-providers",
    {
      manifest: {
        type: "custom",
        name: m.provider,
        base_url: m.baseUrl,
        ...(m.apiKey ? { auth: { api_key: m.apiKey } } : {}),
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
