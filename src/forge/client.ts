import { TrueForge } from "@truefoundry/trueforge-sdk";

export type ForgeEvent = { type: string; id: string; [k: string]: any };

/** The slice of TrueForge the runner needs. Backed by @truefoundry/trueforge-sdk; fakeable in tests. */
export interface TrueForgeLike {
  createSession(spec: object): Promise<{ id: string }>;
  startTurn(sessionId: string, message: string): Promise<AsyncIterable<ForgeEvent>>;
  subscribe(sessionId: string, turnId: string, afterEventId?: string): Promise<AsyncIterable<ForgeEvent>>;
  sendEvents(sessionId: string, turnId: string, events: object[]): Promise<void>;
  cancel(sessionId: string): Promise<void>;
}

export function makeClient(baseUrl: string, token?: string): TrueForgeLike {
  const c = new TrueForge({ baseUrl, token, timeoutInSeconds: 600 });
  return {
    async createSession(spec) {
      const r: any = await c.sessions.create({ agent: { spec } as any });
      const id = (r.data ?? r).id as string;
      return { id };
    },
    async startTurn(sessionId, message) {
      return (await c.sessions.createTurnStream(sessionId, { input: [{ type: "user.message", content: message }] } as any)) as unknown as AsyncIterable<ForgeEvent>;
    },
    async subscribe(sessionId, turnId, afterEventId) {
      return (await c.sessions.subscribeToTurn(sessionId, turnId, afterEventId ? { afterEventId } : {}, { timeoutInSeconds: 600 })) as unknown as AsyncIterable<ForgeEvent>;
    },
    async sendEvents(sessionId, turnId, events) {
      await c.sessions.createTurnEvents(sessionId, turnId, { events: events as any });
    },
    async cancel(sessionId) {
      await c.sessions.cancel(sessionId, {});
    },
  };
}
