import * as vscode from "vscode";

export type ProviderCfg = { provider: string; name?: string; modelId: string; baseUrl: string; apiKeyEnv?: string };
export type Config = {
  baseUrl: string; models: string[]; providers: ProviderCfg[];
  tokenBudget: number; mcpPort: number; autoApproveCommands: string[];
};

export function readConfig(): Config {
  const c = vscode.workspace.getConfiguration("forgeAgent");
  return {
    baseUrl: c.get<string>("baseUrl", "http://localhost:8790"),
    models: c.get<string[]>("models", []),
    providers: c.get<ProviderCfg[]>("providers", []),
    tokenBudget: c.get<number>("tokenBudget", 6000),
    mcpPort: c.get<number>("mcpPort", 0),
    autoApproveCommands: c.get<string[]>("autoApproveCommands", ["^pytest", "^python -m pytest", "^flask "]),
  };
}
