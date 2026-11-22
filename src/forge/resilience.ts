export type FallbackEvent = { kind: "retry" | "fallback" | "failed"; model: string; message: string; next?: string };

const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const statusOf = (e: unknown): number | undefined => {
  const x = e as { statusCode?: number; status?: number } | null;
  return x?.statusCode ?? x?.status;
};

export function isAuthError(e: unknown): boolean {
  const s = statusOf(e);
  if (s === 401 || s === 403) return true;
  return /\b(401|403)\b|api[\s_-]?key|unauthori[sz]ed|forbidden|authentication/i.test(msgOf(e));
}

export function isRetryable(e: unknown): boolean {
  if (isAuthError(e)) return false;
  const s = statusOf(e);
  if (s !== undefined && (s >= 500 || s === 429 || s === 408)) return true;
  return /cannot connect|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|connection|timed?[\s-]?out|timeout|network|socket|\b5\d\d\b|\b429\b|rate.?limit|overloaded|unavailable|unreachable/i.test(msgOf(e));
}

/** TrueForge prefixes failures that came from the model call itself with "[Model Error]". */
export function isModelError(e: unknown): boolean {
  return /\[Model Error\]/.test(msgOf(e));
}

export async function withFallback<T>(
  models: string[],
  attempt: (model: string) => Promise<T>,
  o: { retries: number; baseMs: number; onEvent: (e: FallbackEvent) => void; sleep?: (ms: number) => Promise<void> },
): Promise<T> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: unknown = new Error("no models configured");
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    for (let n = 0; ; n++) {
      try {
        return await attempt(model);
      } catch (e) {
        last = e;
        if ((e as { noFallback?: boolean } | null)?.noFallback) throw e;
        if (!isAuthError(e) && !isRetryable(e) && !isModelError(e)) throw e;
        if (isRetryable(e) && n < o.retries) {
          o.onEvent({ kind: "retry", model, message: msgOf(e) });
          await sleep(o.baseMs * 2 ** n);
          continue;
        }
        break;
      }
    }
    if (i < models.length - 1) o.onEvent({ kind: "fallback", model, next: models[i + 1], message: msgOf(last) });
  }
  o.onEvent({ kind: "failed", model: models[models.length - 1] ?? "", message: msgOf(last) });
  throw last;
}
