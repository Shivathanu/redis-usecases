export const STREAM = "orders";
export const DLQ = "orders:dlq";
export const DEFAULT_GROUP = "order-processors";
export const MAX_DELIVERIES = 3; // after this many attempts a message goes to the DLQ
export const MIN_IDLE_MS = 5_000; // a pending message idle this long is considered abandoned

export function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  return fallback;
}

/** ioredis returns stream fields as a flat [k1, v1, k2, v2] array. */
export function toObject(fields: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) out[fields[i]] = fields[i + 1];
  return out;
}

export type StreamEntry = [id: string, fields: string[]];
