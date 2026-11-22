import { describe, it, expect } from "vitest";
import { AgentRunner, type RunEvents } from "../src/agent/runner";
import type { ForgeEvent, TrueForgeLike } from "../src/forge/client";
import { buildAgentSpec } from "../src/agent/spec";
import { HeadlessHost } from "../src/headlessHost";
import { Overlay } from "../src/workspace/overlay";
import type { ReviewState } from "../src/mcp/tools";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Step = ForgeEvent | (() => Promise<void>);
type Script = Step[][]; // round 0 = startTurn, round n = nth subscribe
function fakeClient(scripts: Record<string, Script | ((cancelled: Promise<void>) => AsyncIterable<ForgeEvent>)>) {
  const calls = { created: [] as string[], sent: [] as any[], cancelled: 0, subscribed: [] as (string | undefined)[] };
  let release!: () => void;
  const cancelled = new Promise<void>((r) => (release = r));
  const rounds = new Map<string, number>();
  const client: TrueForgeLike = {
    async createSession(spec: any) { calls.created.push(spec.model.name); return { id: "s-" + spec.model.name }; },
    async startTurn(id) {
      const s = scripts[id.slice(2)];
      if (typeof s === "function") return s(cancelled);
      rounds.set(id, 0);
      return gen(s[0]);
    },
    async subscribe(id, _turn, after) {
      calls.subscribed.push(after);
      const s = scripts[id.slice(2)] as Script;
      const n = (rounds.get(id) ?? 0) + 1; rounds.set(id, n);
      return gen(s[n] ?? []);
    },
    async sendEvents(_id, _turn, events) { calls.sent.push(...events); },
    async cancel() { calls.cancelled++; release(); },
  };
  return { client, calls };
}
async function* gen(evs: Step[]) { for (const e of evs) { if (typeof e === "function") { await e(); continue; } yield e; } }

const msg = (id: string, name: string, args: object): ForgeEvent => ({ type: "model.message", id, threadId: "main", toolCalls: [{ id: "tc-" + id, type: "function", function: { name, arguments: JSON.stringify(args) }, toolInfo: {} }] });
const created = (id = "e1"): ForgeEvent => ({ type: "turn.created", id, turnId: "t1", threadId: null });
const done = (id: string, state: any = { status: "done" }): ForgeEvent => ({ type: "turn.done", id, state, threadId: null });

let T: any;
const stageXY = () => T.overlay.stageEdit(path.join(T.root, "a.py"), "x = 1", "x = 10");

function setup(models: string[], clientScripts: Parameters<typeof fakeClient>[0], opts: { reviewImpl?: (items: any, signal: AbortSignal) => Promise<Map<string, Set<number>>> } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-"));
  fs.writeFileSync(path.join(root, "a.py"), "x = 1\ny = 2\n");
  const host = new HeadlessHost(root);
  if (opts.reviewImpl) host.reviewChanges = async (items, signal) => { host.reviews.push(items); return opts.reviewImpl!(items, signal); };
  const overlay = new Overlay((p) => host.readFile(p));
  const review: ReviewState = { decisions: null, signal: new AbortController().signal };
  const log = { delta: "", toolCalls: [] as string[], toolResults: [] as string[], statuses: [] as string[], notices: [] as string[] };
  const events: RunEvents = {
    delta: (t) => (log.delta += t), toolCall: (n) => log.toolCalls.push(n), toolResult: (n, t) => log.toolResults.push(`${n}:${t}`),
    status: (s) => log.statuses.push(s), notice: (m) => log.notices.push(m),
  };
  const { client, calls } = fakeClient(clientScripts);
  const runner = new AgentRunner({ baseUrl: "http://x", models, mcpName: "forge-editor", host, review, overlay, events, client, retries: 0, baseMs: 1, sleep: async () => {} });
  return (T = { runner, host, overlay, review, log, calls, root });
}

