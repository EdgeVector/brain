import { describe, expect, test } from "bun:test";
import { FbrainError } from "../../src/client.ts";
import {
  censusPapercutStatusIndex,
  maintainPapercutStatusIndex,
  markPapercutStatusIndexMigrated,
  patchPapercutStatusIndex,
  readPapercutsByStatus,
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

  test("failed patch is non-fatal but clears the completeness marker", async () => {
    const { node, rows } = makeNode({ migrated: true });
    const failing = {
      ...node,
      createRecord: async () => {
        throw new Error("write failed");
      },
    };
    const result = await maintainPapercutStatusIndex({
      node: failing as any,
      cfg: REGISTERED,
      slug: "p1",
      record: papercut("p1", "open"),
      previousStatus: undefined,
    });
    expect(result.papercutStatusIndexFailed).toBe(true);
    expect(
      rows[PAPERCUT_STATUS_INDEX_GLOBAL_HASH]?.[
        PAPERCUT_STATUS_INDEX_MIGRATED_RANGE
      ],
    ).toBeUndefined();
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
});
