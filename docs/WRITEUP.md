---
title: "Forge Agent — Write-up"
---

## 1. Team

[[Team name]] — [[Member 1, college, role]]; [[Member 2, college, role]]; [[Member 3 …]]. Contact: [[email]].

## 2. Starting point

**From scratch.** A new TypeScript VS Code extension (MIT); no upstream coding-agent fork, so no upstream code or licence is carried over. Dependencies: `@truefoundry/trueforge-sdk`, `@modelcontextprotocol/sdk`, `diff`, `zod`, `esbuild`, `vitest`. Repo: https://github.com/tanishqbagriaresearch-hue/forge-agent.

## 3. Architecture on TrueForge

The extension is only an SDK/HTTP client and an editor adapter; it never calls a model provider. The **agent loop runs in TrueForge** (local mode, `npx @truefoundry/trueforge@latest`).

* **Session per request.** `client.sessions.create` with a spec (`agent/forge-agent.agent.json`): instructions, `iterationLimit 40`, context compaction and large-tool-response handling on, subagents on. Turns stream via `createTurnStream`/`subscribeToTurn` (`model.message.delta`, `tool.response`, `turn.done`); we render tokens as they arrive.
* **Editor capabilities = MCP tools.** A localhost streamable-HTTP MCP server inside the extension (random port, secret URL path, loopback-only Host, no browser Origin) is registered in TrueForge (`PUT /api/v1/settings/mcp-servers`) and exposes `retrieve_context`, `read_file`, `list_dir`, `search_workspace`, `find_symbol`, `propose_edit`, `apply_changes`, `run_command`. Hot tools are *preloaded*; the rest use TrueForge's deferred `call_tool` path (we unwrap it for approvals).
* **Safety through TrueForge approvals.** `apply_changes` and `run_command` are in `requireApprovalForTools`. The turn pauses on `tool.approval_required`; the extension answers with `user.tool_approval` only after the human acts. `propose_edit` only stages edits in an in-memory overlay — disk is untouched until approval.
* **Diff review.** On `apply_changes` the overlay is shown as per-hunk diffs (a diff editor per file plus a checkbox list of hunks); only accepted hunks are written, in one `WorkspaceEdit` batch, with an undo snapshot and a conflict guard (refuses to undo if the file changed since).
* **Cancel.** Cancel races the stream against an abort signal, calls `sessions.cancel`, closes any pending review and clears the overlay (measured 8–16 ms in e2e); nothing is half-applied.
* **Fallback.** TrueForge documents no cross-model fallback, so the extension classifies `[Model Error]` failures (retry with backoff for transient ones; immediate fallback for auth/other) and opens a new session on the next model with a visible notice.

## 4. How context is selected

*Automatic retrieval:* on activation the workspace is chunked at **symbol level** (Python/JS/TS declarations, 40-line windows as fallback, 120-line cap) and indexed with **BM25** (stop-word filtered, kept fresh by a file watcher). The agent calls `retrieve_context(query)` and receives chunks ranked by score, **max 3 per file** to prevent one document crowding out others, packed greedily into a **token budget** (default 6000, estimate `ceil(chars/4)`); the result states the budget used and a `why: matched: …` reason per chunk, also shown in the panel. *Explicit:* `@path` inlines a file (truncated to fit) and `@sym:name` resolves a symbol definition, together using at most half the budget. On real Flask (230 files, ~150 ms to index) the agent's query for "flask CLI commands" surfaces `cli.py`, `docs/cli.rst` and `tests/test_cli.py` — which is how Task B reaches three files without any being named.

## 5. Model setup

Bring-your-own, configured only in TrueForge: any OpenAI-compatible endpoint is registered as a `custom` provider (`npm run provision`), referenced as `provider/modelId`. Demo configuration: primary **gemini-2.5-flash (Google / OpenAI-compatible)**, fallback **gemini-2.5-flash (Google / OpenAI-compatible)**; keys come from environment variables and are never committed. Approximate demo cost: [[₹/$ for the recorded runs]]. The deterministic e2e suite uses a scripted mock model; the video uses the real models above.

## 6. Scorecard

| Criterion | Video | One-line claim |
|---|---|---|
| A1 Inline edit | 00:15–01:05 | Selection + instruction → scoped per-hunk diff; `FLASK_DEBUG=off` prints `False`. |
| A2 Agent mode | 01:15–01:40 | Unnamed task reaches `cli.py`, `tests/test_cli.py`, `docs/cli.rst` via retrieval; pytest passes; `flask config` works. |
| A3 Streaming & cancel | 01:40–02:05 | Tokens stream; Esc cancels in ~15 ms, `git status` clean, no half-applied edits. |
| B1 Context | 01:25–01:41 | BM25 symbol chunks under a token budget, each with a stated reason; `@file`/`@sym` supported. |
| B2 Diff safety | 00:35–00:45, 01:55–02:15 | No silent writes: approval-gated, per-hunk accept/reject, exact undo. |
| B3 Resilience | 02:05–02:45 | Unreachable or 401 primary → clear notice → fallback model finishes; only-bad → one error, UI responsive. |
| B4 TrueForge depth | 01:41–01:55 | Sessions, streaming, approvals, MCP tools, deferred loading, compaction and cancel all on TrueForge; TrueForge session shown. |
| C1 Video | — | ≤4 min, A→B→C with on-screen verification. |
| C2 Write-up | — | This document. |

## 7. Tools used

TrueForge (local) + `@truefoundry/trueforge-sdk`; Model Context Protocol SDK; VS Code extension API; esbuild, vitest, tsx; `diff` library; mock OpenAI-compatible server for deterministic tests; Claude (Anthropic) used as an AI pair-programmer to write the code and docs, with tests written first and reviewed by the team: [[confirm/adjust]].

## 8. Known limitations

* The VS Code UI layer (diff review tabs, hunk checklist, panel, inline-edit prompt) was not exercised in a real VS Code during the automated build (no editor download in that environment); it is covered by typecheck, bundling and a fake-`vscode` activation test and was smoke-tested by hand: [[confirm after F5 test]].
* The automated e2e uses a scripted mock model; real-model quality (does the model pick the right files, write good edits) varies by model and is shown only in the video.
* Fallback is implemented in the extension (new session on the next model); context from the failed attempt is not carried over.
* TrueForge must be started with `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'` for its SSRF guard to allow the localhost MCP server.
* Retrieval is lexical (BM25), not embedding-based: it needs the agent to phrase queries with the code's own vocabulary. Regex chunkers cover Python/JS/TS only; other languages use line windows.
* `run_command` runs in the workspace; only simple allow-listed commands (pytest, flask; no shell metacharacters) skip the prompt. Single workspace folder; single concurrent run.
