// Usage: npm run provision -- [forge-agent.config.json]
// Registers each configured custom OpenAI-compatible endpoint in a running local TrueForge.
import fs from "node:fs";
import { upsertModelProvider, modelRef } from "../src/forge/provision";

const file = process.argv[2] ?? "forge-agent.config.json";
if (!fs.existsSync(file)) { console.error(`Config not found: ${file}. Copy forge-agent.config.example.json first.`); process.exit(1); }
const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
for (const p of cfg.providers ?? []) {
  const apiKey = p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined;
  if (p.apiKeyEnv && !apiKey) { console.warn(`skip ${p.provider}: env ${p.apiKeyEnv} is not set`); continue; }
  const spec = { provider: p.provider, name: p.name ?? p.provider, modelId: p.modelId, baseUrl: p.baseUrl, apiKey };
  await upsertModelProvider(cfg.baseUrl, spec);
  console.log(`configured ${modelRef(spec)} -> ${p.baseUrl}`);
}
console.log(`Use these in the forgeAgent.models setting: ${JSON.stringify(cfg.models)}`);
