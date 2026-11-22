# Forge Agent — a VS Code coding agent whose loop runs on TrueForge

Built for the TrueFoundry Forge-a-thon (Techfest IIT Bombay 2026-27).
**Fork point: none — written from scratch** (TypeScript, MIT). No upstream code is vendored, so there is no upstream LICENSE to carry over; see `LICENSE`.

The extension is a thin client. The agent loop (model calls, tool dispatch, approvals, compaction, sessions) runs in
[TrueForge](https://github.com/truefoundry/trueforge). The extension never calls a model provider: it opens a TrueForge
session through `@truefoundry/trueforge-sdk`, and exposes editor capabilities to the agent as **MCP tools** served from a
localhost MCP server inside the extension. The model is bring-your-own and is configured in TrueForge.

```
VS Code extension ──SDK/HTTP──▶ TrueForge (agent loop, model routing)
      ▲  localhost MCP (streamable HTTP)            │
      └────────── editor tools ◀────────────────────┘
          retrieve_context · read_file · propose_edit · apply_changes · run_command · …
```

## Setup from a clean clone

Requirements: Node ≥ 22.14, VS Code ≥ 1.90, git.

```bash
git clone <this repo> forge-agent && cd forge-agent
npm ci
npm run build            # bundles dist/extension.js
npm test                 # 74 unit tests, no network needed
```

### 1. Start TrueForge locally

```bash
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' npx @truefoundry/trueforge@latest
# serves http://localhost:8790  (API docs at /api/v1/docs)
```

`OUTBOUND_URL_ALLOWED_HOSTS` is required: TrueForge's SSRF guard blocks loopback URLs by default, and the editor MCP
server (and any local model endpoint) lives on 127.0.0.1. (`NETWORK_POLICY_ENABLED=false` also works.)

### 2. Configure your model(s) in TrueForge

Copy `forge-agent.config.example.json` to `forge-agent.config.json`, edit endpoints/model ids, export the keys, and run:

```bash
export PRIMARY_API_KEY=...   BACKUP_API_KEY=...     # never committed; read from the environment
npm run provision            # registers each endpoint in TrueForge as a "custom" OpenAI-compatible provider
```

Model references are `<provider>/<modelId>`. Any OpenAI-compatible endpoint (hosted or local, e.g. Ollama/vLLM) works.
The **first** entry in `models` is primary; the rest are automatic fallbacks (see Resilience).

### 3. The agent definition

`agent/forge-agent.agent.json` is the TrueForge session spec the extension submits (instructions, the `forge-editor` MCP
server with `apply_changes`/`run_command` approval-gated, deferred tool loading, context compaction, subagents on).
The extension creates a session from it automatically on every run and registers its MCP server in TrueForge
(`PUT /api/v1/settings/mcp-servers`), so nothing needs to be imported by hand. To inspect or reproduce it:
`npm run gen-agent` regenerates the file from `src/agent/spec.ts` (a unit test fails if they drift), and the
same JSON can be POSTed to `/api/v1/sessions` after replacing `<model>` with a model reference.

### 4. Run the extension

Open this folder in VS Code, press **F5** (Run Extension), then in the Extension Development Host open the project you
want to edit (e.g. a checkout of `pallets/flask`) and set, in Settings → Forge Agent (or `settings.json`):

```jsonc
{
  "forgeAgent.baseUrl": "http://localhost:8790",
  "forgeAgent.models": ["primary/gpt-4.1", "backup/llama-3.3-70b-versatile"]
}
```

Or install a packaged build: `npm run package` → `code --install-extension forge-agent-0.1.0.vsix`.

## Using it

| Capability | How |
|---|---|
| **Inline edit** | Select code → `Ctrl+Alt+K` (`Cmd+Alt+K`) or right-click → *Forge: Edit Selection* → type the instruction. Review the diff, then apply. |
| **Agent mode** | Activity-bar *Forge Agent* panel → describe the task. The agent finds the files itself (`retrieve_context`, `find_symbol`, `search_workspace`), edits several files, and verifies with tests. |
| **Context assembly** | `@path/to/file` and `@sym:name` in the panel expand within a token budget; the agent also retrieves automatically. The panel lists which chunks were chosen and why. |
| **Diff review** | Nothing is written until you accept. Each hunk has Accept/Reject CodeLenses in a diff editor; *Apply accepted* writes only accepted hunks in one batch. *Forge: Undo Last Applied Change* restores the exact previous contents. |
| **Streaming & cancel** | Tokens stream into the panel. `Esc`, the notification's Cancel, the status bar, or *Forge: Stop* cancels the TrueForge turn, closes any pending review and discards staged edits — the workspace is never half-written. |

### Resilience (Task C behaviour)

If the primary model errors (unreachable endpoint, 401/invalid key, other `[Model Error]`), the extension tells you why and
falls back to the next model in `forgeAgent.models` by opening a new TrueForge session (TrueForge does not document an
automatic cross-model fallback, so this lives in the extension). Transient errors are retried with backoff first; auth
errors fall back immediately. If every model fails you get one clear error and the editor stays responsive. Staged edits
are in memory only, so `git status` stays clean.

## Verification evidence

* `npm test` — 74 unit tests (hunk maths, overlay, undo, BM25 retrieval, MCP tools, runner, resilience, activation).
* `npm run e2e` — end-to-end against **real TrueForge** and **real Flask 3.1.3 @ 22d92470** (cloned to `/tmp/forge-e2e`,
  Python venv, pytest 9.0.2): Tasks A, B and C, cancel mid-stream, cancel during review, reject-all. 30/30 checks.
  The model in that harness is a *scripted mock* OpenAI-compatible server (so the run is deterministic and keyless);
  the agent loop, MCP tools, approvals, diff application, retrieval and fallbacks are real. For the real-model demo see the video.
* The VS Code UI layer (CodeLens review, panel, inline edit) is covered by typecheck, bundling and a fake-`vscode` activation
  test; it must be smoke-tested by pressing F5 (see `docs/SMOKE_TEST.md`).

## Layout

`src/core.ts` wiring · `src/agent/` session spec + runner · `src/forge/` SDK client, provisioning, resilience ·
`src/mcp/` editor MCP server and tools · `src/context/` chunker, BM25 index, @-mentions ·
`src/workspace/` hunks, overlay, undo · `src/ui/` VS Code review/panel/inline edit · `scripts/` provisioning, mock model, e2e.

## Notes for the Flask tasks

Flask's tests need `pytest==9.0.2` (per its `uv.lock`); newer pytest breaks collection (`notset` import).
No API keys are in this repository; keys are read from environment variables named in your local `forge-agent.config.json`
(git-ignored).
