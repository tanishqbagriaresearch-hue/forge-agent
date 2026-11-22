# Scorecard (mirror of write-up §6, with where the evidence lives in the repo)

| Criterion (pts) | Claim | Code | Automated evidence | Video |
|---|---|---|---|---|
| A1 Inline edit (10) | Selection + instruction → scoped hunks → verified result | `src/ui/inlineEdit.ts`, `src/agent/runner.ts` | `npm run e2e` [A] (3 checks) | [[ts]] |
| A2 Agent mode (10) | ≥3 files, none named, tests + docs | `src/mcp/tools.ts`, `src/context/` | e2e [B] (10 checks, pytest 56 passed) | [[ts]] |
| A3 Stream/cancel (10) | Cancel ≈ 8–16 ms, no partial writes | `AgentRunner.cancel`, `Overlay` | e2e [cancel] ×4, `test/runner.test.ts` | [[ts]] |
| B1 Context (15) | BM25 symbol chunks, budget, reasons, @-mentions | `src/context/*` | `test/context.test.ts`, `test/mentions.test.ts`, e2e retrieve check | [[ts]] |
| B2 Diff safety (10) | Approval-gated, per-hunk, undo | `src/workspace/*`, `src/ui/review.ts` | `test/hunks`, `overlay`, `snapshot`, e2e undo + reject-all | [[ts]] |
| B3 Resilience (10) | Retry/fallback, clear error, clean git | `src/forge/resilience.ts` | `test/resilience.test.ts`, e2e [C] ×6 | [[ts]] |
| B4 TrueForge depth (10) | Sessions, SSE streaming, approvals, MCP, deferred tools, compaction, cancel | `src/forge/*`, `src/agent/spec.ts` | e2e runs on real TrueForge | [[ts]] |
