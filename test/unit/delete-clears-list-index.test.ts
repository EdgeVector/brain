// Compound proof: a soft-deleted record must not remain reachable through the
// type-list index (list / --count / BM25 key listing). Before the fix, delete
// tombstoned the product row but left the pre-tombstone RecordListEntry row
// in place — list/--count over-reported while get exit-1'd.
//
// Failure invariant: a record deleted through the brain CLI must not remain
// reachable through any index brain writes on put (list index, --count keys).

import { describe, expect, test } from "bun:test";
import {
  deleteTypeListEntry,
  maintainTypeListIndex,
  patchTypeListIndex,
  readTypeListIndex,
} from "../../src/record-list-index.ts";
import {
  RECORD_LIST_ENTRY_MARKER,
  RECORD_LIST_ENTRY_MIGRATED_RANGE,
  RECORD_LIST_ENTRY_SCHEMA_KEY,
} from "../../src/schemas.ts";
import type { FbrainRecord } from "../../src/record.ts";
import { TOMBSTONE_TAG } from "../../src/record.ts";

const ENTRY_HASH = "entryhash";
const CFG = { schemaHashes: { [RECORD_LIST_ENTRY_SCHEMA_KEY]: ENTRY_HASH } };

function rec(slug: string, extra: Partial<FbrainRecord> = {}): FbrainRecord {
  return {
    slug,
    title: `title ${slug}`,
    body: `body of ${slug}`,
    status: "active",
    tags: [],
    created_at: "2026-08-06T00:00:00Z",
    updated_at: "2026-08-06T00:00:00Z",
    ...extra,
  } as FbrainRecord;
}

function makeNode(initial: Record<string, FbrainRecord>) {
  const rows: Record<string, Record<string, FbrainRecord | null>> = {
    concept: {
      [RECORD_LIST_ENTRY_MIGRATED_RANGE]: null,
      ...Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, v])),
    },
  };
  const deletes: string[] = [];

  return {
    deletes,
    rows,
    node: {
      async queryAll({
        schemaHash,
        filter,
      }: {
        schemaHash: string;
        fields: string[];
        filter?: Record<string, unknown>;
      }) {
        if (schemaHash !== ENTRY_HASH) throw new Error(`unexpected schema ${schemaHash}`);
        const hrk = filter?.HashRangeKey as { hash: string; range: string } | undefined;
        if (hrk) {
          const part = rows[hrk.hash] ?? {};
          if (!Object.prototype.hasOwnProperty.call(part, hrk.range)) return { results: [] };
          const r = part[hrk.range];
          if (hrk.range === RECORD_LIST_ENTRY_MIGRATED_RANGE) {
            return {
              results: [
                {
                  fields: {
                    rle_h: hrk.hash,
                    rle_r: hrk.range,
                    rle_payload: "",
                    rle_marker: RECORD_LIST_ENTRY_MARKER,
                  },
                },
              ],
            };
          }
          if (r === null || r === undefined) return { results: [] };
          return {
            results: [
              {
                fields: {
                  rle_h: hrk.hash,
                  rle_r: hrk.range,
                  rle_payload: JSON.stringify(r),
                  rle_marker: RECORD_LIST_ENTRY_MARKER,
                },
              },
            ],
          };
        }
        const type = String(filter?.HashKey ?? "concept");
        const part = rows[type] ?? {};
        const results = [];
        for (const [range, r] of Object.entries(part)) {
          if (range === RECORD_LIST_ENTRY_MIGRATED_RANGE) {
            results.push({
              fields: {
                rle_h: type,
                rle_r: range,
                rle_payload: "",
                rle_marker: RECORD_LIST_ENTRY_MARKER,
              },
            });
            continue;
          }
          if (r === null) continue;
          results.push({
            fields: {
              rle_h: type,
              rle_r: range,
              rle_payload: JSON.stringify(r),
              rle_marker: RECORD_LIST_ENTRY_MARKER,
            },
          });
        }
        return { results };
      },
      async createRecord() {
        throw new Error("create unexpected");
      },
      async updateRecord() {
        throw new Error("update unexpected");
      },
      async deleteRecord({
        schemaHash,
        keyHash,
        keyRange,
      }: {
        schemaHash: string;
        keyHash: string;
        keyRange?: string;
      }) {
        if (schemaHash !== ENTRY_HASH || !keyRange) return;
        deletes.push(keyRange);
        if (rows[keyHash]) delete rows[keyHash]![keyRange];
      },
    },
  };
}

describe("delete clears the type-list index", () => {
  test("maintainTypeListIndex(null) drops the list row (delete hot path)", async () => {
    const { node, deletes, rows } = makeNode({
      keep: rec("keep"),
      gone: rec("gone"),
    });
    // Red-before: both live rows are listable.
    const before = await readTypeListIndex(node as never, CFG, "concept");
    expect(before?.map((r) => r.slug).sort()).toEqual(["gone", "keep"]);

    const { listIndexFailed } = await maintainTypeListIndex({
      node: node as never,
      cfg: CFG,
      type: "concept",
      record: null,
      slug: "gone",
    });
    expect(listIndexFailed).toBe(false);
    expect(deletes).toContain("gone");

    const after = await readTypeListIndex(node as never, CFG, "concept");
    expect(after?.map((r) => r.slug).sort()).toEqual(["keep"]);
    expect(Object.keys(rows.concept!).filter((k) => k !== RECORD_LIST_ENTRY_MIGRATED_RANGE).sort()).toEqual([
      "keep",
    ]);
  });

  test("tombstoned record also drops the list row (not stored as tombstone snapshot)", async () => {
    const { node } = makeNode({ alpha: rec("alpha") });
    await patchTypeListIndex(
      node as never,
      CFG,
      "concept",
      rec("alpha", { tags: [TOMBSTONE_TAG], title: "(deleted)" }),
      "alpha",
      (r) => r.tags.includes(TOMBSTONE_TAG),
    );
    const after = await readTypeListIndex(node as never, CFG, "concept");
    expect(after).toEqual([]);
  });

  test("delete.ts source calls maintainTypeListIndex (writer guard)", async () => {
    const source = await Bun.file(
      new URL("../../src/commands/delete.ts", import.meta.url),
    ).text();
    expect(source.includes("maintainTypeListIndex")).toBe(true);
  });

  test("double-delete of a missing list row is safe (idempotent)", async () => {
    const { node, deletes } = makeNode({ keep: rec("keep") });
    // First delete of absent slug is a no-op success.
    expect(await deleteTypeListEntry(node as never, CFG, "concept", "already-gone")).toBe(true);
    // Second delete still succeeds.
    expect(await deleteTypeListEntry(node as never, CFG, "concept", "already-gone")).toBe(true);
    expect(deletes).toEqual([]);
    const after = await readTypeListIndex(node as never, CFG, "concept");
    expect(after?.map((r) => r.slug)).toEqual(["keep"]);
  });
});
