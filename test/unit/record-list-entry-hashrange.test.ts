// RecordListEntry (HashRange) stores one fbrain record per row, addressed by
// (record type, slug). These tests pin the size-bound properties: a put writes
// one row, deletes remove one row, and product reads trust only partitions that
// carry the completeness marker written by cold-seed/admin repair.

import { describe, expect, test } from "bun:test";
import {
  censusTypeListIndex,
  deleteTypeListEntry,
  patchTypeListIndex,
  readTypeListIndex,
  unmarkTypePartitionMigrated,
  upsertTypeListEntry,
  writeTypeListIndex,
} from "../../src/record-list-index.ts";
import {
  RECORD_LIST_ENTRY_MARKER,
  RECORD_LIST_ENTRY_MIGRATED_RANGE,
  RECORD_LIST_ENTRY_SCHEMA_KEY,
} from "../../src/schemas.ts";
import type { FbrainRecord } from "../../src/record.ts";

const ENTRY_HASH = "entryhash";
const MIGRATED = { schemaHashes: { [RECORD_LIST_ENTRY_SCHEMA_KEY]: ENTRY_HASH } };
const NO_ENTRY_SCHEMA = { schemaHashes: {} };

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

function makeNode(opts: {
  rows?: Record<string, Record<string, FbrainRecord | null>>;
  /** Types whose partition already carries the migrated marker. */
  migrated?: string[];
} = {}) {
  const rows = opts.rows ?? {};
  const calls: Call[] = [];
  for (const type of opts.migrated ?? []) {
    (rows[type] ??= {})[RECORD_LIST_ENTRY_MIGRATED_RANGE] = null;
  }

  const entryRow = (type: string, slug: string, r: FbrainRecord | null) => ({
    fields: {
      rle_h: type,
      rle_r: slug,
      rle_payload: r === null ? "" : JSON.stringify(r),
      rle_marker: RECORD_LIST_ENTRY_MARKER,
    },
  });

  const putRow = (
    schemaHash: string,
    fields: Record<string, unknown>,
    keyHash: string,
    keyRange?: string,
  ) => {
    if (schemaHash !== ENTRY_HASH || !keyRange) return;
    const raw = String(fields.rle_payload ?? "");
    (rows[keyHash] ??= {})[keyRange] = raw === "" ? null : JSON.parse(raw);
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
        const hrk = filter?.HashRangeKey as { hash: string; range: string } | undefined;
        if (hrk) {
          const part = rows[hrk.hash] ?? {};
          if (!Object.prototype.hasOwnProperty.call(part, hrk.range)) return { results: [] };
          return { results: [entryRow(hrk.hash, hrk.range, part[hrk.range] ?? null)] };
        }
        const hk = filter?.HashKey as string | undefined;
        if (typeof hk === "string") {
          const part = rows[hk] ?? {};
          return {
            results: Object.entries(part).map(([slug, r]) => entryRow(hk, slug, r)),
          };
        }
        throw new Error("unkeyed queryAll would be a full scan");
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
    const payload = JSON.parse(String(writes[0]!.fields!.rle_payload));
    expect(Array.isArray(payload)).toBe(false);
    expect(payload.slug).toBe("beta");
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

  test("a marked partition reads every row for that type", async () => {
    const { node } = makeNode({
      rows: { concept: { alpha: rec("alpha"), beta: rec("beta") } },
      migrated: ["concept"],
    });
    const got = await readTypeListIndex(node, MIGRATED, "concept");
    expect(got?.map((r) => r.slug).sort()).toEqual(["alpha", "beta"]);
    expect(got?.find((r) => r.slug === "alpha")?.body).toBe("body of alpha");
  });

  test("reads never leak across type partitions", async () => {
    const { node } = makeNode({
      rows: { concept: { alpha: rec("alpha") }, task: { t1: rec("t1") } },
      migrated: ["task"],
    });
    const got = await readTypeListIndex(node, MIGRATED, "task");
    expect(got?.map((r) => r.slug)).toEqual(["t1"]);
  });

  test("an empty unmarked partition returns null so the caller cold-seeds", async () => {
    const { node } = makeNode({ rows: {} });
    const got = await readTypeListIndex(node, MIGRATED, "concept");
    expect(got).toBeNull();
  });

  test("a non-empty unmarked partition returns null so the caller cold-seeds", async () => {
    // Partial dual-write residue without the completeness marker must not be
    // trusted — otherwise a failed put that left some rows but cleared the
    // marker (or never stamped it) would under-report forever.
    const { node } = makeNode({ rows: { concept: { fresh: rec("fresh") } } });
    const got = await readTypeListIndex(node, MIGRATED, "concept");
    expect(got).toBeNull();
  });

  test("the marker row is never returned as a record", async () => {
    const { node } = makeNode({ rows: { concept: { alpha: rec("alpha") } }, migrated: ["concept"] });
    const got = await readTypeListIndex(node, MIGRATED, "concept");
    expect(got?.map((r) => r.slug)).toEqual(["alpha"]);
  });

  test("no entry schema reads null so the caller cold-seeds", async () => {
    const { node } = makeNode();
    const got = await readTypeListIndex(node, NO_ENTRY_SCHEMA, "concept");
    expect(got).toBeNull();
  });

  test("a marked brain with a genuinely empty type reads [] , not null", async () => {
    const { node } = makeNode({ rows: {}, migrated: ["concept"] });
    const got = await readTypeListIndex(node, MIGRATED, "concept");
    expect(got).toEqual([]);
  });
});

