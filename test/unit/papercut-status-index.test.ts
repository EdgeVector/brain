import { describe, expect, test } from "bun:test";
import { FbrainError } from "../../src/client.ts";
import {
  censusPapercutStatusIndex,
  ensurePapercutStatusMembership,
  isUnsupportedHashKeysFilter,
  maintainPapercutStatusIndex,
  markPapercutStatusIndexMigrated,
  newPapercutReadStats,
  PAPERCUT_HYDRATE_BATCH_SIZE,
  patchPapercutStatusIndex,
  persistPapercutWithStatusMembership,
  readPapercutSlugsByStatus,
  readPapercutsByStatus,
  recordFromEntryRow,
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
import { TOMBSTONE_TAG, type FbrainRecord } from "../../src/record.ts";

/** Serve one slug's index row with no `psi_payload`, as a pre-payload index would. */
function wipePayload(inner: any, slug: string) {
  return async (args: any) => {
    const res = await inner(args);
    return {
      ...res,
      results: res.results.map((row: any) =>
        row.key?.range === slug
          ? { ...row, fields: { ...row.fields, psi_payload: "" } }
          : row,
      ),
    };
  };
}

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

  test("index-only read returns slug + partition from one keyed read and never hydrates", async () => {
    const rows: Record<string, ReturnType<typeof papercut>> = {};
    for (const slug of ["open-c", "open-a", "open-b"])
      rows[slug] = papercut(slug, "open");
    const { node, calls } = makeNode({
      rows: { open: rows, verified: { "done-one": papercut("done-one", "verified") } },
      migrated: true,
    });
    const got = await readPapercutSlugsByStatus(node, REGISTERED, "open");
    expect(got.map((r) => r.slug).sort()).toEqual(["open-a", "open-b", "open-c"]);
    expect(got.every((r) => r.status === "open")).toBe(true);
    expect(Object.keys(got[0]!).sort()).toEqual(["slug", "status"]);
    const queryCalls = calls.filter((call) => call.op === "query");
    // One partition read for `open`, one point read for the migrated marker,
    // and no HashKeys hydrate batch at all.
    expect(
      queryCalls.filter((call) => Array.isArray((call.filter as any)?.HashKeys)),
    ).toHaveLength(0);
    expect(
      queryCalls
        .filter((call) => (call.filter as any)?.HashKey !== undefined)
        .map((call) => (call.filter as any).HashKey),
    ).toEqual(["open"]);
    expect(calls.some((call) => call.allowFullScan === true)).toBe(false);
  });

  test("index-only read without a status walks the fixed partitions, never a scan", async () => {
    const { node, calls } = makeNode({
      rows: {
        open: { "open-one": papercut("open-one", "open") },
        fixed: { "fixed-one": papercut("fixed-one", "fixed") },
      },
      migrated: true,
    });
    const got = await readPapercutSlugsByStatus(node, REGISTERED);
    expect(got.map((r) => `${r.status} ${r.slug}`).sort()).toEqual([
      "fixed fixed-one",
      "open open-one",
    ]);
    expect(
      calls
        .filter((call) => (call.filter as any)?.HashKey !== undefined)
        .map((call) => (call.filter as any).HashKey),
    ).toEqual([...PAPERCUT_STATUSES]);
    expect(calls.some((call) => call.allowFullScan === true)).toBe(false);
  });

  test("the default read hydrates one partition in HashKeys batches, not a serial point loop", async () => {
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

  test("the default read drops a stale index row whose primary status moved; --fast cannot see it", async () => {
    // The cost of serving from the payload, stated rather than implied. A
    // papercut whose record moved to `fixed` while its index row stayed under
    // `open` carries a payload that ALSO says `open` — it was written when the
    // row was placed. Only a point read of the record can catch that.
    const live = papercut("moved", "fixed");
    const { node } = makeNode({
      rows: { open: { moved: papercut("moved", "open") } },
      records: { moved: live },
      migrated: true,
    });
    expect(await readPapercutsByStatus(node, REGISTERED, "open")).toEqual([]);
    expect(
      (
        await readPapercutsByStatus(node, REGISTERED, "open", { fast: true })
      ).map((r) => r.slug),
    ).toEqual(["moved"]);
  });

  test("--fast serves every row from the index payload and issues zero point reads", async () => {
    const n = 40;
    const openRows: Record<string, ReturnType<typeof papercut>> = {};
    for (let i = 0; i < n; i++) {
      const rec = papercut(`open-${String(i).padStart(2, "0")}`, "open");
      openRows[rec.slug] = rec;
    }
    const { node, calls } = makeNode({
      rows: { open: openRows },
      migrated: true,
    });
    const got = await readPapercutsByStatus(node, REGISTERED, "open", {
      fast: true,
    });
    expect(got.map((r) => r.slug).sort()).toEqual(Object.keys(openRows).sort());
    // Every header field a closure audit reads comes back, not just the slug.
    expect(got[0]).toMatchObject({ component: "brain", title: got[0]!.title });
    expect(
      calls.filter((call) => Array.isArray((call.filter as any)?.HashKeys)),
    ).toHaveLength(0);
    // One partition read, plus the migrated-marker check. Nothing per row.
    expect(calls.filter((call) => call.op === "query")).toHaveLength(2);
  });

  test("--fast point-hydrates only the rows whose payload is unusable", async () => {
    const good = papercut("has-payload", "open");
    const bare = papercut("no-payload", "open");
    const { node, calls } = makeNode({
      rows: { open: { [good.slug]: good, [bare.slug]: bare } },
      migrated: true,
    });
    // An index row written before psi_payload existed: the row is there, the
    // snapshot is not. It must still be served, not silently dropped.
    (node as any).queryAll = wipePayload((node as any).queryAll, bare.slug);
    const got = await readPapercutsByStatus(node, REGISTERED, "open", {
      fast: true,
    });
    expect(got.map((r) => r.slug).sort()).toEqual([
      "has-payload",
      "no-payload",
    ]);
    const hydrateCalls = calls.filter((call) =>
      Array.isArray((call.filter as any)?.HashKeys),
    );
    expect(hydrateCalls).toHaveLength(1);
    expect((hydrateCalls[0]!.filter as any).HashKeys).toEqual(["no-payload"]);
  });

  test("narrow point-reads only the rows whose snapshot already matches", async () => {
    // The defect this closes: `papercut list --status open --severity p0`
    // returned 22 rows and point-read all 2251 open ones. The filter was
    // applied AFTER the whole partition had been hydrated.
    const openRows: Record<string, FbrainRecord> = {};
    for (let i = 0; i < 40; i++) {
      const rec = papercut(`open-${String(i).padStart(2, "0")}`, "open");
      (rec as any).severity = i < 3 ? "p0" : "p2";
      openRows[rec.slug] = rec;
    }
    const { node, calls } = makeNode({ rows: { open: openRows }, migrated: true });
    const stats = newPapercutReadStats();
    const got = await readPapercutsByStatus(node, REGISTERED, "open", {
      narrow: (r) => (r as any).severity === "p0",
      stats,
    });
    expect(got.map((r) => r.slug).sort()).toEqual([
      "open-00",
      "open-01",
      "open-02",
    ]);
    expect(stats).toEqual({ rows: 40, pointReads: 3, narrowedOut: 37 });
    // Every returned record still came from a point read, so `updated_at` and
    // the ordering built on it are exact for the rows actually served.
    const hydrated = calls.filter((call) =>
      Array.isArray((call.filter as any)?.HashKeys),
    );
    expect(hydrated.flatMap((c) => (c.filter as any).HashKeys).sort()).toEqual([
      "open-00",
      "open-01",
      "open-02",
    ]);
  });

  test("narrow never rules out a row whose snapshot it cannot read", async () => {
    // A row written before `psi_payload` existed has no snapshot to judge. It
    // must be point-read and judged on the record, not dropped for being
    // unreadable — dropping it would silently shrink the answer.
    const match = papercut("has-payload", "open");
    (match as any).severity = "p0";
    const bare = papercut("no-payload", "open");
    (bare as any).severity = "p0";
    const { node } = makeNode({
      rows: { open: { [match.slug]: match, [bare.slug]: bare } },
      migrated: true,
    });
    (node as any).queryAll = wipePayload((node as any).queryAll, bare.slug);
    const stats = newPapercutReadStats();
    const got = await readPapercutsByStatus(node, REGISTERED, "open", {
      narrow: (r) => (r as any).severity === "p0",
      stats,
    });
    expect(got.map((r) => r.slug).sort()).toEqual([
      "has-payload",
      "no-payload",
    ]);
    expect(stats.narrowedOut).toBe(0);
    expect(stats.pointReads).toBe(2);
  });

  test("narrow does not defeat the fail-closed status check", async () => {
    // The snapshot says `open` because it was written when the row was placed.
    // Narrowing must not become a second way to serve a row under a status its
    // record no longer carries.
    const live = papercut("moved", "fixed");
    (live as any).severity = "p0";
    const stale = papercut("moved", "open");
    (stale as any).severity = "p0";
    const { node } = makeNode({
      rows: { open: { moved: stale } },
      records: { moved: live },
      migrated: true,
    });
    expect(
      await readPapercutsByStatus(node, REGISTERED, "open", {
        narrow: (r) => (r as any).severity === "p0",
      }),
    ).toEqual([]);
  });

  test("--fast fails closed on a tombstoned payload", async () => {
    const dead = papercut("tombstoned", "open");
    dead.tags = [TOMBSTONE_TAG];
    const { node } = makeNode({
      rows: { open: { [dead.slug]: dead } },
      migrated: true,
    });
    expect(
      await readPapercutsByStatus(node, REGISTERED, "open", { fast: true }),
    ).toEqual([]);
  });
});

describe("recordFromEntryRow", () => {
  const row = (payload: unknown, range = "p1") => ({
    fields: {
      psi_h: "open",
      psi_r: range,
      psi_payload: typeof payload === "string" ? payload : JSON.stringify(payload),
      psi_marker: PAPERCUT_STATUS_INDEX_MARKER,
    },
    key: { hash: "open", range },
  });

  test("parses the record the index row already carries", () => {
    const rec = papercut("p1", "open");
    expect(recordFromEntryRow(row(rec) as any)).toMatchObject(rec);
  });

  test("returns null for an empty, unparseable, or non-object payload", () => {
    expect(recordFromEntryRow(row("") as any)).toBeNull();
    expect(recordFromEntryRow(row("{not json") as any)).toBeNull();
    expect(recordFromEntryRow(row([1, 2]) as any)).toBeNull();
    expect(recordFromEntryRow(row(null) as any)).toBeNull();
  });

  test("returns null when the payload is missing the fields a caller reads", () => {
    expect(recordFromEntryRow(row({ status: "open", tags: [] }) as any)).toBeNull();
    expect(recordFromEntryRow(row({ slug: "p1", tags: [] }) as any)).toBeNull();
    expect(
      recordFromEntryRow(row({ slug: "p1", status: "open" }) as any),
    ).toBeNull();
  });

  test("returns null when the payload names a different slug than its own row", () => {
    // A crossed payload would otherwise serve one papercut's fields under
    // another's key, which no downstream reader could detect.
    expect(
      recordFromEntryRow(row(papercut("other", "open"), "p1") as any),
    ).toBeNull();
  });

  test("returns null for the reserved marker row", () => {
    expect(
      recordFromEntryRow({
        fields: {
          psi_h: PAPERCUT_STATUS_INDEX_GLOBAL_HASH,
          psi_r: PAPERCUT_STATUS_INDEX_MIGRATED_RANGE,
          psi_payload: "",
          psi_marker: PAPERCUT_STATUS_INDEX_MARKER,
        },
        key: {
          hash: PAPERCUT_STATUS_INDEX_GLOBAL_HASH,
          range: PAPERCUT_STATUS_INDEX_MIGRATED_RANGE,
        },
      } as any),
    ).toBeNull();
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
    const census = await censusPapercutStatusIndex(node, REGISTERED, [current]);
    expect(census?.complete).toBe(true);
    expect(census?.stalePayload).toEqual([]);
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

  test("a present row whose payload is stale is refreshed, not skipped", async () => {
    // The row is in the RIGHT partition under the RIGHT slug; only its
    // `psi_payload` snapshot is out of date. The rebuild used to key entirely
    // on the (status, slug) pair and `continue` here, so the one tool that
    // claims to repair this index could not repair payload drift at all.
    const current = papercut("p1", "open");
    current.title = "title after the append";
    current.updated_at = "2026-09-03T22:00:00Z";
    const stale = papercut("p1", "open");
    const { node, rows, calls } = makeNode({
      rows: { open: { p1: stale } },
      records: { p1: current },
      migrated: true,
    });

    await writePapercutStatusIndex(node, REGISTERED, [current]);

    expect(rows.open?.p1).toEqual(current);
    expect(
      calls.filter((call) => call.op === "delete" || call.op === "create"),
    ).toHaveLength(0);
  });

  test("census reports a stale payload and refuses to call the index complete", async () => {
    const current = papercut("p1", "open");
    current.updated_at = "2026-09-03T22:00:00Z";
    const { node } = makeNode({
      rows: { open: { p1: papercut("p1", "open") } },
      records: { p1: current },
      migrated: true,
    });

    const census = await censusPapercutStatusIndex(node, REGISTERED, [current]);

    // Membership is perfect. That is exactly the state the pair-only census
    // called `complete` while every `--fast` reader served the old snapshot.
    expect(census?.missingFromIndex).toEqual([]);
    expect(census?.extraInIndex).toEqual([]);
    expect(census?.stalePayload).toEqual(["open p1"]);
    expect(census?.complete).toBe(false);
  });

  test("census clears once the rebuild has refreshed the stale row", async () => {
    const current = papercut("p1", "open");
    current.updated_at = "2026-09-03T22:00:00Z";
    const { node } = makeNode({
      rows: { open: { p1: papercut("p1", "open") } },
      records: { p1: current },
      migrated: true,
    });

    expect(
      (await censusPapercutStatusIndex(node, REGISTERED, [current]))?.complete,
    ).toBe(false);
    await writePapercutStatusIndex(node, REGISTERED, [current]);
    const after = await censusPapercutStatusIndex(node, REGISTERED, [current]);
    expect(after?.stalePayload).toEqual([]);
    expect(after?.complete).toBe(true);
  });

  test("a row with an unreadable payload is refreshed rather than left in place", async () => {
    const current = papercut("p1", "open");
    const { node, rows } = makeNode({
      rows: { open: { p1: current } },
      records: { p1: current },
      migrated: true,
    });
    node.queryAll = wipePayload(node.queryAll.bind(node), "p1") as any;

    const census = await censusPapercutStatusIndex(node, REGISTERED, [current]);
    expect(census?.stalePayload).toEqual(["open p1"]);

    await writePapercutStatusIndex(node, REGISTERED, [current]);
    expect(rows.open?.p1).toEqual(current);
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
