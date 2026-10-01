export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function asRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((row): row is Record<string, unknown> => row !== undefined)
    : [];
}

export function numberField(row: Record<string, unknown> | undefined, key: string): number {
  const value = row?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function optionalNumberField(
  row: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = row?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function stringField(row: Record<string, unknown> | undefined, key: string): string {
  const value = row?.[key];
  return typeof value === 'string' && value !== '' ? value : '';
}

// --- Token / perf / safety primitives (shared, allocation-lean) ---
export function clampInt(v: unknown, lo: number, hi: number, fb: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fb;
  return n < lo ? lo : n > hi ? hi : n;
}

/** Size-capped JSON: never blow token budget on one tool result. */
export function budgetedJson(value: unknown, maxChars = 24_000): { text: string; truncated: boolean } {
  const text = JSON.stringify(value);
  if (text.length <= maxChars) return { text, truncated: false };
  // Fast path: truncate arrays at top-level `results`/`matches` keys when present.
  try {
    const rec = value as Record<string, unknown>;
    if (rec && typeof rec === 'object' && !Array.isArray(rec)) {
      const copy: Record<string, unknown> = { ...rec, truncated: true, appliedLimits: true };
      for (const k of ['results', 'matches', 'items', 'entries']) {
        const arr = (rec as Record<string, unknown>)[k];
        if (Array.isArray(arr) && arr.length > 25) copy[k] = arr.slice(0, 25);
      }
      const t2 = JSON.stringify(copy);
      if (t2.length <= maxChars) return { text: t2, truncated: true };
      return { text: `${t2.slice(0, maxChars - 1)}…`, truncated: true };
    }
  } catch { /* fall through */ }
  return { text: `${text.slice(0, maxChars - 1)}…`, truncated: true };
}

/** Retry with exponential backoff + jitter. Retries 429/5xx + network errors only. Never retries caller abort. */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: { attempts?: number; baseMs?: number; timeoutMs?: number } = {},
): Promise<Response> {
  const attempts = clampInt(opts.attempts ?? 3, 1, 5, 3);
  const baseMs = clampInt(opts.baseMs ?? 250, 50, 2000, 250);
  const timeoutMs = clampInt(opts.timeoutMs ?? 30_000, 1000, 120_000, 30_000);
  const caller = init.signal as AbortSignal | undefined;
  if (caller?.aborted) throw new DOMException('Aborted', 'AbortError');
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    // Allow caller signal to abort our controller.
    const onAbort = () => ctrl.abort();
    caller?.addEventListener?.('abort', onAbort, { once: true });
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
        const ra = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 5000) : baseMs * 2 ** i + Math.random() * 100;
        await sleep(wait);
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      return res;
    } catch (e) {
      if ((e as Error)?.name === 'AbortError' && caller?.aborted) throw e;
      lastErr = e;
      if (i < attempts - 1) await sleep(baseMs * 2 ** i + Math.random() * 100);
    } finally {
      clearTimeout(t);
      caller?.removeEventListener?.('abort', onAbort);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Tiny TTL cache with in-flight dedup — avoids repeat package/doc fetches. LRU-evicts oldest. */
export class TtlCache<T> {
  private store = new Map<string, { exp: number; val: T }>();
  private inflight = new Map<string, Promise<T>>();
  constructor(private ttlMs: number = 60_000, private max = 200) {}
  async getOrFetch(key: string, fn: () => Promise<T>, opts: { cacheNull?: boolean } = {}): Promise<T> {
    const now = Date.now();
    const hit = this.store.get(key);
    if (hit && hit.exp > now) return hit.val;
    const f = this.inflight.get(key);
    if (f) return f;
    const p = fn().then((v) => {
      const isNull = v === null || v === undefined;
      if (!isNull || opts.cacheNull) {
        if (this.store.size >= this.max) {
          const oldest = this.store.keys().next().value;
          if (oldest !== undefined) this.store.delete(oldest);
        }
        this.store.set(key, { exp: Date.now() + this.ttlMs, val: v });
      }
      this.inflight.delete(key);
      return v;
    }).catch((e) => { this.inflight.delete(key); throw e; });
    this.inflight.set(key, p);
    return p;
  }
  clear(): void { this.store.clear(); this.inflight.clear(); }
}

/** Heuristic: plain identifier/literal => Studio can use fast literal path (ast-grep leaf). */
export function isPlainLiteral(pattern: string): boolean {
  if (!pattern || pattern.length > 256) return false;
  return /^[A-Za-z0-9_:.]+$/.test(pattern);
}