describe("buildAgentSpec", () => {
  it("gates apply_changes and run_command with approval and enables subagents + compaction", () => {
    const s: any = buildAgentSpec("m1", "forge-editor");
    expect(s.model.name).toBe("m1");
    expect(s.mcpServers[0].name).toBe("forge-editor");
    expect(s.mcpServers[0].requireApprovalForTools).toEqual(["apply_changes", "run_command"]);
    expect(s.config.dynamicSubAgents.enabled).toBe(true);
    expect(s.config.contextManagement.compaction.enabled).toBe(true);
    expect(s.instructions).toMatch(/retrieve_context/);
    expect(s.instructions).toMatch(/apply_changes/);
  });
  it("matches the checked-in agent definition", () => {
    const file = JSON.parse(fs.readFileSync(path.join(__dirname, "../agent/forge-agent.agent.json"), "utf8"));
    expect(file).toEqual(JSON.parse(JSON.stringify(buildAgentSpec("<model>", "forge-editor"))));
  });
});

describe("AgentRunner", () => {
  it("streams text, drives per-hunk review on apply_changes approval, and sends allow", async () => {
    const t = setup(["good"], {
      good: [
        [created(), { type: "model.message.delta", id: "e2", threadId: "main", content: "Hello " }, { type: "model.message.delta", id: "e3", threadId: "main", content: "world" },
          stageXY, msg("e4", "apply_changes", { summary: "s" }),
          { type: "tool.approval_required", id: "e5", threadId: "main", toolCalls: [{ id: "tc-e4", sourceEventId: "e4" }] },
          { type: "turn.update", id: "e6", state: { status: "paused" }, threadId: null }],
        [{ type: "tool.response", id: "e7", threadId: "main", toolCallId: "tc-e4", content: "APPLIED a.py" }, done("e8")],
      ],
    });
    const r = await t.runner.run("do it");
    expect(r).toEqual({ status: "done", model: "good" });
    expect(t.log.delta).toBe("Hello world");
    expect(t.log.toolCalls).toEqual(["apply_changes"]);
    expect(t.host.reviews).toHaveLength(1);
    expect(t.host.reviews[0][0].hunks).toHaveLength(1);
    expect(t.calls.sent).toEqual([{ type: "user.tool_approval", threadId: "main", toolCallId: "tc-e4", approval: { status: "allow" } }]);
    expect(t.calls.subscribed).toEqual(["e6"]);
    expect(t.review.decisions).not.toBeNull();
    expect(t.log.toolResults[0]).toContain("apply_changes:APPLIED");
  });

  it("reads tool calls streamed as deltas (real TrueForge shape) and drives review", async () => {
    const delta = (id: string, extra: object): ForgeEvent => ({ type: "model.message.delta", id, threadId: "main", ...extra });
    const t = setup(["good"], {
      good: [
        [created(), { type: "model.message", id: "m1", threadId: "main" }, stageXY,
          delta("m1", { toolCalls: [{ index: 0, id: "tc1", type: "function", function: { name: "apply_changes", arguments: "" } }] }),
          delta("m1", { toolCalls: [{ index: 0, function: { arguments: '{"summary":' } }] }),
          delta("m1", { toolCalls: [{ index: 0, function: { arguments: '"edit x"}' } }] }),
          delta("m1", { finishReason: "tool_calls" }),
          { type: "tool.approval_required", id: "e5", threadId: "main", toolCalls: [{ id: "tc1", sourceEventId: "m1" }] },
          { type: "turn.update", id: "e6", state: { status: "paused" }, threadId: null }],
        [done("e8")],
      ],
    });
    await t.runner.run("go");
    expect(t.log.toolCalls).toEqual(["apply_changes"]);
    expect(t.host.reviews).toHaveLength(1);
    expect(t.calls.sent).toEqual([{ type: "user.tool_approval", threadId: "main", toolCallId: "tc1", approval: { status: "allow" } }]);
  });

  it("unwraps deferred tools called through call_tool and gates run_command on the inner command", async () => {
    const t = setup(["good"], {
      good: [
        [created(), msg("e2", "call_tool", { mcp_server: "forge-editor", tool_name: "run_command", input: { command: "rm -rf /" } }),
          { type: "tool.approval_required", id: "e3", threadId: "main", toolCalls: [{ id: "tc-e2", sourceEventId: "e2" }] }],
        [done("e4")],
      ],
    });
    (t.host as any).confirmCommand = async (c: string) => { t.host.commands.push(c); return false; };
    await t.runner.run("x");
    expect(t.log.toolCalls).toEqual(["run_command"]);
    expect(t.host.commands).toEqual(["rm -rf /"]);
    expect(t.calls.sent[0].approval.status).toBe("deny");
  });

  it("denies the tool call when the user accepts no hunks", async () => {
    const t = setup(["good"], {
      good: [
        [created(), stageXY, msg("e2", "apply_changes", { summary: "s" }),
          { type: "tool.approval_required", id: "e3", threadId: "main", toolCalls: [{ id: "tc-e2", sourceEventId: "e2" }] }],
        [done("e4")],
      ],
    }, { reviewImpl: async () => new Map() });
    await t.runner.run("do it");
    expect(t.calls.sent[0].approval.status).toBe("deny");
  });

  it("asks the host before run_command and honours a refusal", async () => {
    const t = setup(["good"], {
      good: [
        [created(), msg("e2", "run_command", { command: "rm -rf /" }),
          { type: "tool.approval_required", id: "e3", threadId: "main", toolCalls: [{ id: "tc-e2", sourceEventId: "e2" }] }],
        [done("e4")],
      ],
    });
    (t.host as any).confirmCommand = async (c: string) => { t.host.commands.push(c); return false; };
    await t.runner.run("x");
    expect(t.host.commands).toEqual(["rm -rf /"]);
    expect(t.calls.sent[0].approval.status).toBe("deny");
  });

  it("falls back to the second model when the first fails to connect, writing nothing", async () => {
    const t = setup(["bad", "good"], {
      bad: [[created(), done("e2", { status: "error", message: "Connection error: ECONNREFUSED" })]],
      good: [[created(), { type: "model.message.delta", id: "e2", threadId: "main", content: "ok" }, done("e3")]],
    });
    const r = await t.runner.run("hi");
    expect(r.model).toBe("good");
    expect(t.calls.created).toEqual(["bad", "good"]);
    expect(t.log.notices.join(" ")).toMatch(/bad.*good|falling back/i);
    expect(fs.readFileSync(path.join(t.root, "a.py"), "utf8")).toBe("x = 1\ny = 2\n");
  });

  it("surfaces a clear error when every model fails", async () => {
    const t = setup(["bad"], { bad: [[created(), done("e2", { status: "error", message: "401 Incorrect API key" })]] });
    const r = await t.runner.run("hi");
    expect(r.status).toBe("error");
    expect(t.log.statuses.at(-1)).toBe("error");
    expect(t.log.notices.join(" ")).toMatch(/API key|failed/i);
  });

  it("cancel() mid-stream ends cancelled, calls sessions.cancel and empties the overlay", async () => {
    const t = setup(["slow"], {
      slow: (cancelled) => (async function* () {
        yield created();
        yield { type: "model.message.delta", id: "e2", threadId: "main", content: "thinking" } as ForgeEvent;
        await cancelled;
        yield done("e3", { status: "cancelled", reason: "client-cancelled" });
      })(),
    });
    const p = t.runner.run("go");
    await new Promise((r) => setTimeout(r, 30));
    await t.runner.cancel();
    await t.runner.cancel(); // idempotent for the UI
    const r = await p;
    expect(r.status).toBe("cancelled");
    expect(t.calls.cancelled).toBeGreaterThanOrEqual(1);
    expect(t.overlay.staged().size).toBe(0);
    expect(t.log.statuses.at(-1)).toBe("cancelled");
  });

  it("cancel() while a review is pending aborts the review and sends no approval", async () => {
    let seenSignal: AbortSignal | undefined;
    const t = setup(["good"], {
      good: [[created(), stageXY, msg("e2", "apply_changes", { summary: "s" }),
        { type: "tool.approval_required", id: "e3", threadId: "main", toolCalls: [{ id: "tc-e2", sourceEventId: "e2" }] }], [done("e9", { status: "cancelled", reason: "client-cancelled" })]],
    }, { reviewImpl: (_items, signal) => { seenSignal = signal; return new Promise((res) => signal.addEventListener("abort", () => res(new Map()))); } });
    const p = t.runner.run("go");
    await new Promise((r) => setTimeout(r, 30));
    await t.runner.cancel();
    const r = await p;
    expect(r.status).toBe("cancelled");
    expect(seenSignal!.aborted).toBe(true);
    expect(t.calls.sent).toEqual([]);
    expect(t.overlay.staged().size).toBe(0);
  });
});

