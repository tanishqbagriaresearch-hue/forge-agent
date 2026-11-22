# Forge Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A VS Code extension whose agent loop runs on TrueForge (local mode), delivering inline edit, agent mode, automatic context retrieval, per-hunk diff review with undo, and streaming with safe cancellation, plus the Forge-a-thon Round 1 artefacts.

**Architecture:** The extension is a client of TrueForge's HTTP API (`@truefoundry/trueforge-sdk`). It hosts a localhost streamable-HTTP MCP server exposing editor tools (read, search, retrieve, stage edit, apply, run). TrueForge's per-tool approval (`require_approval_for_tools`) gates `apply_changes`/`run_command`, and the extension answers `tool.approval_required` by showing per-hunk review. All editing logic sits behind a `Host` interface so it is testable headless against a real local TrueForge and a scripted OpenAI-compatible mock.

**Tech Stack:** TypeScript, VS Code API, `@truefoundry/trueforge-sdk`, `@modelcontextprotocol/sdk`, `diff`, esbuild, vitest. Node >= 22.14.

**Spec:** `docs/superpowers/specs/2026-11-22-forge-agent-design.md`

## Global Constraints

- Agent loop runs on TrueForge local mode (`npx @truefoundry/trueforge@latest`, default `http://localhost:8790`); the extension never calls a model provider directly.
- Works with any model configured in TrueForge; models are named in `forgeAgent.models` (ordered; first is primary, rest are fallbacks).
- No write to disk before the user accepts a hunk; applied changes are undoable.
- MIT licence; no API keys committed; ship `forge-agent.config.example.json`.
- Pinned test repo: pallets/flask tag 3.1.3, commit 22d92470.
- Out of scope: tab completion, hosted backend, auth, Marketplace publishing.
- TrueForge facts confirmed by probing 0.x local server: `POST /api/v1/settings/model-providers` takes `{manifest:{type:"openai",base_url,auth:{api_key},models:[{model_id,name,properties:{}}]}}` (`name` matches `^[a-z][a-z0-9-]{0,62}[a-z0-9]$`); `POST /api/v1/settings/mcp-servers` takes `{manifest:{type:"remote",name,url,description}}`; session spec supports `mcp_servers[{name,enable_tools,require_approval_for_tools,preload_tools}]`, `config.dynamic_sub_agents`, `config.context_management.compaction`.

## Review Focus

- `propose_edit` whose `old_text` is missing or matches more than once: tool error, nothing staged.
- Any tool given a path outside the workspace (`../x`, absolute): rejected.
- File changed on disk between staging and apply: that file is skipped and reported (never clobbered).
- Cancel while a review is pending: overlay cleared, review closed, nothing written.
- CRLF files and files without trailing newline: hunks and applied text preserve them.

---

### Task 1: Scaffold, mock model, provisioning

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.mjs`, `vitest.config.ts`, `.gitignore`, `.vscodeignore`, `LICENSE`
- Create: `src/forge/provision.ts`, `scripts/mock-openai.ts`, `scripts/provision.ts`
- Test: `test/provision.test.ts`

**Interfaces:**
- Produces: `provision.ts` exports
  - `type ModelSpec = { name: string; modelId: string; baseUrl: string; apiKey: string }`
  - `upsertModelProvider(baseUrl: string, m: ModelSpec, f?: typeof fetch): Promise<void>` (PUT `/api/v1/settings/model-providers`)
  - `upsertMcpServer(baseUrl: string, name: string, url: string, f?: typeof fetch): Promise<void>` (PUT `/api/v1/settings/mcp-servers`)
- Produces: `scripts/mock-openai.ts` exports `startMockOpenAI(script: MockScript, port?: number): Promise<{url: string; close(): Promise<void>; requests: unknown[]}>` where `MockScript = (messages: ChatMessage[], tools: string[]) => MockReply` and `MockReply = { text?: string } | { toolCalls: {name: string; args: object}[] } | { status: number }`; serves streaming `POST /v1/chat/completions`.

- [ ] **Step 1: Write failing test** `provision.test.ts`: `upsertModelProvider` sends PUT with `manifest.type==="openai"`, the given `base_url`, `auth.api_key`, and one model `{model_id,name,properties:{}}`; `upsertMcpServer` sends `manifest.type==="remote"` with `name`,`url`,`description`; non-2xx throws an Error containing the status.
- [ ] **Step 2: Run** `npx vitest run test/provision.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** both functions with injected `fetch`; scaffold project files (scripts: `build`, `test`, `typecheck`, `package` via `@vscode/vsce`); implement `startMockOpenAI` as an SSE chat-completions server emitting `tool_calls` deltas in OpenAI format.
- [ ] **Step 4: Run** the test — expect PASS; `npm run typecheck` clean.
- [ ] **Step 5: Commit** `feat: scaffold, provisioning client, mock OpenAI server`

