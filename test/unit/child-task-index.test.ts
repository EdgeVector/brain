// ChildTaskIndex (HashRange) stores one LIVE task per row, addressed by
// (design_slug, task slug), so a design's children resolve via a keyed
// partition read instead of listing every task and filtering by design_slug
// in the client. Mirrors record-list-entry-hashrange.test.ts's shape for the
// per-type index, one layer up.

import { describe, expect, test } from "bun:test";
import { FbrainError } from "../../src/client.ts";
import {
  censusChildTaskIndex,
  deleteChildTaskEntry,
  maintainChildTaskIndex,
  markChildTaskIndexMigrated,
  patchChildTaskIndex,
  readChildTasksByDesign,
  unmarkChildTaskIndexMigrated,
  upsertChildTaskEntry,
  writeChildTaskIndex,
} from "../../src/child-task-index.ts";
import {
  CHILD_TASK_INDEX_GLOBAL_HASH,
  CHILD_TASK_INDEX_MARKER,
  CHILD_TASK_INDEX_MIGRATED_RANGE,
  CHILD_TASK_INDEX_SCHEMA_KEY,
} from "../../src/schemas.ts";
import { TOMBSTONE_TAG, type FbrainRecord } from "../../src/record.ts";

const ENTRY_HASH = "ctdhash";
const TASK_HASH = "taskhash";
const REGISTERED = {
  schemaHashes: { [CHILD_TASK_INDEX_SCHEMA_KEY]: ENTRY_HASH, task: TASK_HASH },
};
const NOT_REGISTERED = { schemaHashes: {} };

function task(slug: string, designSlug: string, extra: Partial<FbrainRecord> = {}): FbrainRecord {
  return {
    slug,
    title: `title ${slug}`,
    body: `body of ${slug}`,
    status: "open",
    tags: [],
    design_slug: designSlug,
    created_at: "2026-08-08T00:00:00Z",
    updated_at: "2026-08-08T00:00:00Z",
    ...extra,
  } as FbrainRecord;
}

const never = () => {
  throw new Error("unexpected call");
};

type Call = { op: string; keyHash?: string; keyRange?: string; fields?: Record<string, unknown> };

/**
 * `rows` mirrors the server: a map of hash-partition -> range -> stored
 * fields-ish object (or `"MARK"` for the reserved marker row). `migrated`
 * seeds the global completeness marker.
 */
