# Forge Agent: VS Code coding agent on TrueForge — Design

Approved by the user in conversation on 2026-11-22 ("its open build it").

## Intent and why
Submit a working entry to the Techfest 2026-27 TrueFoundry Forge-a-thon, Round 1.
Judges score what the extension does on screen across three fixed tasks on
pallets/flask 3.1.3 (commit 22d92470): A inline edit, B agent mode (3+ files, none named),
C resilience (unreachable endpoint or bad key, then repeat A). Artefacts: demo video,
1-3 page PDF write-up with 8 fixed headings, public GitHub repo.

Eligibility gate: the agent loop runs on TrueForge (local mode, `npx @truefoundry/trueforge`).
The extension is an SDK/HTTP client of a TrueForge agent, renders streamed events, exposes
editor capabilities as MCP tools, and never calls a model provider directly.

## Goals
- All five mandatory capabilities: inline edit, agent mode, context assembly, diff review, streaming + cancellation.
- Score high on the anchors: per-hunk accept/reject + working undo (B2=10); retrieval with a size
  budget visibly at work in Task B (B1=15); automatic fallback to a second model with workspace
  unchanged (B3=10); MCP tools + TrueForge approval driving diff review + a context-engineering
  feature (B4=10); immediate cancellation leaving workspace consistent (A3=10).
- Works with any model configured in TrueForge (no provider coupling).
- Repo that works from a clean clone; no secrets committed; MIT licence.

## Non-goals
Tab completion, training/hosting a model, hosted backend, auth, Marketplace publishing.

## Anti-goals
- Any direct provider call from the extension (ineligible).
- Any write to disk before the user accepts a hunk.
- Retrieval that depends on embeddings from a specific provider.

## Constraints
- Node >= 22.14; TrueForge SDK `@truefoundry/trueforge-sdk` (0.185.0 at time of writing).
- Fallback models/retry are undocumented in TrueForge: implemented in the extension by
  opening a new TrueForge session on the next configured model.
- Cannot be recorded or published by Claude: video, GitHub publication, team details, model cost.

## Approaches
1. **From scratch, TypeScript, TrueForge SDK client (chosen).** No fork point, no licence risk,
   no upstream loop to remove. Cost: write webview and diff plumbing ourselves.
2. Fork Cline/Continue/Roo and replace the loop. Rejected: their state and UI are woven into their
   own loop; leftover loop code is an eligibility failure; too risky in the time.
3. Thin wrapper around opencode/CLI. Rejected: not editor-native, weak diff review.

## Design
- **Extension host** (`src/`): activates commands `forgeAgent.inlineEdit` (Ctrl/Cmd+K, Ctrl/Cmd+I fallback),
  `forgeAgent.openPanel`, `forgeAgent.stop`, `forgeAgent.undo`.
- **TrueForge client**: `sessions.create({agent:{spec|name}})`, `createTurnStream`, handle
  `model.message.delta`, `model.message`, `tool.approval_required`, `turn.done`; `sessions.cancel` on Stop;
  `subscribeToTurn` with `afterEventId` after approvals.
- **Editor MCP server** (localhost, streamable HTTP, started by the extension; registered with
  TrueForge): `read_file`, `search_workspace`, `find_symbol`, `retrieve_context`, `list_dir`,
  `propose_edit` (stages into an in-memory overlay, never disk), `apply_changes` (approval-gated),
  `run_command`.
- **Diff safety**: `apply_changes` raises `tool.approval_required`; the extension opens per-hunk review
  (native `vscode.diff` on a virtual doc plus CodeLens/QuickPick accept/reject per hunk). Accepted hunks
  are written via `WorkspaceEdit` after a snapshot; result is returned to the agent (which hunks were
  applied). `forgeAgent.undo` restores the snapshot.
- **Context**: local symbol-level chunker + BM25 index with a token budget; `@file`/`@symbol`
  mentions; `retrieve_context(query, budget)` returns ranked chunks with reasons; panel shows chosen
  files and why. Agent spec enables subagents and context compaction.
- **Resilience**: classify errors, retry with exponential backoff, then fallback to next configured
  model (new session). Because writes are gated, workspace stays unchanged. Clear message if all fail.
- **Cancellation**: Stop calls `sessions.cancel`, discards the overlay, closes diff editors; the UI
  never blocks (all work async).
- **Config**: `forgeAgent.*` settings (baseUrl, models[], agentName, tokenBudget); example
  `forge-agent.config.example.json`; no keys in repo.
- **Agent definition**: `agent/forge-agent.agent.json` (instructions, model, MCP tools, runtime config).

## Left to the builder
Exact UI polish, chunking heuristics, webview markup, and how to register the MCP server with
TrueForge (to be confirmed by probing a running instance).
