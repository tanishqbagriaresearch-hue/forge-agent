import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { activate, deactivate } from "../src/extension";
import { isIgnoredPath } from "../src/workspace/walk";

const fake = vscode as any;

describe("extension activation (fake vscode)", () => {
  beforeEach(() => {
    fake.registered.clear();
    fake.workspace.workspaceFolders = [{ uri: vscode.Uri.file(fs.mkdtempSync(path.join(os.tmpdir(), "act-"))) }];
  });

  it("registers every command without starting TrueForge", async () => {
    const ctx = { subscriptions: [] as any[], extensionUri: vscode.Uri.file("/ext"), workspaceState: { get: () => undefined, update: async () => {} } };
    await activate(ctx as any);
    for (const id of ["forgeAgent.inlineEdit", "forgeAgent.openPanel", "forgeAgent.stop", "forgeAgent.undo", "forgeAgent.switchModel", "forgeAgent.hunk.toggle", "forgeAgent.review.apply", "forgeAgent.review.rejectAll"])
      expect(fake.registered.has(id), id).toBe(true);
    await expect(deactivate()).resolves.toBeUndefined();
  });

  it("registers commands that explain themselves when no folder is open", async () => {
    fake.workspace.workspaceFolders = undefined;
    await activate({ subscriptions: [], extensionUri: vscode.Uri.file("/ext"), workspaceState: { get: () => undefined, update: async () => {} } } as any);
    expect(fake.registered.has("forgeAgent.inlineEdit")).toBe(true);
    await expect(fake.registered.get("forgeAgent.inlineEdit")()).resolves.toBeUndefined();
  });
});

describe("isIgnoredPath", () => {
  it("ignores dependency and VCS directories at any depth", () => {
    expect(isIgnoredPath("node_modules/x/index.js")).toBe(true);
    expect(isIgnoredPath("a/.git/config")).toBe(true);
    expect(isIgnoredPath("src/flask/cli.py")).toBe(false);
  });
});

describe("package.json contributions", () => {
  it("every contributed command and keybinding command is registered on activation", async () => {
    fake.registered.clear();
    fake.workspace.workspaceFolders = [{ uri: vscode.Uri.file(fs.mkdtempSync(path.join(os.tmpdir(), "act-"))) }];
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    const ctx = { subscriptions: [] as any[], extensionUri: vscode.Uri.file("/ext"), workspaceState: { get: () => undefined, update: async () => {} } };
    await activate(ctx as any);
    const ids = [...pkg.contributes.commands.map((c: any) => c.command), ...pkg.contributes.keybindings.map((k: any) => k.command)];
    for (const id of ids) expect(fake.registered.has(id), id).toBe(true);
    await deactivate();
  });
});