function makeNode(
  opts: {
    rows?: Record<string, Record<string, FbrainRecord>>;
    records?: Record<string, FbrainRecord>;
    migrated?: boolean;
  } = {},
) {
  const rows: Record<string, Record<string, FbrainRecord | "MARK">> = { ...(opts.rows ?? {}) };
  const records: Record<string, FbrainRecord> = { ...(opts.records ?? {}) };
  for (const part of Object.values(rows)) {
    for (const value of Object.values(part)) {
      if (value !== "MARK" && records[value.slug] === undefined) records[value.slug] = value;
    }
  }
  const calls: Call[] = [];
  if (opts.migrated) {
    (rows[CHILD_TASK_INDEX_GLOBAL_HASH] ??= {})[CHILD_TASK_INDEX_MIGRATED_RANGE] = "MARK";
  }

  const entryRow = (h: string, r: string, v: FbrainRecord | "MARK") => ({
    fields: {
      ctd_h: h,
      ctd_r: r,
      ctd_payload: v === "MARK" ? "" : JSON.stringify(v),
      ctd_marker: CHILD_TASK_INDEX_MARKER,
    },
    key: { hash: h, range: r },
  });

  const putRow = (schemaHash: string, fields: Record<string, unknown>, keyHash: string, keyRange?: string) => {
    if (schemaHash !== ENTRY_HASH || !keyRange) return;
    const raw = String(fields.ctd_payload ?? "");
    (rows[keyHash] ??= {})[keyRange] = raw === "" ? "MARK" : JSON.parse(raw);
  };

  return {
    calls,
    rows,
    node: {
      async queryByKey({ schemaHash, keyHash }: { schemaHash: string; keyHash: string }) {
        if (schemaHash !== TASK_HASH) throw new Error(`queryByKey on ${schemaHash}`);
        const record = records[keyHash];
        return record ? { fields: record, key: { hash: keyHash } } : null;
      },
      async queryAll({
        schemaHash,
        filter,
        allowFullScan,
      }: {
        schemaHash: string;
        fields: string[];
        filter?: Record<string, unknown>;
        allowFullScan?: boolean;
      }) {
        if (schemaHash !== ENTRY_HASH) throw new Error(`queryAll on ${schemaHash}`);
        const hrk = filter?.HashRangeKey as { hash: string; range: string } | undefined;
        if (hrk) {
          const part = rows[hrk.hash] ?? {};
          if (!Object.prototype.hasOwnProperty.call(part, hrk.range)) return { results: [] };
          return { results: [entryRow(hrk.hash, hrk.range, part[hrk.range]!)] };
        }
        const hk = filter?.HashKey as string | undefined;
        if (typeof hk === "string") {
          const part = rows[hk] ?? {};
          return { results: Object.entries(part).map(([r, v]) => entryRow(hk, r, v)) };
        }
        if (allowFullScan) {
          const out: ReturnType<typeof entryRow>[] = [];
          for (const [h, part] of Object.entries(rows)) {
            for (const [r, v] of Object.entries(part)) out.push(entryRow(h, r, v));
          }
          return { results: out };
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

describe("readChildTasksByDesign", () => {
  test("schema not registered reads null so the caller falls back", async () => {
    const { node } = makeNode();
    const got = await readChildTasksByDesign(node, NOT_REGISTERED, "design-a");
    expect(got).toBeNull();
  });

  test("registered but unmigrated throws a loud, named repair error — not a silent fallback", async () => {
    const { node } = makeNode({ rows: { "design-a": { t1: task("t1", "design-a") } } });
    await expect(readChildTasksByDesign(node, REGISTERED, "design-a")).rejects.toThrow(FbrainError);
    try {
      await readChildTasksByDesign(node, REGISTERED, "design-a");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FbrainError);
      expect((err as FbrainError).code).toBe("child_task_index_incomplete");
      expect((err as FbrainError).hint).toContain("fbrain reindex --child-task-index");
    }
  });

  test("migrated index returns only the requested design's children", async () => {
    const { node } = makeNode({
      rows: {
        "design-a": { t1: task("t1", "design-a"), t2: task("t2", "design-a") },
        "design-b": { t3: task("t3", "design-b") },
      },
      migrated: true,
    });
    const got = await readChildTasksByDesign(node, REGISTERED, "design-a");
    expect(got?.map((r) => r.slug).sort()).toEqual(["t1", "t2"]);
  });

  test("hydrates the current task by point read instead of serving a stale index payload", async () => {
    const stale = task("t1", "design-a", { title: "old title" });
    const current = task("t1", "design-a", { title: "current title", status: "done" });
    const { node } = makeNode({
      rows: { "design-a": { t1: stale } },
      records: { t1: current },
      migrated: true,
    });
    const got = await readChildTasksByDesign(node, REGISTERED, "design-a");
    expect(got).toEqual([current]);
  });

  test("does not return an old-parent index row after the task was reparented", async () => {
    const { node } = makeNode({
      rows: { "design-a": { t1: task("t1", "design-a") } },
      records: { t1: task("t1", "design-b") },
      migrated: true,
    });
    expect(await readChildTasksByDesign(node, REGISTERED, "design-a")).toEqual([]);
  });

  test("a migrated index with a genuinely childless design reads [], not null", async () => {
    const { node } = makeNode({ rows: {}, migrated: true });
    const got = await readChildTasksByDesign(node, REGISTERED, "design-a");
    expect(got).toEqual([]);
  });

  test("the global marker row is never returned as a task", async () => {
    const { node } = makeNode({ rows: { "design-a": { t1: task("t1", "design-a") } }, migrated: true });
    const got = await readChildTasksByDesign(node, REGISTERED, "design-a");
    expect(got?.map((r) => r.slug)).toEqual(["t1"]);
  });

  test("a tombstoned row in the partition is filtered out defensively", async () => {
    const { node } = makeNode({
      rows: { "design-a": { t1: task("t1", "design-a", { tags: [TOMBSTONE_TAG] }) } },
      migrated: true,
    });
    const got = await readChildTasksByDesign(node, REGISTERED, "design-a");
    expect(got).toEqual([]);
  });
});

describe("patchChildTaskIndex", () => {
  test("create (no previous design) writes exactly one row under the new design", async () => {
    const { node, calls } = makeNode({ migrated: true });
    await patchChildTaskIndex(node, REGISTERED, "t1", task("t1", "design-a"), undefined);
    expect(calls.map((c) => c.op)).toEqual(["create"]);
    expect(calls[0]!.keyHash).toBe("design-a");
    expect(calls[0]!.keyRange).toBe("t1");
  });

  test("create with no design_slug writes nothing", async () => {
    const { node, calls } = makeNode({ migrated: true });
    await patchChildTaskIndex(node, REGISTERED, "t1", task("t1", ""), undefined);
    expect(calls).toEqual([]);
  });

  test("update within the same design updates the row in place (no delete)", async () => {
    const { node, calls, rows } = makeNode({
      rows: { "design-a": { t1: task("t1", "design-a") } },
      migrated: true,
    });
    await patchChildTaskIndex(
      node,
      REGISTERED,
      "t1",
      task("t1", "design-a", { title: "new title" }),
      "design-a",
    );
    expect(calls.map((c) => c.op)).toEqual(["update"]);
    expect(calls[0]!.keyHash).toBe("design-a");
    const payload = rows["design-a"]!.t1 as FbrainRecord;
    expect(payload.title).toBe("new title");
  });

  test("reparent deletes the old design's row and creates one under the new design", async () => {
    const { node, calls, rows } = makeNode({
      rows: { "design-a": { t1: task("t1", "design-a") } },
      migrated: true,
    });
    await patchChildTaskIndex(node, REGISTERED, "t1", task("t1", "design-b"), "design-a");
    expect(calls.map((c) => c.op).sort()).toEqual(["create", "delete"]);
    expect(rows["design-a"]?.t1).toBeUndefined();
    expect((rows["design-b"]?.t1 as FbrainRecord)?.slug).toBe("t1");
  });

  test("clearing design_slug deletes the row and creates nothing", async () => {
    const { node, calls, rows } = makeNode({
      rows: { "design-a": { t1: task("t1", "design-a") } },
      migrated: true,
    });
    await patchChildTaskIndex(node, REGISTERED, "t1", task("t1", ""), "design-a");
    expect(calls.map((c) => c.op)).toEqual(["delete"]);
    expect(rows["design-a"]?.t1).toBeUndefined();
  });

  test("delete (task=null) drops the row under its prior design", async () => {
    const { node, calls, rows } = makeNode({
      rows: { "design-a": { t1: task("t1", "design-a") } },
      migrated: true,
    });
    await patchChildTaskIndex(node, REGISTERED, "t1", null, "design-a");
    expect(calls.map((c) => c.op)).toEqual(["delete"]);
    expect(rows["design-a"]?.t1).toBeUndefined();
  });

  test("no-op entirely when the schema is not registered", async () => {
    const { node, calls } = makeNode();
    await patchChildTaskIndex(node, NOT_REGISTERED, "t1", task("t1", "design-a"), undefined);
    expect(calls).toEqual([]);
  });
});

describe("maintainChildTaskIndex self-heal", () => {
  test("a patch failure does not throw, and clears the global marker", async () => {
    const { node, rows } = makeNode({ migrated: true });
    const failing = {
      ...node,
      updateRecord: never,
      createRecord: async () => {
        throw new Error("node write failed");
      },
    };
    const logged: string[] = [];
    const { childTaskIndexFailed } = await maintainChildTaskIndex({
      node: failing as any,
      cfg: REGISTERED,
      taskSlug: "t1",
      task: task("t1", "design-a"),
      previousDesignSlug: undefined,
      verbose: (m) => logged.push(m),
    });
    expect(childTaskIndexFailed).toBe(true);
    expect(logged.some((m) => m.includes("child-task index patch FAILED"))).toBe(true);
    expect(rows[CHILD_TASK_INDEX_GLOBAL_HASH]?.[CHILD_TASK_INDEX_MIGRATED_RANGE]).toBeUndefined();
  });

  test("a clean patch reports childTaskIndexFailed=false", async () => {
    const { node } = makeNode({ migrated: true });
    const { childTaskIndexFailed } = await maintainChildTaskIndex({
      node,
      cfg: REGISTERED,
      taskSlug: "t1",
      task: task("t1", "design-a"),
      previousDesignSlug: undefined,
    });
    expect(childTaskIndexFailed).toBe(false);
  });
});

describe("bulk rebuild + census", () => {
  test("writeChildTaskIndex writes one row per linked live task and stamps the marker", async () => {
    const { node, rows } = makeNode();
    await writeChildTaskIndex(node, REGISTERED, [
      task("t1", "design-a"),
      task("t2", "design-a"),
      task("t3", "design-b"),
      task("t4", ""), // unlinked — no row
    ]);
    expect(Object.keys(rows["design-a"] ?? {}).sort()).toEqual(["t1", "t2"]);
    expect(Object.keys(rows["design-b"] ?? {})).toEqual(["t3"]);
    expect(rows[CHILD_TASK_INDEX_GLOBAL_HASH]?.[CHILD_TASK_INDEX_MIGRATED_RANGE]).toBe("MARK");
  });

  test("writeChildTaskIndex clears the marker before rebuilding and restores it last", async () => {
    const { node, calls } = makeNode({ migrated: true });
    await writeChildTaskIndex(node, REGISTERED, [task("t1", "design-a")]);
    expect(calls[0]).toMatchObject({
      op: "delete",
      keyHash: CHILD_TASK_INDEX_GLOBAL_HASH,
      keyRange: CHILD_TASK_INDEX_MIGRATED_RANGE,
    });
    expect(calls.at(-1)).toMatchObject({
      op: "create",
      keyHash: CHILD_TASK_INDEX_GLOBAL_HASH,
      keyRange: CHILD_TASK_INDEX_MIGRATED_RANGE,
    });
  });

  test("writeChildTaskIndex drops stale rows not in the live SOT", async () => {
    const { node, rows } = makeNode({
      rows: { "design-a": { t1: task("t1", "design-a"), stale: task("stale", "design-a") } },
    });
    await writeChildTaskIndex(node, REGISTERED, [task("t1", "design-a")]);
    expect(Object.keys(rows["design-a"] ?? {})).toEqual(["t1"]);
  });

  test("writeChildTaskIndex moves a row when a task's design_slug changed since last rebuild", async () => {
    const { node, rows } = makeNode({
      rows: { "design-a": { t1: task("t1", "design-a") } },
    });
    await writeChildTaskIndex(node, REGISTERED, [task("t1", "design-b")]);
    expect(rows["design-a"]?.t1).toBeUndefined();
    expect((rows["design-b"]?.t1 as FbrainRecord)?.slug).toBe("t1");
  });

  test("census reports missing/extra pairs and complete=false", async () => {
    const { node } = makeNode({
      rows: { "design-a": { t1: task("t1", "design-a"), stale: task("stale", "design-a") } },
      migrated: true,
    });
    const census = await censusChildTaskIndex(node, REGISTERED, ["design-a t1", "design-a t2"]);
    expect(census).not.toBeNull();
    expect(census!.indexed).toBe(2);
    expect(census!.sot).toBe(2);
    expect(census!.missingFromIndex).toEqual(["design-a t2"]);
    expect(census!.extraInIndex).toEqual(["design-a stale"]);
    expect(census!.migrated).toBe(true);
    expect(census!.complete).toBe(false);
  });

  test("census is complete when the indexed set equals SOT", async () => {
    const { node } = makeNode({
      rows: { "design-a": { t1: task("t1", "design-a") } },
      migrated: true,
    });
    const census = await censusChildTaskIndex(node, REGISTERED, ["design-a t1"]);
    expect(census!.complete).toBe(true);
  });

  test("census is incomplete without the authoritative marker even when rows match", async () => {
    const { node } = makeNode({
      rows: { "design-a": { t1: task("t1", "design-a") } },
    });
    const census = await censusChildTaskIndex(node, REGISTERED, ["design-a t1"]);
    expect(census!.migrated).toBe(false);
    expect(census!.complete).toBe(false);
  });

  test("census returns null when the schema is not registered", async () => {
    const { node } = makeNode();
    expect(await censusChildTaskIndex(node, NOT_REGISTERED, [])).toBeNull();
  });
});

describe("upsert/delete/mark direct helpers", () => {
  test("upsert and delete report false when the schema is absent", async () => {
    const { node } = makeNode();
    expect(await upsertChildTaskEntry(node, NOT_REGISTERED, "design-a", task("t1", "design-a"))).toBe(
      false,
    );
    expect(await deleteChildTaskEntry(node, NOT_REGISTERED, "design-a", "t1")).toBe(false);
  });

  test("upsert with an empty design slug is a no-op (false)", async () => {
    const { node, calls } = makeNode({ migrated: true });
    expect(await upsertChildTaskEntry(node, REGISTERED, "", task("t1", ""))).toBe(false);
    expect(calls).toEqual([]);
  });

  test("mark then unmark round-trips the global marker", async () => {
    const { node, rows } = makeNode();
    await markChildTaskIndexMigrated(node, REGISTERED);
    expect(rows[CHILD_TASK_INDEX_GLOBAL_HASH]?.[CHILD_TASK_INDEX_MIGRATED_RANGE]).toBe("MARK");
    await unmarkChildTaskIndexMigrated(node, REGISTERED);
    expect(rows[CHILD_TASK_INDEX_GLOBAL_HASH]?.[CHILD_TASK_INDEX_MIGRATED_RANGE]).toBeUndefined();
  });
});
