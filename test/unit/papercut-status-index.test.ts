import { describe, expect, test } from "bun:test";
import { FbrainError } from "../../src/client.ts";
import {
  censusPapercutStatusIndex,
  ensurePapercutStatusMembership,
  isUnsupportedHashKeysFilter,
  maintainPapercutStatusIndex,
  markPapercutStatusIndexMigrated,
  PAPERCUT_HYDRATE_BATCH_SIZE,
  patchPapercutStatusIndex,
  persistPapercutWithStatusMembership,
  readPapercutsByStatus,
  requireCompletePapercutStatusIndex,
  writePapercutStatusIndex,
} from "../../src/papercut-status-index.ts";
import {
  PAPERCUT_STATUSES,
  PAPERCUT_STATUS_INDEX_GLOBAL_HASH,
  PAPERCUT_STATUS_INDEX_MARKER,
  PAPERCUT_STATUS_INDEX_MIGRATED_RANGE,
  PAPERCUT_STATUS_INDEX_SCHEMA_KEY,
} from "../../src/schemas.ts";
import type { FbrainRecord } from "../../src/record.ts";

const ENTRY_HASH = "psihash";
const PAPERCUT_HASH = "papercuthash";
const REGISTERED = {
  schemaHashes: {
    [PAPERCUT_STATUS_INDEX_SCHEMA_KEY]: ENTRY_HASH,
    papercut: PAPERCUT_HASH,
  },
};

function papercut(slug: string, status: string): FbrainRecord {
  return {
    slug,
    title: `title ${slug}`,
    body: `body ${slug}`,
    status,
    tags: [],
    component: "brain",
    created_at: "2026-08-08T00:00:00Z",
    updated_at: "2026-08-08T00:00:00Z",
  } as FbrainRecord;
}

type Stored = FbrainRecord | "MARK";
type Call = {
  op: string;
  keyHash?: string;
  keyRange?: string;
  filter?: unknown;
  allowFullScan?: boolean;
};

