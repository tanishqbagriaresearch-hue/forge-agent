// Usage: npm run provision -- [forge-agent.config.json]
// Registers each configured custom OpenAI-compatible endpoint in a running local TrueForge.
import fs from "node:fs";
import { upsertModelProvider, modelRef, specFromProviderCfg } from "../src/forge/provision";

const file = process.argv[2] ?? "forge-agent.config.json";
if (!fs.existsSync(file)) { console.error(`Config not found: ${file}. Copy forge-agent.config.example.json first.`); process.exit(1); }
const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
const registered: string[] = [];
for (const p of cfg.providers ?? []) {
  const apiKey = p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined;
  if (p.apiKeyEnv && !apiKey) { console.warn(`skip ${p.provider}: env ${p.apiKeyEnv} is not set`); continue; }
  const spec = specFromProviderCfg(p, apiKey);
  await upsertModelProvider(cfg.baseUrl, spec);
  const ref = modelRef(spec);
  registered.push(ref);
  console.log(`configured ${ref} -> ${p.baseUrl}`);
}
for (const m of cfg.models ?? []) {
  if (!registered.includes(m)) console.warn(`WARNING: "${m}" in the config's "models" list was not just registered (registered refs: ${registered.join(", ") || "none"}). forgeAgent.models must use the "configured ..." refs printed above.`);
}
console.log(`Use these in the forgeAgent.models setting: ${JSON.stringify(cfg.models)}`);
