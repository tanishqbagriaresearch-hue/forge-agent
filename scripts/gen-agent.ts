// Regenerates agent/forge-agent.agent.json from buildAgentSpec (a test guards against drift).
import fs from "node:fs";
import { buildAgentSpec } from "../src/agent/spec";
fs.mkdirSync("agent", { recursive: true });
fs.writeFileSync("agent/forge-agent.agent.json", JSON.stringify(buildAgentSpec("<model>", "forge-editor"), null, 2) + "\n");
console.log("wrote agent/forge-agent.agent.json");