describe("run lifecycle safety", () => {
  it("cancel during retry backoff stops the run: no further session is created", async () => {
    const t = setup(["a"], { a: [[created(), done("e2", { status: "error", message: "Connection error: ECONNREFUSED" })]] });
    (t.runner as any).o.retries = 1;
    (t.runner as any).o.sleep = async () => { await t.runner.cancel(); };
    const r = await t.runner.run("go");
    expect(r.status).toBe("cancelled");
    expect(t.calls.created).toEqual(["a"]);
  });
  it("a second run while one is active is refused and does not disturb the first", async () => {
    const t = setup(["a"], { a: (cancelled: Promise<void>) => (async function* () { yield created(); await cancelled; })() });
    const first = t.runner.run("one");
    await new Promise((r) => setTimeout(r, 20));
    const second = await t.runner.run("two");
    expect(second.status).toBe("busy");
    expect(t.calls.created).toEqual(["a"]);
    await t.runner.cancel();
    expect((await first).status).toBe("cancelled");
  });
});

describe("fallback after applied changes", () => {
  it("does not re-run the request on another model once the user applied hunks, and says the edits were kept", async () => {
    const t = setup(["first", "second"], {
      first: [
        [created(), stageXY, msg("e4", "apply_changes", { summary: "s" }),
          { type: "tool.approval_required", id: "e5", threadId: "main", toolCalls: [{ id: "tc-e4", sourceEventId: "e4" }] },
          { type: "turn.update", id: "e6", state: { status: "paused" }, threadId: null }],
        [done("e8", { status: "error", message: "[Model Error] Cannot connect to API: ECONNREFUSED" })],
      ],
      second: [[created(), done("e2")]],
    });
    const r = await t.runner.run("go");
    expect(r.status).toBe("error");
    expect(t.calls.created).toEqual(["first"]);
    expect(t.log.notices.join(" ")).toMatch(/kept.*Undo/i);
  });
  it("still falls back when the user applied nothing", async () => {
    const t = setup(["first", "second"], {
      first: [[created(), done("e2", { status: "error", message: "[Model Error] Cannot connect to API: ECONNREFUSED" })]],
      second: [[created(), done("e2")]],
    });
    expect((await t.runner.run("go")).model).toBe("second");
  });
});

describe("apply_changes with nothing to change", () => {
  it("records empty decisions so the tool can report instead of failing", async () => {
    const t = setup(["good"], {
      good: [
        [created(), async () => { await T.overlay.stageEdit(path.join(T.root, "a.py"), "x = 1", "x = 1"); }, msg("e4", "apply_changes", { summary: "s" }),
          { type: "tool.approval_required", id: "e5", threadId: "main", toolCalls: [{ id: "tc-e4", sourceEventId: "e4" }] }],
        [done("e8")],
      ],
    });
    let seen: unknown = "unset";
    const orig = (t.runner as any).client.sendEvents;
    (t.runner as any).client.sendEvents = async (...a: any[]) => { seen = t.review.decisions; return orig(...a); };
    await t.runner.run("go");
    expect(seen).toEqual(new Map());
  });
});
