import type { Host, ReviewItem } from "../host";
import type { Overlay } from "../workspace/overlay";
import type { ReviewState } from "../mcp/tools";
import { computeHunks } from "../workspace/hunks";
import { makeClient, type ForgeEvent, type TrueForgeLike } from "../forge/client";
import { withFallback, type FallbackEvent } from "../forge/resilience";
import { buildAgentSpec } from "./spec";

export type RunEvents = {
  delta(text: string): void;
  toolCall(name: string, args: unknown): void;
  toolResult(name: string, text: string): void;
  status(s: "running" | "paused" | "done" | "cancelled" | "error", detail?: string): void;
  notice(msg: string): void;
};

export type RunnerOptions = {
  baseUrl: string; models: string[]; mcpName: string;
  host: Host; review: ReviewState; overlay: Overlay; events: RunEvents;
  client?: TrueForgeLike; retries?: number; baseMs?: number; sleep?: (ms: number) => Promise<void>;
  autoApproveCommands?: RegExp[];
};

type Pending = { threadId: string; refs: { id: string; sourceEventId: string }[] };

export class AgentRunner {
  private client: TrueForgeLike;
  private abort = new AbortController();
  private cancelled = false;
  private sessionId: string | undefined;
  private models: string[];
  constructor(private o: RunnerOptions) {
    this.client = o.client ?? makeClient(o.baseUrl);
    this.models = [...o.models];
  }

  switchPrimary(model: string): void {
    this.models = [model, ...this.models.filter((m) => m !== model)];
  }

  async run(prompt: string): Promise<{ status: string; model: string }> {
    const { events } = this.o;
    this.cancelled = false;
    this.abort = new AbortController();
    this.o.review.signal = this.abort.signal;
    this.o.review.decisions = null;
    let usedModel = this.models[0] ?? "";
    events.status("running");
    try {
      const status = await withFallback(this.models, async (model) => {
        usedModel = model;
        return this.attempt(model, prompt);
      }, {
        retries: this.o.retries ?? 2, baseMs: this.o.baseMs ?? 800, sleep: this.o.sleep,
        onEvent: (e) => events.notice(this.describe(e)),
      });
      events.status(status);
      return { status, model: usedModel };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      events.notice(`Run failed: ${message}`);
      events.status("error", message);
      return { status: "error", model: usedModel };
    } finally {
      this.o.overlay.clear();
    }
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.abort.abort();
    this.o.overlay.clear();
    if (this.sessionId) {
      try { await this.client.cancel(this.sessionId); } catch { /* the stream/abort already ended the run locally */ }
    }
  }

  private describe(e: FallbackEvent): string {
    if (e.kind === "retry") return `${e.model} failed (${e.message}); retrying…`;
    if (e.kind === "fallback") return `${e.model} failed (${e.message}); falling back to ${e.next}`;
    return `All configured models failed. Last error: ${e.message}`;
  }

