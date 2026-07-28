// RecordListEntry (HashRange) — the shape that replaces the single-row
// RecordListIndex rollup measured at 446,262 B on the primary 2026-07-28.
//
// The defect being guarded: the legacy rollup holds every record of a type in
// ONE atom and read-modify-writes it in full on every put. Past the atom
// ceiling that does not fail cleanly — the record lands and the index patch is
// rejected (a half-commit). These tests pin the two properties that make that
// impossible: a put writes ONE row, and no product path re-inflates the rollup.

import { describe, expect, test } from "bun:test";
import {
  deleteTypeListEntry,
  patchTypeListIndex,
  readTypeListIndex,
  upsertTypeListEntry,
  writeTypeListIndex,
} from "../../src/record-list-index.ts";
import {
  RECORD_LIST_ENTRY_MARKER,
  RECORD_LIST_ENTRY_MIGRATED_RANGE,
  RECORD_LIST_ENTRY_SCHEMA_KEY,
  RECORD_LIST_INDEX_SCHEMA_KEY,
} from "../../src/schemas.ts";
import type { FbrainRecord } from "../../src/record.ts";

const ENTRY_HASH = "entryhash";
const LEGACY_HASH = "legacyhash";

const MIGRATED = { schemaHashes: { [RECORD_LIST_ENTRY_SCHEMA_KEY]: ENTRY_HASH } };
const LEGACY_ONLY = { schemaHashes: { [RECORD_LIST_INDEX_SCHEMA_KEY]: LEGACY_HASH } };
const BOTH = {
  schemaHashes: {
    [RECORD_LIST_ENTRY_SCHEMA_KEY]: ENTRY_HASH,
    [RECORD_LIST_INDEX_SCHEMA_KEY]: LEGACY_HASH,
  },
};

function rec(slug: string, extra: Partial<FbrainRecord> = {}): FbrainRecord {
  return {
    slug,
    title: `title ${slug}`,
    body: `body of ${slug}`,
    status: "active",
    tags: [],
    created_at: "2026-07-28T00:00:00Z",
    updated_at: "2026-07-28T00:00:00Z",
    ...extra,
  } as FbrainRecord;
}

const never = () => {
  throw new Error("unexpected call");
};

/** Record slugs in a partition, excluding the reserved migrated marker. */
function slugsIn(part: Record<string, unknown> | undefined): string[] {
  return Object.keys(part ?? {})
    .filter((k) => k !== RECORD_LIST_ENTRY_MIGRATED_RANGE)
    .sort();
}

type Call = { op: string; keyHash?: string; keyRange?: string; fields?: Record<string, unknown> };

/**
 * Node double backed by an in-memory HashRange partition map plus an optional
 * legacy rollup payload. Records every mutation so a test can assert the exact
 * write count — the property that matters here.
 */
