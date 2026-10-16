import { isRecordType, type RecordType } from "./schemas.ts";

export type ListCountState = {
  count: number;
  // Each count has at most one receipt per finite record type. A backfill
  // cursor serializes that source's sequence before its membership changes.
  receipts: Partial<Record<RecordType, number>>;
};

/** Older installations store only a decimal integer in bln_n. */
export function parseListCount(raw: string | null): ListCountState | null {
  if (raw === null) return null;
  if (/^-?\d+$/.test(raw)) {
    const count = Number(raw);
    return Number.isSafeInteger(count) ? { count, receipts: {} } : null;
  }
  try {
    const value = JSON.parse(raw) as {
      version?: unknown;
      count?: unknown;
      receipts?: unknown;
    };
    if (value.version !== 1 || !Number.isSafeInteger(value.count) || value.receipts === null ||
      typeof value.receipts !== "object" || Array.isArray(value.receipts)) return null;
    const receipts: ListCountState["receipts"] = {};
    for (const [source, sequence] of Object.entries(value.receipts)) {
      if (!isRecordType(source) || !Number.isSafeInteger(sequence) || Number(sequence) < 1) return null;
      receipts[source] = Number(sequence);
    }
    return { count: Number(value.count), receipts };
  } catch {
    return null;
  }
}

export function serializeListCount(state: ListCountState): string {
  // Keep the legacy form until a backfill needs its first receipt.
  return Object.keys(state.receipts).length === 0
    ? String(state.count)
    : JSON.stringify({ version: 1, count: state.count, receipts: state.receipts });
}

export function countAfterDelta(raw: string | null, delta: number): string | null {
  const parsed = parseListCount(raw);
  if (raw !== null && parsed === null) return null;
  const state = parsed ?? { count: 0, receipts: {} };
  const count = Math.max(0, state.count + delta);
  return Number.isSafeInteger(count) ? serializeListCount({ ...state, count }) : null;
}
