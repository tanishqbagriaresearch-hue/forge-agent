// Usage: npm run provision -- [forge-agent.config.json]
// Registers each configured model as an OpenAI-compatible provider in a running local TrueForge.
import fs from "node:fs";
import { upsertModelProvider } from "../src/forge/provision";

const file = process.argv[2] ?? "forge-agent.config.json";
if (!fs.existsSync(file)) { console.error(`Config not found: ${file}. Copy forge-agent.config.example.json first.`); process.exit(1); }
const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
for (const m of cfg.models) {
  const apiKey = process.env[m.apiKeyEnv];
  if (!apiKey) { console.warn(`skip ${m.name}: env ${m.apiKeyEnv} is not set`); continue; }
  await upsertModelProvider(cfg.baseUrl, { name: m.name, modelId: m.modelId, baseUrl: m.baseUrl, apiKey });
  console.log(`configured ${m.name} -> ${m.baseUrl}`);
}
