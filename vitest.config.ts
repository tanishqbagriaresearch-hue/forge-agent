import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 30000 },
  resolve: { alias: { vscode: path.resolve(__dirname, "test/fakes/vscode.ts") } },
});