### Task 2: Workspace core (hunks, overlay, snapshots)

**Files:**
- Create: `src/workspace/hunks.ts`, `src/workspace/overlay.ts`, `src/workspace/snapshot.ts`, `src/workspace/paths.ts`, `src/host.ts`
- Test: `test/hunks.test.ts`, `test/overlay.test.ts`, `test/snapshot.test.ts`

**Interfaces:**
- Produces `paths.ts`: `resolveInWorkspace(root: string, p: string): string` — throws `Error("outside workspace")` for escapes/absolute paths outside root; returns absolute path.
- Produces `hunks.ts`: `type Hunk = { id: number; oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }`; `computeHunks(oldText: string, newText: string): Hunk[]`; `applyHunks(oldText: string, hunks: Hunk[], acceptedIds: Set<number>): string`. Preserves CRLF and missing trailing newline.
- Produces `overlay.ts`: `class Overlay { constructor(read: (abs:string)=>Promise<string|null>); stageEdit(abs: string, oldText: string | undefined, newText: string): Promise<void>; staged(): Map<string,{original: string|null; proposed: string}>; clear(): void; baseline(abs): string|null }`. `oldText` undefined/"" = create (error if file exists). Throws `Error("old_text not found")` / `Error("old_text matches N places")`.
- Produces `snapshot.ts`: `class UndoStack { push(entry: {label: string; files: {abs: string; before: string|null; after: string}[]}): void; pop(): entry | undefined; size(): number }`.
- Produces `host.ts`: `interface Host { root: string; readFile(abs): Promise<string|null>; applyFiles(files: {abs: string; content: string | null}[]): Promise<void>; reviewChanges(items: ReviewItem[], signal: AbortSignal): Promise<Map<string, Set<number>>>; confirmCommand(cmd: string, signal: AbortSignal): Promise<boolean>; notify(kind: "info"|"error", msg: string): void }` with `ReviewItem = { abs: string; original: string | null; proposed: string; hunks: Hunk[] }`. `content: null` deletes.