function makeNode(
  opts: {
    rows?: Record<string, Record<string, Stored>>;
    records?: Record<string, FbrainRecord>;
    migrated?: boolean;
    /** Thrown by every `HashKeys` query — a node that predates the filter. */
    hashKeysError?: Error;
  } = {},
) {
  const rows: Record<string, Record<string, Stored>> = {};
  for (const [hash, part] of Object.entries(opts.rows ?? {}))
    rows[hash] = { ...part };
  const records = { ...(opts.records ?? {}) };
  for (const part of Object.values(rows)) {
    for (const value of Object.values(part)) {
      if (value !== "MARK" && records[value.slug] === undefined)
        records[value.slug] = value;
    }
  }
  if (opts.migrated) {
    (rows[PAPERCUT_STATUS_INDEX_GLOBAL_HASH] ??= {})[
      PAPERCUT_STATUS_INDEX_MIGRATED_RANGE
    ] = "MARK";
  }
  const calls: Call[] = [];
  const entryRow = (hash: string, range: string, value: Stored) => ({
    fields: {
      psi_h: hash,
      psi_r: range,
      psi_payload: value === "MARK" ? "" : JSON.stringify(value),
      psi_marker: PAPERCUT_STATUS_INDEX_MARKER,
    },
    key: { hash, range },
  });
  const putRow = (
    schemaHash: string,
    fields: Record<string, unknown>,
    keyHash: string,
    keyRange?: string,
  ) => {
    if (schemaHash !== ENTRY_HASH || !keyRange) return;
    const raw = String(fields.psi_payload ?? "");
    (rows[keyHash] ??= {})[keyRange] = raw === "" ? "MARK" : JSON.parse(raw);
  };
  const node = {
    async queryByKey({
      schemaHash,
      keyHash,
    }: {
      schemaHash: string;
      keyHash: string;
    }) {
      if (schemaHash !== PAPERCUT_HASH)
        throw new Error(`queryByKey on ${schemaHash}`);
      const record = records[keyHash];
      return record ? { fields: record, key: { hash: keyHash } } : null;
    },
    async queryAll({ filter, allowFullScan }: any) {
      calls.push({ op: "query", filter, allowFullScan });
      const hashKeys = filter?.HashKeys as string[] | undefined;
      if (Array.isArray(hashKeys)) {
        if (opts.hashKeysError) throw opts.hashKeysError;
        return {
          results: hashKeys.flatMap((slug) => {
            const record = records[slug];
            return record
              ? [{ fields: record, key: { hash: slug, range: null } }]
              : [];
          }),
        };
      }
      const hrk = filter?.HashRangeKey as
        | { hash: string; range: string }
        | undefined;
      if (hrk) {
        const value = rows[hrk.hash]?.[hrk.range];
        return {
          results:
            value === undefined ? [] : [entryRow(hrk.hash, hrk.range, value)],
        };
      }
      const hk = filter?.HashKey as string | undefined;
      if (hk !== undefined) {
        return {
          results: Object.entries(rows[hk] ?? {}).map(([range, value]) =>
            entryRow(hk, range, value),
          ),
        };
      }
      if (allowFullScan) {
        return {
          results: Object.entries(rows).flatMap(([hash, part]) =>
            Object.entries(part).map(([range, value]) =>
              entryRow(hash, range, value),
            ),
          ),
        };
      }
      throw new Error("unkeyed queryAll would be a full scan");
    },
    async createRecord({ schemaHash, fields, keyHash, keyRange }: any) {
      calls.push({ op: "create", keyHash, keyRange });
      putRow(schemaHash, fields, keyHash, keyRange);
    },
    async updateRecord({ schemaHash, fields, keyHash, keyRange }: any) {
      calls.push({ op: "update", keyHash, keyRange });
      putRow(schemaHash, fields, keyHash, keyRange);
    },
    async deleteRecord({ keyHash, keyRange }: any) {
      calls.push({ op: "delete", keyHash, keyRange });
      if (keyRange && rows[keyHash]) delete rows[keyHash][keyRange];
    },
    async mutateBatch(ops: any[]) {
      calls.push({ op: "batch" });
      for (const op of ops) {
        if (op.mutationType === "delete") {
          calls.push({ op: "delete", keyHash: op.keyHash, keyRange: op.keyRange });
          const partition = rows[op.keyHash];
          if (op.keyRange && partition) {
            delete partition[op.keyRange];
          }
        } else {
          calls.push({
            op: op.mutationType,
            keyHash: op.keyHash,
            keyRange: op.keyRange,
          });
          putRow(op.schemaHash, op.fields, op.keyHash, op.keyRange);
        }
      }
      return {
        mutationIds: ops.map((_, index) => `mutation-${index}`),
        count: ops.length,
        backgroundTasksDrained: true,
        convergencePending: false,
      };
    },
  } as any;
  return { node, rows, records, calls };
}

