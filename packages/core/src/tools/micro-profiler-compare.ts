import * as fs from 'fs';
import * as path from 'path';
import { asRecord, asRows, numberField, stringField } from './util.js';

export function microProfilerDurationMs(body: Record<string, unknown> | undefined): number {
  const analysisWindow = asRecord(body?.analysis_window);
  const analysisDurationUs = analysisWindow?.analysis_duration_us;
  if (typeof analysisDurationUs === 'number' && Number.isFinite(analysisDurationUs) && analysisDurationUs > 0) {
    return analysisDurationUs / 1000;
  }
  const duration = body?.duration_ms;
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : 1000;
}

export function perSecond(totalUs: number, durationMs: number): number {
  return durationMs > 0 ? totalUs / (durationMs / 1000) : totalUs;
}

export function roundNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

export function percentDelta(current: number, baseline: number): number | undefined {
  if (baseline === 0) return current === 0 ? 0 : undefined;
  return roundNumber(((current - baseline) / baseline) * 100);
}

export function inclusiveUsField(row: Record<string, unknown> | undefined): number {
  const inclusive = numberField(row, 'inclusive_us');
  return inclusive !== 0 ? inclusive : numberField(row, 'total_us');
}

export function rowSet(body: Record<string, unknown>, key: 'groups' | 'timers' | 'threads' | 'call_edges', fallback: string): Record<string, unknown>[] {
  const comparisonIndex = asRecord(body.comparison_index);
  const indexed = asRows(comparisonIndex?.[key]);
  return indexed.length > 0 ? indexed : asRows(body[fallback]);
}

export function nestedRecord(row: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  return asRecord(row?.[key]);
}

export function loadMicroProfilerBaseline(source: unknown, sourcePath: unknown): Record<string, unknown> | undefined {
  if (source !== undefined) {
    const inline = asRecord(source);
    if (!inline) throw new Error('baseline must be an object when provided');
    return inline;
  }
  if (sourcePath !== undefined) {
    if (typeof sourcePath !== 'string' || sourcePath === '') {
      throw new Error('baseline_path must be a non-empty string when provided');
    }
    const resolved = path.resolve(sourcePath);
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown;
    const record = asRecord(parsed);
    if (!record) throw new Error(`baseline_path did not contain a JSON object: ${resolved}`);
    return record;
  }
  return undefined;
}

export function compareMicroProfilerRows(
  currentRows: Record<string, unknown>[],
  baselineRows: Record<string, unknown>[],
  currentDurationMs: number,
  baselineDurationMs: number,
  keyForRow: (row: Record<string, unknown>) => string,
  labelForRow: (row: Record<string, unknown>, fallbackKey: string) => Record<string, unknown>,
  maxRows: number,
): Record<string, unknown>[] {
  const currentByKey = new Map<string, Record<string, unknown>>();
  const baselineByKey = new Map<string, Record<string, unknown>>();
  for (const row of currentRows) {
    const key = keyForRow(row);
    if (key) currentByKey.set(key, row);
  }
  for (const row of baselineRows) {
    const key = keyForRow(row);
    if (key) baselineByKey.set(key, row);
  }

  const usesFullIndex = currentRows.length > 0 && baselineRows.length > 0;
  const keys = new Set<string>([...currentByKey.keys(), ...baselineByKey.keys()]);
  const deltas: Record<string, unknown>[] = [];
  for (const key of keys) {
    const current = currentByKey.get(key);
    const baseline = baselineByKey.get(key);
    const currentInclusiveUs = inclusiveUsField(current);
    const baselineInclusiveUs = inclusiveUsField(baseline);
    const currentExclusiveUs = numberField(current, 'exclusive_us');
    const baselineExclusiveUs = numberField(baseline, 'exclusive_us');
    const currentCount = numberField(current, 'count');
    const baselineCount = numberField(baseline, 'count');
    const currentUsPerS = perSecond(currentInclusiveUs, currentDurationMs);
    const baselineUsPerS = perSecond(baselineInclusiveUs, baselineDurationMs);
    const currentExclusiveUsPerS = perSecond(currentExclusiveUs, currentDurationMs);
    const baselineExclusiveUsPerS = perSecond(baselineExclusiveUs, baselineDurationMs);
    const currentCountPerS = perSecond(currentCount, currentDurationMs);
    const baselineCountPerS = perSecond(baselineCount, baselineDurationMs);
    const row: Record<string, unknown> = {
      ...labelForRow(current ?? baseline!, key),
      matched_by: 'stable_label',
      match_confidence: 'medium',
      current_inclusive_us: currentInclusiveUs,
      baseline_inclusive_us: baselineInclusiveUs,
      delta_inclusive_us: currentInclusiveUs - baselineInclusiveUs,
      current_inclusive_us_per_s: roundNumber(currentUsPerS),
      baseline_inclusive_us_per_s: roundNumber(baselineUsPerS),
      delta_inclusive_us_per_s: roundNumber(currentUsPerS - baselineUsPerS),
      current_exclusive_us: currentExclusiveUs,
      baseline_exclusive_us: baselineExclusiveUs,
      delta_exclusive_us: currentExclusiveUs - baselineExclusiveUs,
      current_exclusive_us_per_s: roundNumber(currentExclusiveUsPerS),
      baseline_exclusive_us_per_s: roundNumber(baselineExclusiveUsPerS),
      delta_exclusive_us_per_s: roundNumber(currentExclusiveUsPerS - baselineExclusiveUsPerS),
      current_count: currentCount,
      baseline_count: baselineCount,
      delta_count: currentCount - baselineCount,
      current_count_per_s: roundNumber(currentCountPerS),
      baseline_count_per_s: roundNumber(baselineCountPerS),
      delta_count_per_s: roundNumber(currentCountPerS - baselineCountPerS),
    };
    if (!usesFullIndex) row.match_scope = 'returned_rows';
    const pct = percentDelta(currentUsPerS, baselineUsPerS);
    if (pct !== undefined) row.delta_pct = pct;
    deltas.push(row);
  }

  deltas.sort((a, b) => Math.abs(numberField(b, 'delta_inclusive_us_per_s')) - Math.abs(numberField(a, 'delta_inclusive_us_per_s')));
  return deltas.slice(0, maxRows);
}