- [ ] **Step 1: Write failing tests**: `computeHunks("a\nb\nc\n","a\nB\nc\n")` yields one hunk; two distant changes yield two hunks; `applyHunks` with only hunk 2 accepted leaves hunk 1 original; CRLF input stays CRLF; no trailing newline preserved; `stageEdit` twice on one file composes; non-unique/missing `old_text` throws the exact messages above and stages nothing; create-on-existing throws; `resolveInWorkspace(root,"../x")` and `"/etc/passwd"` throw; `UndoStack` LIFO.
- [ ] **Step 2: Run** `npx vitest run test/hunks.test.ts test/overlay.test.ts test/snapshot.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** using `structuredPatch` from `diff` for hunk boundaries (context 3) and an own subset-applier working from `Hunk.lines` prefixes (`" "`,`"+"`,`"-"`).
- [ ] **Step 4: Run** same command — expect PASS.
- [ ] **Step 5: Commit** `feat: workspace overlay, hunks, undo stack`

### Task 3: Context assembly (chunker, BM25, budget, mentions)

**Files:**
- Create: `src/context/chunker.ts`, `src/context/bm25.ts`, `src/context/index.ts`, `src/context/mentions.ts`, `src/workspace/walk.ts`
- Test: `test/context.test.ts`, `test/mentions.test.ts`

**Interfaces:**
- Produces `walk.ts`: `listFiles(root: string, opts?: {maxBytes?: number}): Promise<string[]>` relative paths; skips `.git`, `node_modules`, `venv`, `.venv`, `__pycache__`, `dist`, binary (NUL byte) and files over `maxBytes` (default 400_000).
- Produces `chunker.ts`: `type Chunk = { path: string; startLine: number; endLine: number; symbol?: string; kind: "function"|"class"|"window"; text: string }`; `chunkFile(path: string, text: string): Chunk[]` — Python/JS/TS symbol-level by indentation/regex, 40-line windows fallback, hard cap 120 lines per chunk.
- Produces `bm25.ts`: `class Bm25 { constructor(docs: string[]); score(query: string): number[] }`; tokenizer splits snake_case, camelCase, punctuation, lowercases.
- Produces `index.ts`: `class ContextIndex { static build(root: string): Promise<ContextIndex>; update(path: string, text: string | null): void; retrieve(query: string, budgetTokens: number): RetrievedChunk[]; findSymbol(name: string): Chunk[] }`, `RetrievedChunk = Chunk & { score: number; why: string }` (`why` lists matched query terms, e.g. `matched: debug, flag`); token estimate = `ceil(text.length/4)`; stops before exceeding budget; never returns two chunks for the same lines.
- Produces `mentions.ts`: `parseMentions(input: string): {files: string[]; symbols: string[]; text: string}` for `@path/with.ext` and `@sym:name`; `expandMentions(m, index, root, budgetTokens): Promise<string>` — appends file/symbol context blocks within budget.

- [ ] **Step 1: Write failing tests** with a small fixture repo: querying "debug flag environment variable" ranks the chunk of `get_debug_flag` first; the sum of estimated tokens of results ≤ budget; budget 0 returns `[]`; `why` names matched terms; `findSymbol("get_debug_flag")` returns one chunk with correct line range; binary and oversized files are skipped; `parseMentions("fix @src/a.py and @sym:foo now")` gives `files:["src/a.py"]`, `symbols:["foo"]`.
- [ ] **Step 2: Run** `npx vitest run test/context.test.ts test/mentions.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** with standard BM25 (k1=1.5, b=0.75); an in-memory index rebuilt incrementally by `update`.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat: BM25 symbol-level context retrieval with token budget`

### Task 4: Editor MCP server and tools

**Files:**
- Create: `src/mcp/tools.ts`, `src/mcp/server.ts`
- Test: `test/mcp.test.ts`

**Interfaces:**
- Consumes: `Host`, `Overlay`, `UndoStack`, `ContextIndex`, `computeHunks`, `applyHunks`, `resolveInWorkspace`, `listFiles`.
- Produces `tools.ts`: `class EditorTools { constructor(deps: {host: Host; overlay: Overlay; undo: UndoStack; index: ContextIndex; review: ReviewState; onActivity: (a: Activity)=>void; tokenBudget: number}) }` with methods named exactly as tools: `read_file({path, start_line?, end_line?})`, `list_dir({path})`, `search_workspace({pattern, glob?, max_results?})`, `find_symbol({name})`, `retrieve_context({query, budget_tokens?})`, `propose_edit({path, old_text?, new_text})`, `apply_changes({summary})`, `run_command({command, timeout_seconds?})`. Each returns MCP `{content:[{type:"text",text}], isError?}`.
- `type Activity = {tool: string; summary: string; files?: {path: string; why?: string}[]}` — emitted per call so the panel shows which files the agent chose and why.
- `ReviewState = { decisions: Map<string, Set<number>> | null; signal: AbortSignal }` — set by the runner after the user finishes review; `apply_changes` reads it.
- `apply_changes` behaviour: for each staged file, skip with a "conflict" line if the current disk text differs from the staged original; apply accepted hunks only; call `host.applyFiles` once (single atomic batch); push `UndoStack`; clear overlay; return a text report of applied/skipped/rejected hunks. With no decisions or none accepted: return "no hunks accepted", write nothing.
- Produces `server.ts`: `startEditorMcp(tools: EditorTools, port?: number): Promise<{url: string; close(): Promise<void>}>` — streamable HTTP at `/mcp` on 127.0.0.1; tool annotations: read tools `readOnlyHint: true`; `propose_edit` has a zod schema and `readOnlyHint: false`.

- [ ] **Step 1: Write failing tests** (in-process: start server on port 0, connect an MCP SDK `Client`): lists all 8 tools; `propose_edit` stages and `read_file` of the same path still returns the disk text; `apply_changes` with decisions accepting hunk 1 of 2 writes only hunk 1 and pushes undo; a file modified externally after staging is reported as conflict and untouched; `../etc/passwd` → `isError`; `retrieve_context` result contains `why` and respects budget; `run_command` runs `echo hi` in root and returns output, honours abort and truncates output over 20 KB.
- [ ] **Step 2: Run** `npx vitest run test/mcp.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** tools with a fake in-memory `Host` in tests; `run_command` uses `child_process.spawn` with `shell: true`, `cwd: root`, kill on abort/timeout.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat: editor MCP server with context, staging and apply tools`

### Task 5: TrueForge client, runner, resilience

**Files:**
- Create: `src/forge/client.ts`, `src/agent/runner.ts`, `src/agent/spec.ts`, `src/forge/resilience.ts`, `agent/forge-agent.agent.json`
- Test: `test/resilience.test.ts`, `test/runner.test.ts`

**Interfaces:**
- Consumes: `Host`, `EditorTools`/`ReviewState`, `upsertMcpServer`.
- Produces `spec.ts`: `buildAgentSpec(model: string, mcpName: string): object` — `{model:{name}, instructions, mcp_servers:[{name: mcpName, enable_tools:["@all"], require_approval_for_tools:["apply_changes","run_command"], preload_tools:["retrieve_context","read_file","propose_edit","apply_changes"]}], config:{dynamic_sub_agents:{enabled:true}, context_management:{compaction:{enabled:true}}, generative_ui:{enabled:false}, ask_user_questions:{enabled:false}, iteration_limit:40}}`. Instructions tell the agent to: call `retrieve_context` first, read before editing, make all edits with `propose_edit`, then call `apply_changes` once, then verify with `run_command`; to never ask the user to name files. `agent/forge-agent.agent.json` is the same spec as checked-in file (generated by `scripts/gen-agent.ts` via `buildAgentSpec`).
- Produces `resilience.ts`: `isRetryable(e: unknown): boolean` (network errors, 5xx, 429, `turn.done` error with connection/timeout text); `isAuthError(e): boolean` (401/403 or "invalid api key"); `withFallback<T>(models: string[], attempt: (model: string) => Promise<T>, o: {retries: number; baseMs: number; onEvent: (e: {kind: "retry"|"fallback"|"failed"; model: string; message: string}) => void; sleep?: (ms:number)=>Promise<void>}): Promise<T>` — retries retryable errors with exponential backoff on the same model, falls back to the next model after retries exhausted or on auth error, throws the last error after all models fail.
- Produces `runner.ts`: `type RunEvents = {delta(text: string): void; toolCall(name: string, args: unknown): void; toolResult(name: string, text: string): void; status(s: "running"|"paused"|"done"|"cancelled"|"error", detail?: string): void; notice(msg: string): void}`; `class AgentRunner { constructor(o: {baseUrl: string; models: string[]; mcpName: string; host: Host; review: ReviewState; overlay: Overlay; events: RunEvents; client?: TrueForgeLike}); run(prompt: string): Promise<{status: string; model: string}>; cancel(): Promise<void>; switchPrimary(model: string): void }`.
  - `run`: `sessions.create({agent:{spec}})` → `createTurnStream` → iterate events (`model.message.delta` → `events.delta`; `model.message` tool_calls → `events.toolCall`; `tool.response` → `events.toolResult`; `tool.approval_required` → resolve the pending tool call's name from `source_event_id`, then for `apply_changes`: build `ReviewItem[]` from the overlay, `host.reviewChanges`, store decisions in `ReviewState`, send `user.tool_approval` allow (or deny with reason if nothing accepted); for `run_command`: `host.confirmCommand`; then `subscribeToTurn(..., {afterEventId})` and continue); `turn.done` with `error` throws a classified Error so `withFallback` handles it.
  - `cancel`: abort the review signal, call `client.sessions.cancel(sessionId)`, `overlay.clear()`; the loop ends with `status("cancelled")`; never throws.
  - Nothing is written to disk before approval; on fallback the overlay is cleared and a new session started on the next model.
- `TrueForgeLike`: minimal interface over the SDK (`sessions.create`, `createTurnStream`, `subscribeToTurn`, `createTurnEvents`, `cancel`) so tests inject a fake.

- [ ] **Step 1: Write failing tests**: `withFallback` (retries twice with backoff delays `[base, 2*base]` then falls back; auth error falls back immediately without retry; all fail → rejects with last error; emits `retry`/`fallback` events); `runner` with a fake client scripted to emit delta → `model.message` with `apply_changes` call → `tool.approval_required` → (after approval) `tool.response` → `turn.done`: asserts `user.tool_approval` allow sent, `host.reviewChanges` called with the staged item, delta text surfaced; a primary-model failure (`turn.done` error "ECONNREFUSED") triggers fallback to the second model with no `host.applyFiles` call; `cancel()` mid-stream results in `status("cancelled")`, `sessions.cancel` called once, overlay empty, pending review signal aborted.
- [ ] **Step 2: Run** `npx vitest run test/resilience.test.ts test/runner.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `client.ts` as a thin factory `makeClient(baseUrl): TrueForgeLike` around `new TrueForge({baseUrl, timeoutInSeconds: 600})`; use the event shapes documented at trueforge.dev/api/use-agent.md (`turn.created`, `model.message.delta`, `model.message`, `tool.approval_required`, `tool.response`, `turn.done`). Confirm model-name format against `GET /api/v1/models` in Task 7 and adjust `buildAgentSpec` input if needed.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat: TrueForge runner with approval-driven review, cancel and model fallback`

### Task 6: VS Code UI layer

**Files:**
- Create: `src/extension.ts`, `src/config.ts`, `src/ui/vscodeHost.ts`, `src/ui/review.ts`, `src/ui/panel.ts`, `src/ui/inlineEdit.ts`, `media/panel.js`, `media/panel.css`
- Modify: `package.json` (contributes: commands, keybindings, view container, configuration)
- Test: `test/activate.test.ts` (with a minimal fake `vscode` module via `vitest` alias)

**Interfaces:**
- Consumes: everything above.
- Produces `config.ts`: `readConfig(): {baseUrl: string; models: {name: string; modelId: string; baseUrl: string; apiKeyEnv: string}[]; tokenBudget: number; mcpPort: number; autoApproveCommands: string[]}` from `forgeAgent.*` settings, defaults `baseUrl http://localhost:8790`, `tokenBudget 6000`, `mcpPort 0`, `autoApproveCommands ["^pytest","^python -m pytest","^flask "]`.
- Commands: `forgeAgent.inlineEdit` (Ctrl/Cmd+K Ctrl/Cmd+I, `when: editorHasSelection`), `forgeAgent.openPanel`, `forgeAgent.stop` (Escape while running, `when: forgeAgent.running`), `forgeAgent.undo`, `forgeAgent.switchModel`, `forgeAgent.hunk.toggle` (internal).
- `review.ts`: `VscodeReview.review(items, signal)` opens the native diff editor per file (`vscode.diff`, left = `forge-original:` doc, right = `forge-proposed:` doc), registers a CodeLens provider on `forge-proposed` showing `✔ Accept hunk n | ✖ Reject hunk n` at each hunk's `newStart` plus a top lens `Apply accepted | Reject all`; resolves with `Map<abs, Set<acceptedHunkIds>>` when the user hits Apply or Reject all; resolves with empty map and closes diff tabs when `signal` aborts. Default state of each hunk = accepted.
- `panel.ts`: webview showing streamed transcript, tool-call cards, a "Context chosen" list from `Activity.files` (path + why), model dropdown, Stop button, input supporting `@file` / `@sym:` mentions (expanded via `expandMentions`), an Undo button after apply; messages posted via `webview.postMessage`; never blocks the extension host (all awaits async).
- `inlineEdit.ts`: builds the prompt `File: <rel>\nLines <a>-<b>:\n<selected>\nInstruction: <text>\nOnly edit inside this region unless the instruction requires otherwise.`, then `runner.run(prompt)`; status bar shows `$(sync~spin) Forge: working — click to stop`.
- `extension.ts`: on activate — build `ContextIndex` in background (`vscode.workspace.createFileSystemWatcher` → `index.update`), start editor MCP, `upsertMcpServer` and `upsertModelProvider` per configured model (key read from `process.env[apiKeyEnv]`; skip with a notice if absent), register commands; on deactivate close MCP and cancel any run.