function makeNode(opts: {
  rows?: Record<string, Record<string, FbrainRecord>>;
  legacy?: Record<string, FbrainRecord[]>;
  /** Types whose partition already carries the migrated marker. */
  migrated?: string[];
} = {}) {
  const rows = opts.rows ?? {};
  const legacy = opts.legacy ?? {};
  const calls: Call[] = [];
  // The marker lives in the same partition as the records, keyed by a reserved
  // range key, so it rides the existing partition read.
  for (const type of opts.migrated ?? []) {
    (rows[type] ??= {})[RECORD_LIST_ENTRY_MIGRATED_RANGE] = null as never;
  }

  const entryRow = (type: string, slug: string, r: FbrainRecord | null) => ({
    fields: {
      rle_h: type,
      rle_r: slug,
      rle_payload: r === null ? "" : JSON.stringify(r),
      rle_marker: RECORD_LIST_ENTRY_MARKER,
    },
  });

  // The marker row carries an empty payload; everything else carries a record.
  const putRow = (
    schemaHash: string,
    fields: Record<string, unknown>,
    keyHash: string,
    keyRange?: string,
  ) => {
    if (schemaHash !== ENTRY_HASH || !keyRange) return;
    const raw = String(fields.rle_payload ?? "");
    (rows[keyHash] ??= {})[keyRange] = raw === "" ? (null as never) : JSON.parse(raw);
  };

  return {
    calls,
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
        if (schemaHash !== ENTRY_HASH) throw new Error(`queryAll on ${schemaHash}`);
        // Point read of one row.
        const hrk = filter?.HashRangeKey as { hash: string; range: string } | undefined;
        if (hrk) {
          const hit = rows[hrk.hash]?.[hrk.range];
          return { results: hit ? [entryRow(hrk.hash, hrk.range, hit)] : [] };
        }
        // Partition read.
        const hk = filter?.HashKey as string | undefined;
        if (typeof hk === "string") {
          const part = rows[hk] ?? {};
          return {
            results: Object.entries(part).map(([slug, r]) => entryRow(hk, slug, r)),
          };
        }
        throw new Error("unkeyed queryAll — would be a full scan");
      },
      async queryByKey({ schemaHash, keyHash }: { schemaHash: string; keyHash: string }) {
        if (schemaHash !== LEGACY_HASH) throw new Error(`queryByKey on ${schemaHash}`);
        const payload = legacy[keyHash];
        if (!payload) return null;
        return { fields: { key: keyHash, payload_json: JSON.stringify(payload) } };
      },
      async createRecord({ schemaHash, fields, keyHash, keyRange }: any) {
        calls.push({ op: "create", keyHash, keyRange, fields });
        putRow(schemaHash, fields, keyHash, keyRange);
      },
      async updateRecord({ schemaHash, fields, keyHash, keyRange }: any) {
        calls.push({ op: "update", keyHash, keyRange, fields });
        putRow(schemaHash, fields, keyHash, keyRange);
      },
      async deleteRecord({ keyHash, keyRange }: any) {
        calls.push({ op: "delete", keyHash, keyRange });
        if (keyRange && rows[keyHash]) delete rows[keyHash][keyRange];
      },
      search: never,
      rawCall: never,
      listLoadedSchemas: never,
    } as any,
  };
}

describe("RecordListEntry HashRange rows", () => {
  test("a put writes exactly ONE row, addressed (type, slug)", async () => {
    const { node, calls } = makeNode({
      rows: { concept: { alpha: rec("alpha"), beta: rec("beta"), gamma: rec("gamma") } },
      migrated: ["concept"],
    });

    await patchTypeListIndex(node, MIGRATED, "concept", rec("beta", { title: "new" }), "beta", () => false);

    const writes = calls.filter((c) => c.op !== "delete");
    expect(writes.length).toBe(1);
    expect(writes[0]!.op).toBe("update");
    expect(writes[0]!.keyHash).toBe("concept");
    expect(writes[0]!.keyRange).toBe("beta");
    // The row carries ONE record, never an array — that is the size bound.
    const payload = JSON.parse(String(writes[0]!.fields!.rle_payload));
    expect(Array.isArray(payload)).toBe(false);
    expect(payload.slug).toBe("beta");
    // Untouched siblings are not rewritten.
    expect(calls.some((c) => c.keyRange === "alpha" || c.keyRange === "gamma")).toBe(false);
  });

  test("a put for an unseen slug creates its row rather than updating", async () => {
    const { node, calls } = makeNode({
      rows: { concept: { alpha: rec("alpha") } },
      migrated: ["concept"],
    });
    await patchTypeListIndex(node, MIGRATED, "concept", rec("delta"), "delta", () => false);
    expect(calls.map((c) => c.op)).toEqual(["create"]);
    expect(calls[0]!.keyRange).toBe("delta");
  });

  test("a delete or tombstone drops exactly that row", async () => {
    const { node, calls, rows } = makeNode({
      rows: { concept: { alpha: rec("alpha"), beta: rec("beta") } },
      migrated: ["concept"],
    });
    await patchTypeListIndex(node, MIGRATED, "concept", null, "alpha", () => false);
    expect(calls.map((c) => c.op)).toEqual(["delete"]);
    expect(slugsIn(rows.concept)).toEqual(["beta"]);
  });

  test("a tombstoned record is removed, not stored", async () => {
    const { node, rows } = makeNode({
      rows: { concept: { alpha: rec("alpha") } },
      migrated: ["concept"],
    });
    await patchTypeListIndex(node, MIGRATED, "concept", rec("alpha"), "alpha", () => true);
    expect(slugsIn(rows.concept)).toEqual([]);
  });

  test("read returns every row in the type partition", async () => {
    const { node } = makeNode({
      rows: { concept: { alpha: rec("alpha"), beta: rec("beta") } },
    });
    const got = await readTypeListIndex(node, MIGRATED, "concept");
    expect(got?.map((r) => r.slug).sort()).toEqual(["alpha", "beta"]);
    // Bodies survive the round trip — BM25 reads them back off this path.
    expect(got?.find((r) => r.slug === "alpha")?.body).toBe("body of alpha");
  });

  test("reads never leak across type partitions", async () => {
    const { node } = makeNode({
      rows: { concept: { alpha: rec("alpha") }, task: { t1: rec("t1") } },
    });
    const got = await readTypeListIndex(node, MIGRATED, "task");
    expect(got?.map((r) => r.slug)).toEqual(["t1"]);
  });
});