describe("status-keyed papercut reads", () => {
  test("cold or unregistered index fails loudly and names the offline repair", async () => {
    const { node } = makeNode();
    for (const cfg of [
      { schemaHashes: { papercut: PAPERCUT_HASH } },
      REGISTERED,
    ]) {
      try {
        await readPapercutsByStatus(node, cfg, "open");
        throw new Error("expected read to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(FbrainError);
        expect((error as FbrainError).code).toBe(
          "papercut_status_index_incomplete",
        );
        expect((error as FbrainError).hint).toContain(
          "reindex --papercut-status-index",
        );
      }
    }
  });

  test("filtered render reads only its status partition and point-hydrates rows", async () => {
    const open = papercut("open-one", "open");
    const verified = papercut("done-one", "verified");
    const { node, calls } = makeNode({
      rows: {
        open: { [open.slug]: open },
        verified: { [verified.slug]: verified },
      },
      migrated: true,
    });
    const got = await readPapercutsByStatus(node, REGISTERED, "open");
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject(open);
    const partitionReads = calls.filter(
      (call) =>
        call.op === "query" && (call.filter as any)?.HashKey !== undefined,
    );
    expect(partitionReads.map((call) => (call.filter as any).HashKey)).toEqual([
      "open",
    ]);
    expect(calls.some((call) => call.allowFullScan === true)).toBe(false);
  });

  test("unfiltered render concatenates the fixed status partitions, never a scan", async () => {
    const open = papercut("open-one", "open");
    const fixed = papercut("fixed-one", "fixed");
    const { node, calls } = makeNode({
      rows: { open: { [open.slug]: open }, fixed: { [fixed.slug]: fixed } },
      migrated: true,
    });
    expect(
      (await readPapercutsByStatus(node, REGISTERED)).map((r) => r.slug).sort(),
    ).toEqual(["fixed-one", "open-one"]);
    const hashes = calls
      .filter((call) => (call.filter as any)?.HashKey !== undefined)
      .map((call) => (call.filter as any).HashKey);
    expect(hashes).toEqual([...PAPERCUT_STATUSES]);
    expect(calls.some((call) => call.allowFullScan === true)).toBe(false);
  });

  test("filtered render hydrates one partition in HashKeys batches, not a serial point loop", async () => {
    const n = 400;
    const openRows: Record<string, ReturnType<typeof papercut>> = {};
    for (let i = 0; i < n; i++) {
      const rec = papercut(`open-${String(i).padStart(3, "0")}`, "open");
      openRows[rec.slug] = rec;
    }
    const { node, calls } = makeNode({
      rows: { open: openRows },
      migrated: true,
    });
    const started = Date.now();
    const got = await readPapercutsByStatus(node, REGISTERED, "open");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(got).toHaveLength(n);
    const queryCalls = calls.filter((call) => call.op === "query");
    expect(queryCalls.length).toBeLessThanOrEqual(
      Math.ceil(n / PAPERCUT_HYDRATE_BATCH_SIZE) + 2,
    );
    const hashKeysCalls = queryCalls.filter((call) =>
      Array.isArray((call.filter as any)?.HashKeys),
    );
    expect(hashKeysCalls).toHaveLength(Math.ceil(n / PAPERCUT_HYDRATE_BATCH_SIZE));
    expect(
      hashKeysCalls.every(
        (call) =>
          ((call.filter as any).HashKeys as string[]).length <=
          PAPERCUT_HYDRATE_BATCH_SIZE,
      ),
    ).toBe(true);
  });

  test("a node that rejects HashKeys with the live 400 grammar text still hydrates through point reads", async () => {
    // Live primary 0.23.3-1435-g211325fc2, 2026-09-03: `brain papercut list`
    // died on this exact FbrainError for every filter (papercut
    // papercut-brain-papercut-list-http-400-grammar).
    const n = 20;
    const openRows: Record<string, ReturnType<typeof papercut>> = {};
    for (let i = 0; i < n; i++) {
      const rec = papercut(`open-${String(i).padStart(2, "0")}`, "open");
      openRows[rec.slug] = rec;
    }
    const reject = new FbrainError({
      code: "node_http_400",
      message:
        "Node /api/query returned HTTP 400 [a key was present with a value outside its grammar].",
    });
    const { node, calls } = makeNode({
      rows: { open: openRows },
      migrated: true,
      hashKeysError: reject,
    });
    const got = await readPapercutsByStatus(node, REGISTERED, "open");
    expect(got.map((r) => r.slug).sort()).toEqual(
      Object.keys(openRows).sort(),
    );
    const hashKeysCalls = calls.filter(
      (call) => call.op === "query" && Array.isArray((call.filter as any)?.HashKeys),
    );
    expect(hashKeysCalls).toHaveLength(1);
  });

  test("isUnsupportedHashKeysFilter: any HTTP 400 on the hydrate query means point reads; 5xx and timeouts still throw", () => {
    expect(
      isUnsupportedHashKeysFilter(
        new FbrainError({
          code: "node_http_400",
          message: "Node /api/query returned HTTP 400 [a key was present with a value outside its grammar].",
        }),
      ),
    ).toBe(true);
    expect(
      isUnsupportedHashKeysFilter(new Error("unknown filter HashKeys")),
    ).toBe(true);
    expect(
      isUnsupportedHashKeysFilter(
        new FbrainError({ code: "node_http_503", message: "Node /api/query returned HTTP 503: shed." }),
      ),
    ).toBe(false);
    expect(
      isUnsupportedHashKeysFilter(new Error("node did not respond within 30000ms")),
    ).toBe(false);
  });

  test("batched hydrate still drops a stale index row whose primary status moved", async () => {
    const live = papercut("moved", "fixed");
    const { node } = makeNode({
      rows: { open: { moved: papercut("moved", "open") } },
      records: { moved: live },
      migrated: true,
    });
    expect(await readPapercutsByStatus(node, REGISTERED, "open")).toEqual([]);
  });
});

describe("status transition maintenance", () => {
  test("file creates one open row; close moves it to exactly one new partition", async () => {
    const before = papercut("p1", "open");
    const after = papercut("p1", "verified");
    const { node, rows } = makeNode({ migrated: true });
    await patchPapercutStatusIndex(
      node,
      REGISTERED,
      before.slug,
      before,
      undefined,
    );
    expect(rows.open?.p1).toEqual(before);
    await patchPapercutStatusIndex(node, REGISTERED, after.slug, after, "open");
    expect(rows.open?.p1).toBeUndefined();
    expect(rows.verified?.p1).toEqual(after);
    const memberships = Object.values(rows).filter(
      (part) => part.p1 !== undefined,
    );
    expect(memberships).toHaveLength(1);
  });

  test("failed legacy cleanup is fatal and preserves the completeness marker", async () => {
    const { node, rows } = makeNode({ migrated: true });
    const failing = {
      ...node,
      createRecord: async () => {
        throw new Error("write failed");
      },
    };
    await expect(
      maintainPapercutStatusIndex({
        node: failing as any,
        cfg: REGISTERED,
        slug: "p1",
        record: papercut("p1", "open"),
        previousStatus: undefined,
      }),
    ).rejects.toMatchObject({
      code: "papercut_status_index_patch_failed",
    });
    expect(
      rows[PAPERCUT_STATUS_INDEX_GLOBAL_HASH]?.[
        PAPERCUT_STATUS_INDEX_MIGRATED_RANGE
      ],
    ).toBe("MARK");
  });

  test("first-class mutation preflight requires a complete keyed index", async () => {
    const cold = makeNode();
    await expect(
      requireCompletePapercutStatusIndex(cold.node, REGISTERED),
    ).rejects.toMatchObject({ code: "papercut_status_index_incomplete" });
    const ready = makeNode({ migrated: true });
    expect(
      await requireCompletePapercutStatusIndex(ready.node, REGISTERED),
    ).toBe(ENTRY_HASH);
  });

  test("first-class filing is membership-first and repairs a partial retry", async () => {
    const record = papercut("retry-me", "open");
    const { node, rows } = makeNode({ migrated: true });
    let primaryCalls = 0;
    await expect(
      persistPapercutWithStatusMembership({
        node,
        cfg: REGISTERED,
        record,
        persistPrimary: async () => {
          primaryCalls += 1;
          throw new Error("primary unavailable");
        },
      }),
    ).rejects.toThrow("primary unavailable");
    expect(primaryCalls).toBe(1);
    expect(rows.open?.[record.slug]).toEqual(record);

    await persistPapercutWithStatusMembership({
      node,
      cfg: REGISTERED,
      record,
      persistPrimary: async () => {
        primaryCalls += 1;
      },
    });
    expect(primaryCalls).toBe(2);
    expect(rows.open?.[record.slug]).toEqual(record);
    expect(
      Object.values(rows).filter((part) => part[record.slug] !== undefined),
    ).toHaveLength(1);
  });

  test("idempotent repair re-keys lifecycle membership without a scan", async () => {
    const current = papercut("move-me", "verified");
    const { node, rows, calls } = makeNode({
      migrated: true,
      rows: {
        open: { [current.slug]: papercut(current.slug, "open") },
        fixed: { [current.slug]: papercut(current.slug, "fixed") },
      },
    });
    await ensurePapercutStatusMembership(node, REGISTERED, current);
    expect(rows.open?.[current.slug]).toBeUndefined();
    expect(rows.fixed?.[current.slug]).toBeUndefined();
    expect(rows.verified?.[current.slug]).toEqual(current);
    expect(calls.some((call) => call.allowFullScan === true)).toBe(false);
  });
});

describe("offline rebuild", () => {
  test("removes stale/old-status rows, writes SOT, stamps marker, and censuses complete", async () => {
    const current = papercut("p1", "verified");
    const stale = papercut("gone", "open");
    const { node, rows } = makeNode({
      rows: { open: { p1: papercut("p1", "open"), gone: stale } },
      records: { p1: current },
    });
    await writePapercutStatusIndex(node, REGISTERED, [current]);
    expect(rows.open?.p1).toBeUndefined();
    expect(rows.open?.gone).toBeUndefined();
    expect(rows.verified?.p1).toEqual(current);
    expect(
      rows[PAPERCUT_STATUS_INDEX_GLOBAL_HASH]?.[
        PAPERCUT_STATUS_INDEX_MIGRATED_RANGE
      ],
    ).toBe("MARK");
    const census = await censusPapercutStatusIndex(node, REGISTERED, [
      "verified p1",
    ]);
    expect(census?.complete).toBe(true);
  });

  test("marker can be stamped on an empty, complete index", async () => {
    const { node } = makeNode();
    expect(await markPapercutStatusIndexMigrated(node, REGISTERED)).toBe(true);
    expect(
      (await censusPapercutStatusIndex(node, REGISTERED, []))?.complete,
    ).toBe(true);
  });

  test("a complete rebuild is a no-op instead of rewriting every membership", async () => {
    const current = papercut("p1", "verified");
    const { node, calls } = makeNode({
      rows: { verified: { p1: current } },
      records: { p1: current },
      migrated: true,
    });
    await writePapercutStatusIndex(node, REGISTERED, [current]);
    expect(calls.filter((call) => call.op === "batch")).toHaveLength(0);
    expect(
      calls.filter((call) =>
        ["create", "update", "delete"].includes(call.op),
      ),
    ).toHaveLength(0);
  });

  test("a large cold rebuild keeps the marker for the final bounded batch", async () => {
    const records = [
      papercut("p1", "open"),
      papercut("p2", "fixed"),
      papercut("p3", "verified"),
      papercut("p4", "partial"),
    ];
    const { node, rows, calls } = makeNode({
      records: Object.fromEntries(records.map((record) => [record.slug, record])),
    });
    await writePapercutStatusIndex(node, REGISTERED, records, {
      batchSize: 3,
      drainMs: 0,
      retryDelaysMs: [0],
      sleep: async () => {},
    });
    expect(calls.filter((call) => call.op === "batch")).toHaveLength(2);
    expect(rows.open?.p1).toEqual(records[0]);
    expect(rows.fixed?.p2).toEqual(records[1]);
    expect(rows.verified?.p3).toEqual(records[2]);
    expect(rows.partial?.p4).toEqual(records[3]);
    expect(
      rows[PAPERCUT_STATUS_INDEX_GLOBAL_HASH]?.[
        PAPERCUT_STATUS_INDEX_MIGRATED_RANGE
      ],
    ).toBe("MARK");
  });
});

describe("product path contract", () => {
  test("papercut census no longer calls listRecords", async () => {
    const source = await Bun.file(
      new URL("../../src/commands/papercut.ts", import.meta.url),
    ).text();
    const census = source.slice(
      source.indexOf("export async function papercutCensusCmd"),
    );
    expect(census).not.toContain("listRecords(");
    expect(census).toContain("readPapercutsByStatus");
  });

  test("first-class papercut writes use one resident batch", async () => {
    const source = await Bun.file(
      new URL("../../src/commands/papercut.ts", import.meta.url),
    ).text();
    expect(source).toContain("commitResidentWritePlan");
    expect(source).not.toContain("persistPapercutWithStatusMembership({");
    expect(source).not.toContain("maintainTypeListIndex({");
  });
});