- [ ] **Step 1: Write failing test** `activate.test.ts`: with fake `vscode`, `activate(ctx)` registers the six commands above without throwing and `deactivate()` resolves.
- [ ] **Step 2: Run** `npx vitest run test/activate.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the UI modules; contribute keybindings/config in `package.json`; `esbuild.mjs` bundles `src/extension.ts` → `dist/extension.js` (cjs, external `vscode`).
- [ ] **Step 4: Run** `npx vitest run test/activate.test.ts && npm run build && npm run typecheck` — expect PASS and `dist/extension.js` present.
- [ ] **Step 5: Commit** `feat: VS Code extension UI (inline edit, panel, per-hunk review, undo)`

### Task 7: End-to-end against real TrueForge and Flask 3.1.3

**Files:**
- Create: `scripts/e2e-flask.ts`, `test/e2e-notes.md`
- Modify: any module whose behaviour the real TrueForge contradicts (fix with a test first)

**Interfaces:**
- Consumes: `startMockOpenAI`, `provision`, `AgentRunner`, `EditorTools`, `startEditorMcp`, a headless `Host` (auto-accepts all hunks; auto-confirms commands).
- Produces: `npm run e2e` prints PASS/FAIL per scenario.

- [ ] **Step 1: Write the harness** — clone `pallets/flask` at tag 3.1.3 into a temp dir, `pip install -e . pytest` into a venv, start `npx @truefoundry/trueforge@latest` on a free port with a temp `SQLITE_PATH`, start the mock model, provision `mockgood` (mock URL) and `mockbad` (`http://127.0.0.1:1/v1`) providers, then run scenarios:
  - **A**: select `get_debug_flag` in `src/flask/helpers.py`, run Task A's exact instruction; assert `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` prints `False`, and docstring lists `off`/`n`.
  - **B**: run Task B's exact instruction with no files named; assert ≥3 files changed (`src/flask/cli.py`, `tests/test_cli.py`, a docs file), `pytest tests/test_cli.py -q` passes, `flask --help` lists `config`, masked JSON shows `"***"` for `SECRET_KEY`.
  - **C**: models `[mockbad, mockgood]` → Task A succeeds via automatic fallback; and models `[mockbad]` only → clear failure and `git status --porcelain` empty.
  - **Cancel**: script the mock to stall; call `cancel()` after the first delta; assert terminal status `cancelled`, `git status --porcelain` empty.
  - **Undo**: after scenario A, `UndoStack.pop` restores the original file byte-for-byte.