  private async attempt(model: string, prompt: string): Promise<"done" | "cancelled"> {
    const { client } = this;
    this.o.overlay.clear();
    this.o.review.decisions = null;
    const { id } = await client.createSession(buildAgentSpec(model, this.o.mcpName));
    this.sessionId = id;
    const calls = new Map<string, { name: string; args: any }>();
    const partials = new Map<string, { id: string; name: string; args: string }>();
    // Tool calls arrive as streamed deltas; deferred tools arrive wrapped in call_tool({mcp_server, tool_name, input}).
    const finalize = (id: string, rawName: string, rawArgs: string) => {
      if (!id || calls.has(id)) return;
      let args: any = {};
      try { args = JSON.parse(rawArgs || "{}"); } catch { /* keep {} */ }
      let name = rawName;
      if (rawName === "call_tool" && typeof args?.tool_name === "string") { name = args.tool_name; args = args.input ?? {}; }
      calls.set(id, { name, args });
      this.o.events.toolCall(name, args);
    };
    let turnId = "";
    let lastId: string | undefined;
    let stream = await client.startTurn(id, prompt);
    const aborted = new Promise<"abort">((res) => this.abort.signal.addEventListener("abort", () => res("abort"), { once: true }));

    for (;;) {
      let pending: Pending | null = null;
      let finished: ForgeEvent | null = null;
      const it = stream[Symbol.asyncIterator]();
      loop: for (;;) {
        const r = await Promise.race([it.next(), aborted]);
        if (r === "abort") { void it.return?.(); return "cancelled"; }
        if (r.done) break;
        const ev = r.value as ForgeEvent;
        lastId = ev.id ?? lastId;
        switch (ev.type) {
          case "turn.created": turnId = ev.turnId; break;
          case "model.message.delta": {
            if (ev.content) this.o.events.delta(ev.content);
            for (const d of ev.toolCalls ?? []) {
              const key = `${ev.id}:${d.index ?? 0}`;
              const slot = partials.get(key) ?? { id: "", name: "", args: "" };
              if (d.id) slot.id = d.id;
              if (d.function?.name) slot.name = d.function.name;
              if (d.function?.arguments) slot.args += d.function.arguments;
              partials.set(key, slot);
            }
            if (ev.finishReason) {
              for (const [key, slot] of partials) if (key.startsWith(`${ev.id}:`)) { finalize(slot.id, slot.name, slot.args); partials.delete(key); }
            }
            break;
          }
          case "model.message":
            for (const tc of ev.toolCalls ?? []) finalize(tc.id, tc.function?.name, tc.function?.arguments ?? "{}");
            break;
          case "tool.response": this.o.events.toolResult(calls.get(ev.toolCallId)?.name ?? "tool", String(ev.content ?? "")); break;
          case "tool.approval_required": pending = { threadId: ev.threadId, refs: ev.toolCalls ?? [] }; break;
          case "turn.update": if (ev.state?.status === "paused") { this.o.events.status("paused"); break loop; } break;
          case "turn.done": finished = ev; break loop;
        }
      }
      if (this.cancelled) return "cancelled";
      if (finished) {
        const st = finished.state ?? {};
        if (st.status === "done") return "done";
        if (st.status === "cancelled") return "cancelled";
        throw new Error(st.message ?? "agent turn failed");
      }
      if (!pending) throw new Error("connection to TrueForge closed before the turn finished");

      const approvals: object[] = [];
      for (const ref of pending.refs) {
        const call = calls.get(ref.id);
        const decision = await this.decide(call?.name, call?.args);
        if (this.cancelled) return "cancelled";
        approvals.push({ type: "user.tool_approval", threadId: pending.threadId, toolCallId: ref.id, approval: decision });
      }
      this.o.events.status("running");
      stream = await client.subscribe(id, turnId, lastId);
      await client.sendEvents(id, turnId, approvals);
    }
  }

  private async decide(name: string | undefined, args: any): Promise<{ status: "allow" } | { status: "deny"; reason: string }> {
    const { host, overlay, review } = this.o;
    if (name === "apply_changes") {
      const items: ReviewItem[] = [];
      for (const [abs, s] of overlay.staged()) {
        const hunks = computeHunks(s.original ?? "", s.proposed);
        if (hunks.length) items.push({ abs, original: s.original, proposed: s.proposed, hunks });
      }
      if (!items.length) return { status: "allow" };
      const decisions = await host.reviewChanges(items, this.abort.signal);
      review.decisions = decisions;
      const any = [...decisions.values()].some((s) => s.size > 0);
      return any ? { status: "allow" } : { status: "deny", reason: "the user rejected all changes" };
    }
    if (name === "run_command") {
      const cmd = String(args?.command ?? "");
      if (this.o.autoApproveCommands?.some((re) => re.test(cmd))) return { status: "allow" };
      return (await host.confirmCommand(cmd, this.abort.signal)) ? { status: "allow" } : { status: "deny", reason: "the user declined to run this command" };
    }
    return { status: "deny", reason: `tool ${name ?? "unknown"} is not approved` };
  }
}
