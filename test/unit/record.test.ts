import { describe, expect, test } from "bun:test";

import {
  computeBackoffMs,
  ensureStatus,
  fieldsFor,
  READ_RETRY_ATTEMPTS,
  READ_RETRY_BACKOFF_MS,
  resolveBySlug,
  rowToRecord,
  schemaHashFor,
  TOMBSTONE_TAG,
  withReadRetry,
  type FbrainRecord,
  type ResolvedRecord,
} from "../../src/record.ts";
import { FbrainError, type NodeClient, type QueryResponse } from "../../src/client.ts";
import type { RecordType } from "../../src/schemas.ts";
import { buildTestCfg, TEST_HASHES } from "../util.ts";

const cfg = buildTestCfg({
  schemaHashes: {
    ...TEST_HASHES,
    design: "designhash",
    task: "taskhash",
  },
});

describe("record", () => {
  test("schemaHashFor returns the right hash", () => {
    expect(schemaHashFor("design", cfg)).toBe("designhash");
    expect(schemaHashFor("task", cfg)).toBe("taskhash");
  });

  test("schemaHashFor throws for a missing type", () => {
    const partial = buildTestCfg({
      schemaHashes: { design: "d", task: "t" },
    });
    expect(() => schemaHashFor("concept", partial)).toThrow(FbrainError);
  });

  test("fieldsFor returns design fields", () => {
    const fs = fieldsFor("design");
    expect(fs).toContain("slug");
    expect(fs).toContain("tags");
    expect(fs).not.toContain("design_slug");
  });

  test("fieldsFor returns task fields with design_slug", () => {
    const fs = fieldsFor("task");
    expect(fs).toContain("design_slug");
  });

  test("rowToRecord converts a design row", () => {
    const row = {
      fields: {
        slug: "abc",
        title: "T",
        body: "B",
        status: "draft",
        tags: ["x", "y"],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
      },
      key: { hash: "abc", range: null },
    };
    const r = rowToRecord(row, "design");
    expect(r.slug).toBe("abc");
    expect(r.tags).toEqual(["x", "y"]);
    expect(r.design_slug).toBeUndefined();
  });

  test("rowToRecord converts a task row and reads design_slug", () => {
    const row = {
      fields: {
        slug: "t1",
        title: "Tt",
        body: "Bt",
        status: "open",
        tags: [],
        design_slug: "d1",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      key: { hash: "t1", range: null },
    };
    const r = rowToRecord(row, "task");
    expect(r.design_slug).toBe("d1");
  });

  test("rowToRecord tolerates missing/wrong-typed fields", () => {
    const row = { fields: {}, key: { hash: "x", range: null } };
    const r = rowToRecord(row, "design");
    expect(r.slug).toBe("");
    expect(r.tags).toEqual([]);
  });

  test("rowToRecord falls back to comma-split if tags came back as a string", () => {
    const row = {
      fields: { tags: "a,b,c" },
      key: { hash: "x", range: null },
    };
    const r = rowToRecord(row, "design");
    expect(r.tags).toEqual(["a", "b", "c"]);
  });

  test("rowToRecord drops empty entries from the comma-split fallback", () => {
    // Symmetry with the write path: put.ts's inline-list parser
    // (`tags: [a, , b]`) strips empties via `.filter(s => s.length > 0)` so
    // empty strings never reach the node. The read fallback must mirror
    // that — otherwise a server-side serializer that emits trailing commas,
    // empty-middle commas, or whitespace-only tag strings leaks phantom
    // empty tags into the in-memory record, surfacing as stray `,` separators
    // in `fbrain get` / `fbrain list` output and inflating `tags.length`.
    const cases: Array<[string, string[]]> = [
      ["foo,", ["foo"]],
      ["foo,,bar", ["foo", "bar"]],
      [",", []],
      ["   ", []],
      ["  ,foo, ,bar,", ["foo", "bar"]],
    ];
    for (const [raw, expected] of cases) {
      const r = rowToRecord(
        { fields: { tags: raw }, key: { hash: "x", range: null } },
        "design",
      );
      expect(r.tags).toEqual(expected);
    }
  });

  test("ensureStatus accepts valid status", () => {
    expect(() => ensureStatus("design", "draft")).not.toThrow();
    expect(() => ensureStatus("task", "in_progress")).not.toThrow();
  });

  test("ensureStatus throws FbrainError on invalid", () => {
    expect(() => ensureStatus("design", "in_progress")).toThrow(FbrainError);
    expect(() => ensureStatus("task", "draft")).toThrow(FbrainError);
  });
});

describe("computeBackoffMs", () => {
  // Pin the schedule's contract independently of the retry driver: any future
  // change (linear, exponential, jittered) must keep these properties so
  // callers can reason about total wait without re-reading the impl.
  test("schedule across the default attempt budget is monotonic and capped at the ceiling", () => {
    const schedule = Array.from({ length: READ_RETRY_ATTEMPTS }, (_, i) =>
      computeBackoffMs(i + 1),
    );
    expect(schedule).toHaveLength(5);
    for (let i = 1; i < schedule.length; i++) {
      expect(schedule[i]).toBeGreaterThanOrEqual(schedule[i - 1]!);
    }
    for (const ms of schedule) {
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThanOrEqual(READ_RETRY_BACKOFF_MS);
    }
  });

  test("first attempt has no pre-wait", () => {
    expect(computeBackoffMs(1)).toBe(0);
    expect(computeBackoffMs(0)).toBe(0);
  });

  test("custom ceiling caps every subsequent wait", () => {
    for (let a = 2; a <= 20; a++) {
      expect(computeBackoffMs(a, 17)).toBeLessThanOrEqual(17);
    }
  });

  test("withReadRetry sleeps the schedule and runs exactly maxAttempts on a persistent miss", async () => {
    const sleepCalls: number[] = [];
    let calls = 0;
    const result = await withReadRetry(
      async () => {
        calls++;
        return [] as string[];
      },
      (r) => r.length > 0,
      { sleep: async (ms) => void sleepCalls.push(ms) },
    );
    expect(result).toEqual([]);
    expect(calls).toBe(READ_RETRY_ATTEMPTS);
    // One sleep per retry (attempts 2..N), each matching the schedule for
    // that attempt — so the driver and the pure schedule stay in sync.
    const expected = Array.from({ length: READ_RETRY_ATTEMPTS - 1 }, (_, i) =>
      computeBackoffMs(i + 2),
    );
    expect(sleepCalls).toEqual(expected);
  });
});

describe("withReadRetry", () => {
  test("defaults match scripts/parity-smoketest.sh (5x, 250 ms)", () => {
    expect(READ_RETRY_ATTEMPTS).toBe(5);
    expect(READ_RETRY_BACKOFF_MS).toBe(250);
  });

  test("first-attempt hit returns immediately without sleeping", async () => {
    const sleepCalls: number[] = [];
    let calls = 0;
    const result = await withReadRetry(
      async () => {
        calls++;
        return ["hit"];
      },
      (r) => r.length > 0,
      { sleep: async (ms) => void sleepCalls.push(ms) },
    );
    expect(result).toEqual(["hit"]);
    expect(calls).toBe(1);
    expect(sleepCalls).toEqual([]);
  });

  test("miss → miss → hit: retries the loop and returns the eventual hit", async () => {
    // The exact failure mode the polluted-daemon read flake produces:
    // identical query returns empty for the first attempts and then
    // returns the real row. Helper must surface the hit, not the miss.
    const responses: string[][] = [[], [], ["found"]];
    const sleepCalls: number[] = [];
    let calls = 0;
    const result = await withReadRetry(
      async () => responses[calls++] ?? [],
      (r) => r.length > 0,
      { backoffMs: 7, sleep: async (ms) => void sleepCalls.push(ms) },
    );
    expect(result).toEqual(["found"]);
    expect(calls).toBe(3);
    expect(sleepCalls).toEqual([7, 7]);
  });

  test("all attempts miss: returns the last empty result after exhausting budget", async () => {
    let calls = 0;
    const sleepCalls: number[] = [];
    const result = await withReadRetry(
      async () => {
        calls++;
        return [] as string[];
      },
      (r) => r.length > 0,
      { maxAttempts: 4, backoffMs: 9, sleep: async (ms) => void sleepCalls.push(ms) },
    );
    expect(result).toEqual([]);
    expect(calls).toBe(4);
    expect(sleepCalls).toEqual([9, 9, 9]);
  });

  test("backoffMs=0 still retries but skips the sleep", async () => {
    let calls = 0;
    const sleepCalls: number[] = [];
    const result = await withReadRetry(
      async () => (calls++ === 0 ? [] : ["hit"]),
      (r) => r.length > 0,
      { backoffMs: 0, sleep: async (ms) => void sleepCalls.push(ms) },
    );
    expect(result).toEqual(["hit"]);
    expect(calls).toBe(2);
    expect(sleepCalls).toEqual([]);
  });

  test("HTTP errors propagate — retry is not a catch-all", async () => {
    // The smoketest only retries on a clean empty result. A network-style
    // throw must bubble immediately so callers see the real cause.
    let calls = 0;
    await expect(
      withReadRetry(
        async () => {
          calls++;
          throw new Error("ECONNREFUSED");
        },
        (r: unknown[]) => r.length > 0,
        { backoffMs: 0 },
      ),
    ).rejects.toThrow("ECONNREFUSED");
    expect(calls).toBe(1);
  });
});

// resolveBySlug consolidates the slug-resolution sweep used by `fbrain get`,
// `status`, and `delete`. These tests pin the contract — typed/untyped
// not-found wording, ambiguous error, raw mode tombstone drop, filter
// callback, onAmbiguous side-effect.
describe("resolveBySlug", () => {
  type Row = { fields: Record<string, unknown> };
  // Each entry maps a schemaHash → list of rows the mock node returns for
  // that schema. Order matters: it's preserved as result order.
  type Seed = Record<string, Row[]>;

  function mockNode(seed: Seed): NodeClient {
    return {
      baseUrl: "mock",
      userHash: "uh",
      async autoIdentity() {
        return { provisioned: true, userHash: "uh" };
      },
      async bootstrap() {
        return { userHash: "uh" };
      },
      async requestConsent() {
        return { status: 202, body: { request_id: "r" } };
      },
      async consentStatus() {
        return { status: 200, body: { status: "granted" } };
      },
      async loadSchemas() {
        return { available_schemas_loaded: 0, schemas_loaded_to_db: 0, failed_schemas: [] };
      },
      async createRecord() {},
      async updateRecord() {},
      async deleteRecord() {},
      async queryAll({ schemaHash }): Promise<QueryResponse> {
        const rows = seed[schemaHash] ?? [];
        const results = rows.map((r) => ({
          fields: r.fields,
          key: {
            hash:
              typeof r.fields.slug === "string" ? (r.fields.slug as string) : null,
            range: null,
          },
        }));
        return {
          ok: true,
          results,
          total_count: results.length,
          returned_count: results.length,
        };
      },
      async search() {
        return [];
      },
      async rawCall() {
        return { status: 200, headers: new Headers(), body: "", json: null };
      },
    };
  }

  function row(slug: string, over: Partial<Record<string, unknown>> = {}): Row {
    return {
      fields: {
        slug,
        title: "T",
        body: "B",
        status: "draft",
        tags: [],
        created_at: "2026-05-01T00:00:00Z",
        updated_at: "2026-05-01T00:00:00Z",
        ...over,
      },
    };
  }

  const cfg = buildTestCfg({
    schemaHashes: {
      ...TEST_HASHES,
      design: "designhash",
      task: "taskhash",
    },
  });

  test("untyped not-found uses the default 'No record with slug' wording", async () => {
    const node = mockNode({});
    await expect(
      resolveBySlug({ node, cfg, slug: "ghost" }),
    ).rejects.toMatchObject({
      code: "not_found",
      message: 'No record with slug "ghost".',
    });
  });

  test("typed not-found uses the typed message override when provided", async () => {
    const node = mockNode({});
    await expect(
      resolveBySlug({
        node,
        cfg,
        slug: "ghost",
        type: "design",
        notFoundMessage: { typed: (t, s) => `No ${t}: ${s}` },
      }),
    ).rejects.toMatchObject({
      code: "not_found",
      message: "No design: ghost",
    });
  });

  test("typed not-found falls back to the default when no override is given", async () => {
    const node = mockNode({});
    await expect(
      resolveBySlug({ node, cfg, slug: "ghost", type: "design" }),
    ).rejects.toMatchObject({
      code: "not_found",
      message: 'No record with slug "ghost".',
    });
  });

  test("ambiguous slug across two types throws ambiguous_slug and runs onAmbiguous first", async () => {
    const node = mockNode({
      designhash: [row("dual")],
      taskhash: [row("dual", { status: "open", design_slug: "" })],
    });
    const seen: ResolvedRecord[] = [];
    await expect(
      resolveBySlug({
        node,
        cfg,
        slug: "dual",
        onAmbiguous: (matches) => {
          seen.push(...matches);
        },
      }),
    ).rejects.toMatchObject({
      code: "ambiguous_slug",
    });
    expect(seen.map((m) => m.type).sort()).toEqual(["design", "task"]);
  });

  test(
    "untyped lookup detects ambiguity even when one type's first read flakes",
    async () => {
      // Pre-fix the sweep returned the first attempt's hits as soon as any
      // non-empty result surfaced — but the /api/query top-100 page flake
      // can return [] for a real row on a saturated schema, so when one
      // type's row was caught on attempt 1 and the sibling type's first
      // call flaked, the helper saw a single hit and called it
      // unambiguous. `fbrain get`, `status`, and `delete` (all untyped
      // forms) would then silently operate on one type while the same
      // slug under the other type went unsurfaced. Per-type retries let
      // the flake recover within its own budget so the ambiguity is
      // detected before the helper returns.
      let taskQueryCalls = 0;
      const node: NodeClient = {
        baseUrl: "mock",
        userHash: "uh",
        async autoIdentity() {
          return { provisioned: true, userHash: "uh" };
        },
        async bootstrap() {
          return { userHash: "uh" };
        },
        async requestConsent() {
          return { status: 202, body: { request_id: "r" } };
        },
        async consentStatus() {
          return { status: 200, body: { status: "granted" } };
        },
        async loadSchemas() {
          return {
            available_schemas_loaded: 0,
            schemas_loaded_to_db: 0,
            failed_schemas: [],
          };
        },
        async createRecord() {},
        async updateRecord() {},
        async deleteRecord() {},
        async queryAll({ schemaHash }): Promise<QueryResponse> {
          if (schemaHash === "designhash") {
            return {
              ok: true,
              results: [
                {
                  fields: row("alpha").fields,
                  key: { hash: "alpha", range: null },
                },
              ],
              total_count: 1,
              returned_count: 1,
            };
          }
          if (schemaHash === "taskhash") {
            taskQueryCalls++;
            // First call models the top-100 flake — the row is in the
            // schema but missing from this slice. Retries surface it.
            if (taskQueryCalls === 1) {
              return { ok: true, results: [], total_count: 0, returned_count: 0 };
            }
            return {
              ok: true,
              results: [
                {
                  fields: row("alpha", { status: "open", design_slug: "" }).fields,
                  key: { hash: "alpha", range: null },
                },
              ],
              total_count: 1,
              returned_count: 1,
            };
          }
          return { ok: true, results: [], total_count: 0, returned_count: 0 };
        },
        async search() {
          return [];
        },
        async rawCall() {
          return { status: 200, headers: new Headers(), body: "", json: null };
        },
      };
      const seen: ResolvedRecord[] = [];
      await expect(
        resolveBySlug({
          node,
          cfg,
          slug: "alpha",
          onAmbiguous: (matches) => {
            seen.push(...matches);
          },
        }),
      ).rejects.toMatchObject({ code: "ambiguous_slug" });
      // Confirms the task lookup retried past the flake instead of giving
      // up after the first empty slice.
      expect(taskQueryCalls).toBeGreaterThanOrEqual(2);
      expect(seen.map((m) => m.type).sort()).toEqual(["design", "task"]);
    },
    10_000,
  );

  test("raw mode drops tombstoned rows inside the helper", async () => {
    // findBySlug strips tombstones at the lookup layer; findBySlugRaw does
    // not. In raw mode the helper must still drop them — no current caller
    // wants to see them, and the only raw caller (delete) relies on the
    // helper for that filter.
    const tombstone = row("doomed", { tags: [TOMBSTONE_TAG] });
    const node = mockNode({ designhash: [tombstone] });
    await expect(
      resolveBySlug({ node, cfg, slug: "doomed", type: "design", raw: true }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  test("raw mode applies the caller-supplied filter", async () => {
    // The filter callback is generic: caller decides what's a hit. Here we
    // assert it's invoked for the probed type and respects its return value.
    // Pre-Phase-E this was used by delete.ts to drop rows whose `kind`
    // didn't match the type slot; post-Phase-E each kind owns its own
    // schema so the kind check is no longer needed, but the filter
    // feature itself stays.
    const conceptHash = TEST_HASHES.concept;
    const node = mockNode({ [conceptHash]: [row("k1"), row("k2")] });
    const filtered: string[] = [];
    const result = await resolveBySlug({
      node,
      cfg,
      slug: "k1",
      type: "concept",
      raw: true,
      filter: (r: FbrainRecord, t: RecordType) => {
        filtered.push(`${t}/${r.slug}`);
        return r.slug === "k1";
      },
    });
    expect(result.type).toBe("concept");
    expect(result.record.slug).toBe("k1");
    expect(filtered).toEqual(["concept/k1"]);
  });

  test("single hit returns the ResolvedRecord with type + record", async () => {
    const node = mockNode({ designhash: [row("solo")] });
    const r = await resolveBySlug({ node, cfg, slug: "solo", type: "design" });
    expect(r.type).toBe("design");
    expect(r.record.slug).toBe("solo");
  });
});
