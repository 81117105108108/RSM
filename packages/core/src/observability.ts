/**
 * Lightweight structured logging + counters/histograms for bridge operations.
 *
 * Privacy contract: only `{ tool, durationMs, bytes, outcome }` are ever
 * recorded or logged. Never pass request/response payloads, peer/instance
 * IDs, place names, source code, tokens, or cookies to this module. Tool
 * labels are sanitized (bounded length, no whitespace/control characters)
 * so accidental payloads cannot become high-cardinality labels.
 *
 * Reliability contract: every export is non-throwing and bounded in memory.
 * Observability is inert by default (no logger configured, no console
 * output); callers invoke hooks inline without changing control flow.
 */

export type ObservabilityOutcome =
  | 'success'
  | 'error'
  | 'timeout'
  | 'disconnected'
  | 'aborted'
  | 'evicted'
  | 'saturated'
  | 'not_executed'
  | 'unknown';

export type ObservabilityFaultKind = 'disconnect' | 'timeout' | 'eviction' | 'saturation';

export type ObservabilityLevel = 'debug' | 'info' | 'warn' | 'error';

export interface OperationObservation {
  /** Tool/endpoint label only (e.g. "/api/mutate"). Never PII or payloads. */
  tool: string;
  durationMs?: number;
  bytes?: number;
  outcome: ObservabilityOutcome;
}

export interface ObservabilityLogEvent {
  timestamp: number;
  level: ObservabilityLevel;
  /** Either "operation" or "fault.<kind>". */
  event: string;
  tool: string;
  outcome: ObservabilityOutcome;
  durationMs?: number;
  bytes?: number;
}

export type ObservabilityLogger = (event: ObservabilityLogEvent) => void;

export interface ToolStatsSnapshot {
  count: number;
  outcomes: Record<ObservabilityOutcome, number>;
  totalDurationMs: number;
  totalBytes: number;
  avgDurationMs: number;
  avgBytes: number;
  durationHistogram: { buckets: number[]; counts: number[] };
  bytesHistogram: { buckets: number[]; counts: number[] };
}

export interface ObservabilitySnapshot {
  tools: Record<string, ToolStatsSnapshot>;
  faults: Record<ObservabilityFaultKind, number>;
  totals: { operations: number; faults: number };
}

const MAX_TOOL_LABEL_LENGTH = 128;
const MAX_TRACKED_TOOLS = 256;
const FAULT_KINDS: readonly ObservabilityFaultKind[] = ['disconnect', 'timeout', 'eviction', 'saturation'];
const OUTCOMES: readonly ObservabilityOutcome[] = [
  'success', 'error', 'timeout', 'disconnected', 'aborted', 'evicted', 'saturated', 'not_executed', 'unknown',
];
/** Upper-inclusive bucket bounds; overflow lands in the final implicit bucket. */
export const OBSERVABILITY_DURATION_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];
export const OBSERVABILITY_BYTES_BUCKETS = [256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864];

interface ToolStats {
  count: number;
  outcomes: Record<ObservabilityOutcome, number>;
  totalDurationMs: number;
  totalBytes: number;
  durationHistogram: number[];
  bytesHistogram: number[];
}

function emptyOutcomes(): Record<ObservabilityOutcome, number> {
  return {
    success: 0, error: 0, timeout: 0, disconnected: 0, aborted: 0,
    evicted: 0, saturated: 0, not_executed: 0, unknown: 0,
  };
}

const toolStats = new Map<string, ToolStats>();
const faultCounters: Record<ObservabilityFaultKind, number> = {
  disconnect: 0, timeout: 0, eviction: 0, saturation: 0,
};
let structuredLogger: ObservabilityLogger | undefined;

export function sanitizeToolLabel(value: unknown): string {
  try {
    if (typeof value !== 'string') return 'unknown_tool';
    const trimmed = value.trim();
    if (trimmed.length === 0) return 'unknown_tool';
    // Payloads/sources/tokens contain whitespace or control characters; refuse them as labels.
    if (/[\s\x00-\x1f\x7f]/.test(trimmed)) return 'invalid_tool';
    const bounded = trimmed.slice(0, MAX_TOOL_LABEL_LENGTH);
    const sanitized = bounded.replace(/[^A-Za-z0-9_\-./:]/g, '_');
    return sanitized.length === 0 ? 'unknown_tool' : sanitized;
  } catch {
    return 'unknown_tool';
  }
}