describe("bulk seed", () => {
  test("seeding writes one row per record and stamps the marker", async () => {
    const { node, calls, rows } = makeNode({ rows: {} });
    await writeTypeListIndex(node, MIGRATED, "concept", [rec("a"), rec("b"), rec("c")]);
    const recordWrites = calls.filter((c) => c.keyRange !== RECORD_LIST_ENTRY_MIGRATED_RANGE);
    expect(recordWrites.length).toBe(3);
    for (const c of calls) expect(c.keyHash).toBe("concept");
    expect(slugsIn(rows.concept)).toEqual(["a", "b", "c"]);
    expect(calls.some((c) => c.keyRange === RECORD_LIST_ENTRY_MIGRATED_RANGE)).toBe(true);
  });

  test("upsert/delete report false when the HashRange schema is absent", async () => {
    const { node } = makeNode();
    expect(await upsertTypeListEntry(node, NO_ENTRY_SCHEMA, "concept", rec("a"))).toBe(false);
    expect(await deleteTypeListEntry(node, NO_ENTRY_SCHEMA, "concept", "a")).toBe(false);
  });
});

describe("list-index completeness self-heal + census", () => {
  test("unmark drops the migrated marker so the next list cold-seeds", async () => {
    const { node, rows } = makeNode({
      rows: { concept: { alpha: rec("alpha") } },
      migrated: ["concept"],
    });
    // Marked (even incomplete) is still trusted by product list until unmark.
    const before = await readTypeListIndex(node, MIGRATED, "concept");
    expect(before?.map((r) => r.slug)).toEqual(["alpha"]);
    expect(Object.prototype.hasOwnProperty.call(rows.concept, RECORD_LIST_ENTRY_MIGRATED_RANGE)).toBe(
      true,
    );

    await unmarkTypePartitionMigrated(node, MIGRATED, "concept");
    expect(Object.prototype.hasOwnProperty.call(rows.concept, RECORD_LIST_ENTRY_MIGRATED_RANGE)).toBe(
      false,
    );
    // Unmarked → null → next product list cold-seeds from SOT (even if residue rows remain).
    const after = await readTypeListIndex(node, MIGRATED, "concept");
    expect(after).toBeNull();
  });

  test("unmark on empty marked partition makes readTypeListIndex return null for cold-seed", async () => {
    const { node } = makeNode({ rows: {}, migrated: ["concept"] });
    expect(await readTypeListIndex(node, MIGRATED, "concept")).toEqual([]);
    await unmarkTypePartitionMigrated(node, MIGRATED, "concept");
    expect(await readTypeListIndex(node, MIGRATED, "concept")).toBeNull();
  });

  test("writeTypeListIndex removes stale extras not in SOT", async () => {
    const { node, rows } = makeNode({
      rows: { concept: { alpha: rec("alpha"), stale: rec("stale") } },
      migrated: ["concept"],
    });
    await writeTypeListIndex(node, MIGRATED, "concept", [rec("alpha"), rec("beta")]);
    expect(slugsIn(rows.concept)).toEqual(["alpha", "beta"]);
    expect(Object.prototype.hasOwnProperty.call(rows.concept, RECORD_LIST_ENTRY_MIGRATED_RANGE)).toBe(
      true,
    );
  });

  test("census reports missing SOT slugs and complete=false", async () => {
    const { node } = makeNode({
      rows: { concept: { alpha: rec("alpha") } },
      migrated: ["concept"],
    });
    const census = await censusTypeListIndex(node, MIGRATED, "concept", [
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(census).not.toBeNull();
    expect(census!.indexed).toBe(1);
    expect(census!.sot).toBe(3);
    expect(census!.missingFromIndex).toEqual(["beta", "gamma"]);
    expect(census!.extraInIndex).toEqual([]);
    expect(census!.migrated).toBe(true);
    expect(census!.complete).toBe(false);
  });

  test("census complete when listed set equals SOT", async () => {
    const { node } = makeNode({
      rows: { concept: { alpha: rec("alpha"), beta: rec("beta") } },
      migrated: ["concept"],
    });
    const census = await censusTypeListIndex(node, MIGRATED, "concept", ["beta", "alpha"]);
    expect(census!.complete).toBe(true);
    expect(census!.missingFromIndex).toEqual([]);
    expect(census!.extraInIndex).toEqual([]);
  });

  test("census flags stale extras still in the partition", async () => {
    const { node } = makeNode({
      rows: { concept: { alpha: rec("alpha"), stale: rec("stale") } },
      migrated: ["concept"],
    });
    const census = await censusTypeListIndex(node, MIGRATED, "concept", ["alpha"]);
    expect(census!.extraInIndex).toEqual(["stale"]);
    expect(census!.complete).toBe(false);
  });
});