export function compareMicroProfilerCaptures(
  current: Record<string, unknown>,
  baseline: Record<string, unknown>,
  options: { currentLabel?: string; baselineLabel?: string; maxRows?: number } = {},
): Record<string, unknown> {
  const currentDurationMs = microProfilerDurationMs(current);
  const baselineDurationMs = microProfilerDurationMs(baseline);
  const maxRows = Math.max(1, Math.min(100, Math.trunc(options.maxRows ?? 20)));

  const groupDeltas = compareMicroProfilerRows(
    rowSet(current, 'groups', 'top_groups'),
    rowSet(baseline, 'groups', 'top_groups'),
    currentDurationMs,
    baselineDurationMs,
    (row) => stringField(row, 'group'),
    (row, key) => ({ group: stringField(row, 'group') || key }),
    maxRows,
  );

  const timerDeltas = compareMicroProfilerRows(
    rowSet(current, 'timers', 'top_timers'),
    rowSet(baseline, 'timers', 'top_timers'),
    currentDurationMs,
    baselineDurationMs,
    (row) => `${stringField(row, 'group')}::${stringField(row, 'name') || stringField(row, 'timer_id')}`,
    (row, key) => ({
      group: stringField(row, 'group') || key.split('::')[0],
      name: stringField(row, 'name') || key.split('::')[1],
      timer_id: row.timer_id,
    }),
    maxRows,
  );

  const threadDeltas = compareMicroProfilerRows(
    rowSet(current, 'threads', 'top_threads'),
    rowSet(baseline, 'threads', 'top_threads'),
    currentDurationMs,
    baselineDurationMs,
    (row) => stringField(row, 'thread_name') || String(numberField(row, 'thread_id')),
    (row, key) => ({
      thread_id: row.thread_id,
      thread_name: stringField(row, 'thread_name') || key,
      is_gpu: row.is_gpu,
    }),
    maxRows,
  );

  const edgeDeltas = compareMicroProfilerRows(
    rowSet(current, 'call_edges', 'top_call_edges'),
    rowSet(baseline, 'call_edges', 'top_call_edges'),
    currentDurationMs,
    baselineDurationMs,
    (row) => {
      const parent = nestedRecord(row, 'parent');
      const child = nestedRecord(row, 'child');
      return [
        stringField(parent, 'group'),
        stringField(parent, 'name') || stringField(parent, 'timer_id'),
        '>',
        stringField(child, 'group'),
        stringField(child, 'name') || stringField(child, 'timer_id'),
      ].join('::');
    },
    (row, key) => ({
      parent: nestedRecord(row, 'parent') ?? { label: key },
      child: nestedRecord(row, 'child') ?? { label: key },
    }),
    maxRows,
  );

  const currentHasIndex = asRecord(current.comparison_index) !== undefined;
  const baselineHasIndex = asRecord(baseline.comparison_index) !== undefined;
  return {
    baseline_label: options.baselineLabel ?? 'baseline',
    current_label: options.currentLabel ?? 'current',
    basis: 'inclusive_us_per_second normalized by each capture analysis duration; deltas use current minus baseline.',
    coverage: {
      current: currentHasIndex ? 'comparison_index' : 'returned_rows',
      baseline: baselineHasIndex ? 'comparison_index' : 'returned_rows',
    },
    duration_ms: {
      baseline: baselineDurationMs,
      current: currentDurationMs,
    },
    groups: groupDeltas,
    timers: timerDeltas,
    threads: threadDeltas,
    call_edges: edgeDeltas,
  };
}
