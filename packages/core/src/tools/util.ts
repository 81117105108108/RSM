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