- [ ] **Step 2: Run** `npm run e2e` — expect FAIL on first run; fix real-TrueForge mismatches (model-name format, tool-approval event ordering, MCP localhost reachability) test-first in the owning module.
- [ ] **Step 3: Iterate** until all scenarios PASS; record real findings in `test/e2e-notes.md`.
- [ ] **Step 4: Commit** `test: end-to-end Flask tasks A, B, C, cancel and undo against local TrueForge`

### Task 8: Submission artefacts

**Files:**
- Create: `README.md`, `forge-agent.config.example.json`, `docs/WRITEUP.md`, `docs/VIDEO_SCRIPT.md`, `docs/SCORECARD.md`, `scripts/build-writeup-pdf.py`
- Modify: `package.json` (`repository`, `license`)

- [ ] **Step 1: Write README** with: what it is, requirements, setup from a clean clone (`npm ci`, `npm run build`, F5 or `vsce package` + install, start `npx @truefoundry/trueforge@latest`, `npm run provision`, load `agent/forge-agent.agent.json`), the declared starting point ("from scratch, no upstream fork"), example config, how to switch models, licence and attribution of dependencies, no-secrets note.
- [ ] **Step 2: Write `docs/WRITEUP.md`** with the eight mandated headings in order (Team, Starting point, Architecture on TrueForge, How context is selected, Model setup, Scorecard, Tools used, Known limitations); placeholders `[[...]]` only for team, models, costs and video timestamps; limitations section must state honestly what was and was not verified (UI layer not exercised in a real VS Code in the build environment; e2e used a scripted mock model).
- [ ] **Step 3: Write `docs/VIDEO_SCRIPT.md`** (≤4 min shot list: A, verify, B, show TrueForge session, verify, C, verify) and `docs/SCORECARD.md` mapping each criterion to the claim and a timestamp placeholder.
- [ ] **Step 4: Build the PDF** `python scripts/build-writeup-pdf.py` → `docs/WRITEUP.pdf` (1-3 pages, verify page count and render pages to images to check layout).
- [ ] **Step 5: Verify no secrets** `git grep -nE "sk-[A-Za-z0-9]{10,}|api_key\s*[:=]\s*['\"][A-Za-z0-9]"` returns nothing relevant; commit `docs: README, write-up, video script, scorecard`.

## Self-Review

- Spec coverage: inline edit (T6), agent mode (T5/T7-B), context assembly with budget and mentions (T3/T4), per-hunk diff + undo (T2/T4/T6), streaming + cancellation (T5/T6/T7), resilience + fallback (T5/T7-C), MCP tools + approval + context-engineering feature (T4/T5 spec), BYO model + example config (T1/T8), artefacts (T8). Fork-point declaration is "from scratch" (T8).
- Type consistency: `Host`, `ReviewItem`, `Hunk`, `ReviewState`, `Activity`, `RunEvents` are each defined once (T2/T4/T5) and consumed by later tasks with the same names.
- Proportion: bodies deliberately omitted; tests and signatures carry the decisions.
