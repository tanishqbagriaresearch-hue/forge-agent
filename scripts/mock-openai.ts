import http from "node:http";
import type { AddressInfo } from "node:net";

export type ChatMessage = { role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string; name?: string };
export type MockReply =
  | { text: string; stall?: boolean }
  | { toolCalls: { name: string; args: object }[]; text?: string }
  | { status: number };
export type MockScript = (messages: ChatMessage[], tools: string[]) => MockReply | Promise<MockReply>;

export async function startMockOpenAI(script: MockScript, port = 0) {
  const requests: any[] = [];
  const open = new Set<http.ServerResponse>();
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url?.includes("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ object: "list", data: [{ id: "mock-1", object: "model" }] }));
      return;
    }
    if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
      res.statusCode = 404; res.end("not found"); return;
    }
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || "{}");
    requests.push(body);
    const tools: string[] = (body.tools ?? []).map((t: any) => t.function?.name ?? t.name);
    const reply = await script(body.messages ?? [], tools);
    if ("status" in reply) { res.statusCode = reply.status; res.end(JSON.stringify({ error: { message: "mock error", type: "mock" } })); return; }
    const id = "chatcmpl-" + Math.random().toString(36).slice(2);
    const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model ?? "mock-1" };
    const toolCalls = "toolCalls" in reply ? reply.toolCalls : [];
    const text = reply.text ?? "";
    if (body.stream === false) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, finish_reason: toolCalls.length ? "tool_calls" : "stop",
        message: { role: "assistant", content: text || null, tool_calls: toolCalls.map((t, i) => ({ id: `call_${id}_${i}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } })) } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    open.add(res);
    res.on("close", () => open.delete(res));
    const send = (delta: object, finish: string | null = null) =>
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    send({ role: "assistant", content: "" });
    for (const word of text.split(/(?<= )/).filter(Boolean)) { send({ content: word }); await new Promise((r) => setTimeout(r, 5)); }
    if ("stall" in reply && reply.stall) return; // hold the stream open until closed (cancellation tests)
    toolCalls.forEach((t, i) => send({ tool_calls: [{ index: i, id: `call_${id}_${i}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } }] }));
    send({}, toolCalls.length ? "tool_calls" : "stop");
    res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const p = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${p}/v1`,
    requests,
    close: () => new Promise<void>((r) => { open.forEach((x) => x.destroy()); server.close(() => r()); }),
  };
}