export function sanitizeOutcome(value: unknown): ObservabilityOutcome {
  try {
    if (typeof value === 'string' && (OUTCOMES as readonly string[]).includes(value)) {
      return value as ObservabilityOutcome;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function sanitizeMeasure(value: unknown): number | undefined {
  try {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
    return Math.floor(value);
  } catch {
    return undefined;
  }
}

function isFaultKind(value: unknown): value is ObservabilityFaultKind {
  return typeof value === 'string' && (FAULT_KINDS as readonly string[]).includes(value);
}

function bucketIndex(buckets: readonly number[], value: number): number {
  for (let index = 0; index < buckets.length; index++) {
    if (value <= buckets[index]) return index;
  }
  return buckets.length;
}

function getOrCreateToolStats(tool: string): ToolStats {
  const existing = toolStats.get(tool);
  if (existing) return existing;
  if (toolStats.size >= MAX_TRACKED_TOOLS) {
    // Bounded memory: drop the oldest label. Count silently to avoid log recursion.
    const oldest = toolStats.keys().next().value;
    if (oldest !== undefined) toolStats.delete(oldest);
    faultCounters.eviction += 1;
  }
  const created: ToolStats = {
    count: 0,
    outcomes: emptyOutcomes(),
    totalDurationMs: 0,
    totalBytes: 0,
    durationHistogram: new Array(OBSERVABILITY_DURATION_BUCKETS.length + 1).fill(0),
    bytesHistogram: new Array(OBSERVABILITY_BYTES_BUCKETS.length + 1).fill(0),
  };
  toolStats.set(tool, created);
  return created;
}

function emit(event: ObservabilityLogEvent): void {
  const logger = structuredLogger;
  if (!logger) return;
  try {
    // Emit only the allowlisted fields constructed here; callers cannot smuggle payloads.
    logger({
      timestamp: event.timestamp,
      level: event.level,
      event: event.event,
      tool: event.tool,
      outcome: event.outcome,
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      ...(event.bytes !== undefined ? { bytes: event.bytes } : {}),
    });
  } catch {
    // Logger failures must never disrupt request handling.
  }
}

function levelForOutcome(outcome: ObservabilityOutcome): ObservabilityLevel {
  if (outcome === 'success') return 'info';
  if (outcome === 'not_executed' || outcome === 'unknown') return 'debug';
  return 'warn';
}

/** Record one completed operation (tool, duration, bytes, outcome only). Never throws. */
export function observeOperation(observation: OperationObservation): void {
  try {
    if (!observation || typeof observation !== 'object') return;
    const tool = sanitizeToolLabel(observation.tool);
    const outcome = sanitizeOutcome(observation.outcome);
    const durationMs = sanitizeMeasure(observation.durationMs);
    const bytes = sanitizeMeasure(observation.bytes);
    const stats = getOrCreateToolStats(tool);
    stats.count += 1;
    stats.outcomes[outcome] += 1;
    if (durationMs !== undefined) {
      stats.totalDurationMs += durationMs;
      stats.durationHistogram[bucketIndex(OBSERVABILITY_DURATION_BUCKETS, durationMs)] += 1;
    }
    if (bytes !== undefined) {
      stats.totalBytes += bytes;
      stats.bytesHistogram[bucketIndex(OBSERVABILITY_BYTES_BUCKETS, bytes)] += 1;
    }
    emit({
      timestamp: Date.now(), level: levelForOutcome(outcome), event: 'operation',
      tool, outcome,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(bytes !== undefined ? { bytes } : {}),
    });
  } catch {
    // Observability must never break the observed code path.
  }
}

/** Count a fault-injection-relevant event (disconnect/timeout/eviction/saturation). Never throws. */
export function observeFault(kind: ObservabilityFaultKind, tool?: unknown, outcome?: unknown): void {
  try {
    if (!isFaultKind(kind)) return;
    faultCounters[kind] += 1;
    const sanitizedTool = tool === undefined ? 'unknown_tool' : sanitizeToolLabel(tool);
    const sanitizedOutcome = outcome === undefined
      ? kind === 'disconnect' ? 'disconnected' satisfies ObservabilityOutcome
      : kind === 'timeout' ? 'timeout' satisfies ObservabilityOutcome
      : kind === 'eviction' ? 'evicted' satisfies ObservabilityOutcome
      : 'saturated' satisfies ObservabilityOutcome
      : sanitizeOutcome(outcome);
    emit({
      timestamp: Date.now(), level: 'warn', event: `fault.${kind}`,
      tool: sanitizedTool, outcome: sanitizedOutcome,
    });
  } catch {
    // Observability must never break the observed code path.
  }
}

/** Deep-copied snapshot for tests and diagnostics. Never throws. */
export function getObservabilitySnapshot(): ObservabilitySnapshot {
  try {
    const tools: Record<string, ToolStatsSnapshot> = {};
    for (const [tool, stats] of toolStats) {
      tools[tool] = {
        count: stats.count,
        outcomes: { ...stats.outcomes },
        totalDurationMs: stats.totalDurationMs,
        totalBytes: stats.totalBytes,
        avgDurationMs: stats.count > 0 ? stats.totalDurationMs / stats.count : 0,
        avgBytes: stats.count > 0 ? stats.totalBytes / stats.count : 0,
        durationHistogram: {
          buckets: [...OBSERVABILITY_DURATION_BUCKETS],
          counts: [...stats.durationHistogram],
        },
        bytesHistogram: {
          buckets: [...OBSERVABILITY_BYTES_BUCKETS],
          counts: [...stats.bytesHistogram],
        },
      };
    }
    const faults = { ...faultCounters };
    return {
      tools,
      faults,
      totals: {
        operations: Object.values(tools).reduce((total, stats) => total + stats.count, 0),
        faults: faults.disconnect + faults.timeout + faults.eviction + faults.saturation,
      },
    };
  } catch {
    return {
      tools: {},
      faults: { disconnect: 0, timeout: 0, eviction: 0, saturation: 0 },
      totals: { operations: 0, faults: 0 },
    };
  }
}

/** Clear all counters/histograms. Intended for tests. Never throws. */
export function resetObservability(): void {
  try {
    toolStats.clear();
    faultCounters.disconnect = 0;
    faultCounters.timeout = 0;
    faultCounters.eviction = 0;
    faultCounters.saturation = 0;
  } catch {
    // Never throw from test setup/teardown helpers.
  }
}

/**
 * Configure the structured-log sink. Default is `undefined` (no output),
 * preserving existing behavior. The sink receives only allowlisted fields.
 */
export function setObservabilityLogger(logger: ObservabilityLogger | undefined): void {
  try {
    structuredLogger = typeof logger === 'function' ? logger : undefined;
  } catch {
    structuredLogger = undefined;
  }
}
