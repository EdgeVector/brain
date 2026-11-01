// Whole-record size budget for a LastDB format 7 home.
//
// A format 7 home stores ONE value per record key: every field of the record
// plus one stamp per field, and it refuses a value above 64 KiB
// (`lastdb_model::record_value::MAX_RECORD_BYTES`). A format 6 home checks each
// field on its own, so a record whose fields each pass can still be too large
// as a whole on format 7. Brain keeps every written record under
// RECORD_BUDGET_BYTES, measured with an upper-bound estimate, so the same write
// is valid on format 6 and format 7 and a too-large write fails in brain with
// the record named instead of as a node error after part of a command ran.
//
// Pure module on purpose: client.ts and body-spill.ts both import it, and
// body-spill.ts already imports client.ts.

/** The format 7 cap for the encoded value of one record (decision D3). */
export const RECORD_CAP_BYTES = 64 * 1024;

/** Brain's budget for one record, measured by `recordBytes`. Headroom under the cap. */
export const RECORD_BUDGET_BYTES = 60 * 1024;

// The stored value is
//   {"v":1,"fields":{...},"stamps":{"<field>":[written_at,logical_counter,device_id,mutation_id],...},"deleted":[...]}
// The stamp below uses the largest u64 for both numbers, a 64-character device
// id and a 36-character mutation id, so it is at least as long as any real
// stamp. It is the same bound as `record_bytes` in last-stack
// bin/last-stack-lastdb-home-copy, with 20-digit numbers instead of 19.
const STAMP_JSON = `[18446744073709551615,18446744073709551615,"${"f".repeat(64)}","${"0".repeat(36)}"]`;
const STAMP_BYTES = Buffer.byteLength(STAMP_JSON, "utf8");
// The node may store a field under its canonical name (canonical-fields.json,
// at most 38 characters today) instead of brain's local name. Count every name
// as at least this long so a later, longer canonical name keeps the bound.
const NAME_FLOOR_BYTES = 64;
// Envelope, the commas, and one delete floor (a re-created record keeps it).
const FRAME_BYTES =
  Buffer.byteLength('{"v":1,"fields":{},"stamps":{},"deleted":}', "utf8") + STAMP_BYTES;

/**
 * Upper-bound size of the format 7 stored value for a record that holds
 * `fields`. A field whose value is `undefined` is not sent, so it is not
 * counted. Record metadata (source file name, metadata map) is not counted:
 * brain never writes it.
 */
export function recordBytes(fields: Record<string, unknown>): number {
  let total = FRAME_BYTES;
  let count = 0;
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const key = Math.max(Buffer.byteLength(JSON.stringify(name), "utf8"), NAME_FLOOR_BYTES + 2) + 1;
    const valueBytes = Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
    total += key + valueBytes + key + STAMP_BYTES;
    count += 1;
  }
  // One comma between entries, in both the fields map and the stamps map.
  return total + 2 * Math.max(0, count - 1);
}

/** True when a record that holds `fields` is over the budget. */
export function overRecordBudget(fields: Record<string, unknown>): boolean {
  return recordBytes(fields) > RECORD_BUDGET_BYTES;
}

/** One sentence that names the record, its estimated size, the budget, and the cap. */
export function recordBudgetMessage(what: string, bytes: number): string {
  return (
    `${what}: the record is about ${bytes} bytes as one stored value; the budget is ` +
    `${RECORD_BUDGET_BYTES} bytes (a format 7 home refuses a record above ${RECORD_CAP_BYTES} bytes).`
  );
}
