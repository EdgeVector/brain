// Keep half the native key budget for layout, metadata, and conflict reads.
// A projected row needs its key plus a tip and atom for each field. Reserve
// one probe row. Queries in one IPC batch share the same native budget.
const PLANNED_KEY_BUDGET = 5000;
export const QUERY_PAGE_SIZE = 128;

export function queryPageSize(fieldCount: number, queryCount = 1): number {
  if (!Number.isSafeInteger(fieldCount) || fieldCount < 0
      || !Number.isSafeInteger(queryCount) || queryCount < 1 || queryCount > 64) {
    throw new RangeError("A query page needs valid field and query counts.");
  }
  // An empty projection means all fields. Its unknown width gets one row;
  // the native guard still refuses an unsupported wide schema.
  if (fieldCount === 0) return 1;
  const rows = Math.min(QUERY_PAGE_SIZE,
    Math.floor(PLANNED_KEY_BUDGET / (queryCount * (1 + 2 * fieldCount))) - 1);
  if (rows < 1) throw new RangeError("The projected query exceeds the bounded read budget.");
  return rows;
}