describe("legacy rollup interop", () => {
  test("an empty partition dual-reads the legacy rollup", async () => {
    const { node } = makeNode({ rows: {}, legacy: { concept: [rec("old1"), rec("old2")] } });
    const got = await readTypeListIndex(node, BOTH, "concept");
    expect(got?.map((r) => r.slug)).toEqual(["old1", "old2"]);
  });

  // The defect this pins: an earlier cut preferred the partition whenever it
  // was non-empty. Register the schema, put ONE record, and the rest of the
  // type vanished from `brain list` and from the BM25 corpus behind
  // `brain ask` until the migration happened to run. A partition is only
  // authoritative once the migrated marker says legacy has been drained.
  test("an UNMARKED partition unions legacy instead of truncating the type", async () => {
    const { node } = makeNode({
      rows: { concept: { fresh: rec("fresh") } },
      legacy: { concept: [rec("old1"), rec("old2")] },
    });
    const got = await readTypeListIndex(node, BOTH, "concept");
    expect(got?.map((r) => r.slug).sort()).toEqual(["fresh", "old1", "old2"]);
  });

  test("a partition row supersedes the legacy copy of the same slug", async () => {
    const { node } = makeNode({
      rows: { concept: { alpha: rec("alpha", { title: "new title" }) } },
      legacy: { concept: [rec("alpha", { title: "old title" })] },
    });
    const got = await readTypeListIndex(node, BOTH, "concept");
    expect(got?.map((r) => r.slug)).toEqual(["alpha"]);
    expect(got?.[0]!.title).toBe("new title");
  });

  test("a MARKED partition is authoritative and ignores a stale rollup", async () => {
    const { node } = makeNode({
      rows: { concept: { fresh: rec("fresh") } },
      legacy: { concept: [rec("stale")] },
      migrated: ["concept"],
    });
    const got = await readTypeListIndex(node, BOTH, "concept");
    expect(got?.map((r) => r.slug)).toEqual(["fresh"]);
  });

  test("the marker row is never returned as a record", async () => {
    const { node } = makeNode({ rows: { concept: { alpha: rec("alpha") } }, migrated: ["concept"] });
    const got = await readTypeListIndex(node, MIGRATED, "concept");
    expect(got?.map((r) => r.slug)).toEqual(["alpha"]);
  });

  test("a put during the window drains legacy into the partition first", async () => {
    const { node, rows } = makeNode({
      rows: {},
      legacy: { concept: [rec("old1"), rec("old2")] },
    });
    await patchTypeListIndex(node, BOTH, "concept", rec("new"), "new", () => false);
    // Every legacy record now has its own row, plus the record just put.
    expect(Object.keys(rows.concept!).filter((k) => !k.startsWith("__")).sort())
      .toEqual(["new", "old1", "old2"]);
    // And the type reads complete WITHOUT consulting legacy any more.
    const got = await readTypeListIndex(node, MIGRATED, "concept");
    expect(got?.map((r) => r.slug).sort()).toEqual(["new", "old1", "old2"]);
  });

  // The hole union would otherwise open: delete a record that only exists in
  // legacy, and an un-marked union would hand it straight back on next read.
  test("a delete during the window does not resurrect from legacy", async () => {
    const { node } = makeNode({
      rows: {},
      legacy: { concept: [rec("doomed"), rec("keeper")] },
    });
    await patchTypeListIndex(node, BOTH, "concept", null, "doomed", () => false);
    const got = await readTypeListIndex(node, BOTH, "concept");
    expect(got?.map((r) => r.slug)).toEqual(["keeper"]);
  });

  test("a migrated put NEVER writes the legacy rollup back", async () => {
    const { node, calls } = makeNode({
      rows: { concept: { alpha: rec("alpha") } },
      legacy: { concept: [rec("alpha")] },
    });
    await patchTypeListIndex(node, BOTH, "concept", rec("beta"), "beta", () => false);
    // Every mutation carries a range key ⇒ it is a HashRange row, not the rollup.
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.keyRange).toBeTruthy();
  });

  test("no index at all reads null so the caller cold-seeds", async () => {
    const { node } = makeNode();
    const got = await readTypeListIndex(node, { schemaHashes: {} }, "concept");
    expect(got).toBeNull();
  });

  test("a migrated brain with a genuinely empty type reads [] , not null", async () => {
    const { node } = makeNode({ rows: {} });
    const got = await readTypeListIndex(node, MIGRATED, "concept");
    expect(got).toEqual([]);
  });

  test("an un-migrated brain still patches the legacy rollup", async () => {
    const { node, calls } = makeNode({ legacy: { concept: [rec("alpha")] } });
    await patchTypeListIndex(node, LEGACY_ONLY, "concept", rec("beta"), "beta", () => false);
    const write = calls.at(-1)!;
    expect(write.keyRange).toBeUndefined();
    const payload = JSON.parse(String(write.fields!.payload_json));
    expect(payload.map((r: FbrainRecord) => r.slug).sort()).toEqual(["alpha", "beta"]);
  });
});

describe("bulk seed", () => {
  test("seeding a migrated brain writes one row per record", async () => {
    const { node, calls, rows } = makeNode({ rows: {} });
    await writeTypeListIndex(node, MIGRATED, "concept", [rec("a"), rec("b"), rec("c")]);
    const recordWrites = calls.filter((c) => c.keyRange !== RECORD_LIST_ENTRY_MIGRATED_RANGE);
    expect(recordWrites.length).toBe(3);
    for (const c of calls) expect(c.keyHash).toBe("concept");
    expect(slugsIn(rows.concept)).toEqual(["a", "b", "c"]);
    // A complete seed leaves the partition authoritative.
    expect(calls.some((c) => c.keyRange === RECORD_LIST_ENTRY_MIGRATED_RANGE)).toBe(true);
  });

  test("upsert/delete report false when the HashRange schema is absent", async () => {
    const { node } = makeNode();
    expect(await upsertTypeListEntry(node, LEGACY_ONLY, "concept", rec("a"))).toBe(false);
    expect(await deleteTypeListEntry(node, LEGACY_ONLY, "concept", "a")).toBe(false);
  });
});
