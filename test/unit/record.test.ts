import { describe, expect, test } from "bun:test";

import {
  computeBackoffMs,
  buildRecordFields,
  EMPTY_PAGE_RETRY_ATTEMPTS,
  ensureStatus,
  fieldsFor,
  findBySlug,
  GET_RECORD_TYPE_PRECEDENCE,
  hydrateSchemaBySlug,
  READ_RETRY_ATTEMPTS,
  READ_RETRY_BACKOFF_MS,
  resolveBySlug,
  resolveTypeFilter,
  rowToRecord,
  schemaHashFor,
  TOMBSTONE_TAG,
  updateFieldsFrom,
  VECTOR_INDEX_VERIFY_CONSECUTIVE,
  verifyVectorIndexed,
  withReadRetry,
  type FbrainRecord,
} from "../../src/record.ts";
import {
  FbrainError,
  type NativeIndexHit,
  type NodeClient,
  type QueryResponse,
} from "../../src/client.ts";
import { RECORD_TYPES, type RecordType } from "../../src/schemas.ts";
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

  test("GET_RECORD_TYPE_PRECEDENCE covers RECORD_TYPES exactly", () => {
    expect(new Set(GET_RECORD_TYPE_PRECEDENCE).size).toBe(RECORD_TYPES.length);
    expect([...GET_RECORD_TYPE_PRECEDENCE].sort()).toEqual([...RECORD_TYPES].sort());
  });

  describe("resolveTypeFilter", () => {
    test("no --type selection walks every type; null filter", () => {
      const { typeFilter, activeTypes } = resolveTypeFilter(undefined, cfg);
      expect(typeFilter).toBeNull();
      expect(activeTypes).toEqual(RECORD_TYPES);
    });

    test("explicit --type narrows to the requested types in canonical order", () => {
      const { typeFilter, activeTypes } = resolveTypeFilter(
        ["task", "design"],
        cfg,
      );
      expect(activeTypes).toEqual(["design", "task"]);
      expect(typeFilter).toEqual(new Set(["design", "task"]));
    });

    // The papercut: `fbrain ask/search --type decision,concept` on a config
    // that predates the `decision` schema used to THROW `missing_schema_hash`
    // for the whole query. Now the hash-less type is dropped (and reported via
    // onSkip) so the resolvable types still answer.
    test("drops a requested type with no config hash and reports it via onSkip", () => {
      const oldCfg = buildTestCfg({
        schemaHashes: { ...TEST_HASHES },
      });
      delete oldCfg.schemaHashes.decision;

      const skipped: RecordType[][] = [];
      const { typeFilter, activeTypes } = resolveTypeFilter(
        ["decision", "concept"],
        oldCfg,
        (s) => skipped.push([...s]),
      );

      // `decision` is gone from BOTH the walk list and the resolver filter Set,
      // so no downstream `schemaHashFor("decision")` can throw.
      expect(activeTypes).toEqual(["concept"]);
      expect(typeFilter).toEqual(new Set(["concept"]));
      expect([...(typeFilter ?? [])]).not.toContain("decision");
      expect(skipped).toEqual([["decision"]]);
    });

    test("dedupe query spanning ONLY a misconfigured type yields an empty walk, not a throw", () => {
      const oldCfg = buildTestCfg({ schemaHashes: { ...TEST_HASHES } });
      delete oldCfg.schemaHashes.decision;

      const skipped: RecordType[][] = [];
      const { typeFilter, activeTypes } = resolveTypeFilter(
        ["decision"],
        oldCfg,
        (s) => skipped.push([...s]),
      );

      // Empty (not null) filter: an explicit request that resolved to nothing
      // must not fall back to "all types". The native-hit resolver then keeps
      // zero hits, and the query returns a clean no-match instead of throwing.
      expect(activeTypes).toEqual([]);
      expect(typeFilter).toEqual(new Set());
      expect(skipped).toEqual([["decision"]]);
    });

    test("without cfg, keeps legacy behavior (no config gating, no onSkip)", () => {
      const seen: RecordType[][] = [];
      const { typeFilter, activeTypes } = resolveTypeFilter(
        ["decision", "concept"],
        undefined,
        (s) => seen.push([...s]),
      );
      expect(activeTypes).toEqual(["concept", "decision"]);
      expect(typeFilter).toEqual(new Set(["concept", "decision"]));
      expect(seen).toEqual([]);
    });
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

  test("rowToRecord drops empty entries when tags comes back as an array", () => {
    // Same invariant as the comma-split fallback above — but for the
    // common-case array shape the node actually returns. Pre-fix this branch
    // (`Array.isArray(v)`) returned the server's array verbatim, so an empty
    // string in the array slipped through to `r.tags`. Two consequences:
    //   1. `fbrain get` / `fbrain list` show a stray `,` separator and
    //      `r.tags.length` is inflated past the "real" tag count.
    //   2. The write paths preserve `existing.tags` verbatim on update
    //      (put.ts `tags: tags ?? existing?.tags ?? []`; link.ts/migrate.ts
    //      similarly), so the phantom empty propagates BACK to the node on
    //      the next mutation — empties persist across the record's lifecycle
    //      instead of getting cleaned up.
    // The fix filters on `length > 0` to match the inline-parser contract
    // ("empty strings are non-tags") regardless of which shape the server
    // emits.
    const cases: Array<[unknown[], string[]]> = [
      [["a", "", "b"], ["a", "b"]],
      [[""], []],
      [["", "", ""], []],
      [["foo"], ["foo"]],
      [["a", 0, "b"], ["a", "b"]], // non-strings still dropped (pre-existing)
    ];
    for (const [raw, expected] of cases) {
      const r = rowToRecord(
        { fields: { tags: raw }, key: { hash: "x", range: null } },
        "design",
      );
      expect(r.tags).toEqual(expected);
    }
  });

  describe("record field builders", () => {
    const base: FbrainRecord = {
      slug: "r1",
      title: "Title",
      body: "Body",
      status: "active",
      tags: ["a"],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
      design_slug: "legacy-parent",
      program: "north-star",
      gate_slug: "gate-1",
      decided_by: "Tom",
      decided_on: "2026-01-03",
    };

    test("buildRecordFields includes only fields declared for the record type", () => {
      const design = buildRecordFields("design", base, {
        updated_at: "2026-02-01T00:00:00.000Z",
      });
      expect(design).toEqual({
        slug: "r1",
        title: "Title",
        body: "Body",
        status: "active",
        tags: ["a"],
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-02-01T00:00:00.000Z",
      });
      expect("design_slug" in design).toBe(false);
      expect("program" in design).toBe(false);
    });

    test("updateFieldsFrom preserves task design_slug and decision extras", () => {
      const task = updateFieldsFrom(base, "task", {
        status: "blocked",
        updated_at: "2026-02-01T00:00:00.000Z",
      });
      expect(task.design_slug).toBe("legacy-parent");
      expect(task.status).toBe("blocked");

      const decision = updateFieldsFrom(base, "decision", {
        gate_slug: "gate-2",
        updated_at: "2026-02-01T00:00:00.000Z",
      });
      expect(decision).toMatchObject({
        program: "north-star",
        gate_slug: "gate-2",
        decided_by: "Tom",
        decided_on: "2026-01-03",
      });
      expect("design_slug" in decision).toBe(false);
    });
  });

  test("ensureStatus accepts valid status", () => {
    expect(() => ensureStatus("design", "draft")).not.toThrow();
    expect(() => ensureStatus("task", "in_progress")).not.toThrow();
  });

  test("ensureStatus throws FbrainError on invalid", () => {
    expect(() => ensureStatus("design", "in_progress")).toThrow(FbrainError);
    expect(() => ensureStatus("task", "draft")).toThrow(FbrainError);
  });

  test("ensureStatus tags the throw with code invalid_status (→ usage error, exit 2)", () => {
    // An invalid status enum value is a caller-supplied malformed value, the
    // same class as invalid_slug. The CLI classifier (USAGE_ERROR_CODES in
    // cli.ts) maps `invalid_status` to exit 2; this pins the code so both
    // surfaces that call ensureStatus — `status <slug> <bad>` and `put` with a
    // bad `status:` in frontmatter — stay exit 2 rather than slipping back to
    // the operational exit 1.
    try {
      ensureStatus("task", "not-a-real-status");
      throw new Error("expected ensureStatus to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FbrainError);
      expect((err as FbrainError).code).toBe("invalid_status");
    }
  });
});

describe("USAGE_ERROR_CODES classifies invalid_status", () => {
  // The exit-code contract: a malformed status VALUE the caller supplied is a
  // usage error (exit 2), not an operational failure (exit 1). Pin membership
  // directly so a future edit to the set can't silently drop invalid_status
  // back to exit 1 (the hole closed by card invalid-status-value-exit-2).
  test("invalid_status is a usage error (exit 2)", async () => {
    const { USAGE_ERROR_CODES } = await import("../../src/cli.ts");
    expect(USAGE_ERROR_CODES.has("invalid_status")).toBe(true);
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

// findBySlug is the keyed point-read behind the write existence check (`put`,
// `<type> new`) and the read-context dangling-reference / liveness validators
// (`task new --design`, `fbrain link`, `fbrain get` of a task with a deleted
// parent, stale-hit drop inside `fbrain search`). It is authoritative
// (found-or-not) in ONE query without scanning, so a genuinely-new / dangling
// slug returns absent immediately — no retry budget burned — while an existing
// row is still found. These tests pin that contract via a mock node whose
// `queryAll` fallback is counted (no `queryByKey`, so the keyed path degrades
// to the scan-and-filter it replaced).
describe("findBySlug (keyed point-read: existence + dangling-ref checks)", () => {
  // A node whose queryAll returns each entry of `pages` in turn (last entry
  // repeats once exhausted), counting how many times it was called.
  function seqNode(pages: Array<Array<{ slug: string; tags?: string[] }>>) {
    let calls = 0;
    const node = {
      baseUrl: "mock",
      userHash: "uh",
      async queryAll(): Promise<QueryResponse> {
        const page = pages[Math.min(calls, pages.length - 1)] ?? [];
        calls++;
        const results = page.map((r) => ({
          fields: {
            slug: r.slug,
            title: "T",
            body: "B",
            status: "active",
            tags: r.tags ?? [],
            created_at: "2026-05-01T00:00:00Z",
            updated_at: "2026-05-01T00:00:00Z",
          },
          key: { hash: r.slug, range: null },
        }));
        return {
          ok: true,
          results,
          total_count: results.length,
          returned_count: results.length,
        };
      },
    } as unknown as NodeClient;
    return { node, calls: () => calls };
  }

  test("populated page without the slug → null after ONE query (no retry burn)", async () => {
    const { node, calls } = seqNode([[{ slug: "other-a" }, { slug: "other-b" }]]);
    const r = await findBySlug(node, "concept", "h", "brand-new");
    expect(r).toBeNull();
    // The whole point: a genuinely-new slug resolves in one query.
    expect(calls()).toBe(1);
  });

  test("slug present and live → returns the record on first query", async () => {
    const { node, calls } = seqNode([[{ slug: "mine" }, { slug: "other" }]]);
    const r = await findBySlug(node, "concept", "h", "mine");
    expect(r?.slug).toBe("mine");
    expect(calls()).toBe(1);
  });

  test("slug present but tombstoned → treated as absent", async () => {
    const { node, calls } = seqNode([[{ slug: "gone", tags: [TOMBSTONE_TAG] }]]);
    const r = await findBySlug(node, "concept", "h", "gone");
    expect(r).toBeNull();
    expect(calls()).toBe(1);
  });

  test("empty schema → null after ONE query (keyed point-read, no retry)", async () => {
    // The existence check is a keyed point-read, which is unambiguous: empty
    // means absent. So a fresh-node first-write (empty schema) costs exactly
    // ONE query — the first-write-of-type cliff is gone outright.
    const { node, calls } = seqNode([[]]);
    const r = await findBySlug(node, "concept", "h", "first-ever");
    expect(r).toBeNull();
    expect(calls()).toBe(1);
  });

  test("dangling slug on a populated schema → ONE queryAll (validator path)", async () => {
    // The dangling-reference validators (`task new --design <typo>`,
    // `fbrain link <typo>`, `fbrain get` of a task whose parent was deleted,
    // stale `fbrain search` hit) resolve a missing slug in one query.
    const { node, calls } = seqNode([
      [{ slug: "other-a" }, { slug: "other-b" }, { slug: "other-c" }],
    ]);
    const r = await findBySlug(node, "design", "designhash", "no-such-design");
    expect(r).toBeNull();
    expect(calls()).toBe(1);
  });
});

// hydrateSchemaBySlug is the BATCH hydrate behind `fbrain search`'s
// fragment→record resolution. It fetches a schema's whole page ONCE
// (`queryAll`) into a `Map<slug, record>`, so N search hits on one schema
// resolve from a single fetch instead of N. These tests pin: (1) ONE queryAll
// per call regardless of how many slugs the caller will look up, (2) live rows
// keyed by slug with tombstones dropped (a soft-deleted slug → undefined → the
// search caller's stale skip), and (3) the same EMPTY-page flake tolerance the
// per-hit fast-miss helper had, just hoisted to the schema level.
describe("hydrateSchemaBySlug (batch search hydrate)", () => {
  function seqNode(pages: Array<Array<{ slug: string; tags?: string[] }>>) {
    let calls = 0;
    const node = {
      baseUrl: "mock",
      userHash: "uh",
      async queryAll(): Promise<QueryResponse> {
        const page = pages[Math.min(calls, pages.length - 1)] ?? [];
        calls++;
        const results = page.map((r) => ({
          fields: {
            slug: r.slug,
            title: `T-${r.slug}`,
            body: "B",
            status: "draft",
            tags: r.tags ?? [],
            created_at: "2026-06-05T00:00:00Z",
            updated_at: "2026-06-05T00:00:00Z",
          },
          key: { hash: r.slug, range: null },
        }));
        return { ok: true, results, total_count: results.length, returned_count: results.length };
      },
    } as unknown as NodeClient;
    return { node, calls: () => calls };
  }
  const noSleep = { sleep: async () => {} };

  test("populated page → ONE queryAll, returns every live row keyed by slug", async () => {
    const { node, calls } = seqNode([[{ slug: "a" }, { slug: "b" }, { slug: "c" }]]);
    const map = await hydrateSchemaBySlug(node, "design", "h", noSleep);
    // The whole point: a SINGLE fetch hydrates the entire schema for batch lookup.
    expect(calls()).toBe(1);
    expect(map.size).toBe(3);
    expect(map.get("a")?.slug).toBe("a");
    expect(map.get("b")?.title).toBe("T-b");
    // A slug the caller will look up but the page lacks resolves to undefined
    // (the search caller's "stale hit" skip) — still ONE fetch, no per-slug query.
    expect(map.get("missing")).toBeUndefined();
    expect(calls()).toBe(1);
  });

  test("tombstoned rows are dropped (soft-deleted slug → stale skip downstream)", async () => {
    const { node } = seqNode([[{ slug: "live" }, { slug: "gone", tags: [TOMBSTONE_TAG] }]]);
    const map = await hydrateSchemaBySlug(node, "concept", "h", noSleep);
    expect(map.has("live")).toBe(true);
    // gone is tombstoned → absent from the map, exactly like findBySlug null.
    expect(map.has("gone")).toBe(false);
    expect(map.size).toBe(1);
  });

  test("empty page → retries up to EMPTY_PAGE_RETRY_ATTEMPTS, then empty map", async () => {
    // Same flake tolerance as the per-hit fast-miss helper, hoisted to the
    // schema: an empty /api/query slice on a saturated daemon is ambiguous, so
    // the schema-level fetch retries (capped) before declaring the schema empty.
    const { node, calls } = seqNode([[]]);
    const map = await hydrateSchemaBySlug(node, "design", "h", noSleep);
    expect(map.size).toBe(0);
    expect(calls()).toBe(EMPTY_PAGE_RETRY_ATTEMPTS);
  });

  test("empty → populated rides out a single flake (one extra fetch)", async () => {
    const { node, calls } = seqNode([[], [{ slug: "x" }]]);
    const map = await hydrateSchemaBySlug(node, "task", "h", noSleep);
    expect(map.get("x")?.slug).toBe("x");
    expect(calls()).toBe(2);
  });
});

// resolveBySlug consolidates the slug-resolution sweep used by `fbrain get`,
// `status`, and `delete`. These tests pin the contract — typed/untyped
// not-found wording, ambiguous error, raw mode tombstone drop, filter
// callback.
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
      async health() {
        return { ok: true, uptime_s: 1 };
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
      async listLoadedSchemas() {
        return [];
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

  test("untyped not-found carries a non-null hint pointing at `fbrain list`", async () => {
    const node = mockNode({});
    await expect(
      resolveBySlug({ node, cfg, slug: "ghost" }),
    ).rejects.toMatchObject({
      code: "not_found",
      message: 'No record with slug "ghost".',
      // The whole point of this card: a slug miss is no longer a dead end.
      hint: "Run `fbrain list` to see existing slugs (slugs are case-sensitive).",
      agentHint:
        "Call fbrain_list to see existing slugs (slugs are case-sensitive).",
    });
  });

  test("untyped not-found hints when the input looks like a MEMORY filename stem", async () => {
    const node = mockNode({});
    await expect(
      resolveBySlug({ node, cfg, slug: "project_scheduled_routines_kanban_free" }),
    ).rejects.toMatchObject({
      code: "not_found",
      hint: expect.stringContaining(
        "MEMORY files are not fbrain slugs; read memory/project_scheduled_routines_kanban_free.md instead.",
      ),
      agentHint: expect.stringContaining(
        "MEMORY files are not fbrain slugs; read memory/project_scheduled_routines_kanban_free.md instead.",
      ),
    });
  });

  test("normalized slug fallback resolves underscore input to a hyphenated record", async () => {
    const node = mockNode({
      designhash: [row("a-b-c")],
    });

    await expect(
      resolveBySlug({
        node,
        cfg,
        slug: "a_b_c",
        normalizedSlugFallback: true,
      }),
    ).resolves.toMatchObject({
      type: "design",
      record: { slug: "a-b-c" },
    });
  });

  test("normalized slug fallback resolves hyphen input to an underscored record", async () => {
    const node = mockNode({
      designhash: [row("a_b_c")],
    });

    await expect(
      resolveBySlug({
        node,
        cfg,
        slug: "a-b-c",
        normalizedSlugFallback: true,
      }),
    ).resolves.toMatchObject({
      type: "design",
      record: { slug: "a_b_c" },
    });
  });

  test("normalized slug fallback resolves uppercase caller input to lowercase slug", async () => {
    const node = mockNode({
      designhash: [row("a-b-c")],
    });

    await expect(
      resolveBySlug({
        node,
        cfg,
        slug: "A_B_C",
        normalizedSlugFallback: true,
      }),
    ).resolves.toMatchObject({
      type: "design",
      record: { slug: "a-b-c" },
    });
  });

  test("normalized slug fallback preserves not-found when folded slug is ambiguous", async () => {
    const node = mockNode({
      designhash: [row("a-b-c"), row("a_b_c")],
    });

    await expect(
      resolveBySlug({
        node,
        cfg,
        slug: "A_B_C",
        normalizedSlugFallback: true,
      }),
    ).rejects.toMatchObject({
      code: "not_found",
      message: 'No record with slug "A_B_C".',
    });
  });

  test("typed not-found hint tells you to drop --type, naming the invoking verb", async () => {
    const node = mockNode({});
    // The slug may exist under a different type that `--type` hid — the hint
    // widens the search. The recovery command echoes the verb the caller ran
    // (status/delete), not a hardcoded `get`.
    await expect(
      resolveBySlug({
        node,
        cfg,
        slug: "ghost",
        type: "task",
        recoveryVerb: "status",
      }),
    ).rejects.toMatchObject({
      code: "not_found",
      hint: "No task with that slug. Drop --type to search every type (`fbrain status ghost`), or `fbrain list` to see existing slugs.",
      agentHint:
        "Omit the `type` argument to search all record types, or call fbrain_list to see existing slugs.",
    });
    await expect(
      resolveBySlug({
        node,
        cfg,
        slug: "ghost",
        type: "design",
        recoveryVerb: "delete",
      }),
    ).rejects.toMatchObject({
      code: "not_found",
      hint: "No design with that slug. Drop --type to search every type (`fbrain delete ghost`), or `fbrain list` to see existing slugs.",
    });
    // Verb defaults to `get` when the caller omits recoveryVerb.
    await expect(
      resolveBySlug({ node, cfg, slug: "ghost", type: "design" }),
    ).rejects.toMatchObject({
      code: "not_found",
      hint: "No design with that slug. Drop --type to search every type (`fbrain get ghost`), or `fbrain list` to see existing slugs.",
    });
  });

  test("ambiguous slug across two types throws ambiguous_slug naming both", async () => {
    const node = mockNode({
      designhash: [row("dual")],
      taskhash: [row("dual", { status: "open", design_slug: "" })],
    });
    await expect(
      resolveBySlug({ node, cfg, slug: "dual" }),
    ).rejects.toMatchObject({
      code: "ambiguous_slug",
      message: 'Slug "dual" exists in multiple schemas (design, task). Specify a `type`.',
      // The hint names the exact recovery command (the `--type` flag and a
      // runnable example using one of the matched types) so a new dev doesn't
      // have to hunt that the flag is `--type`.
      hint: "Re-run with --type, e.g. `fbrain get dual --type design`.",
    });
  });

  test("ambiguous slug can resolve through caller-provided type precedence", async () => {
    const node = mockNode({
      [TEST_HASHES.reference]: [row("routine-heartbeats", { status: "active" })],
      [TEST_HASHES.project]: [
        row("routine-heartbeats", { status: "planning" }),
      ],
    });

    await expect(
      resolveBySlug({
        node,
        cfg,
        slug: "routine-heartbeats",
        ambiguousTypePrecedence: ["reference", "project"],
      }),
    ).resolves.toMatchObject({
      type: "reference",
      record: { slug: "routine-heartbeats" },
    });
  });

  test("untyped lookup skips record types absent from older configs", async () => {
    const oldCfg = buildTestCfg({
      schemaHashes: {
        ...TEST_HASHES,
        reference: "referencehash",
        project: "projecthash",
      },
    });
    delete oldCfg.schemaHashes.decision;
    const seen = new Set<string>();
    const node: NodeClient = {
      ...mockNode({
        referencehash: [row("routine-heartbeats", { status: "active" })],
        projecthash: [row("routine-heartbeats", { status: "planning" })],
      }),
      async queryAll(args) {
        seen.add(args.schemaHash);
        return mockNode({
          referencehash: [row("routine-heartbeats", { status: "active" })],
          projecthash: [row("routine-heartbeats", { status: "planning" })],
        }).queryAll(args);
      },
    };

    const found = await resolveBySlug({
      node,
      cfg: oldCfg,
      slug: "routine-heartbeats",
      ambiguousTypePrecedence: ["reference", "project"],
    });

    expect(found.type).toBe("reference");
    expect(seen).not.toContain(TEST_HASHES.decision);
  });

  test("ambiguous-slug hint echoes the invoking verb, defaulting to get", async () => {
    // The recovery command must be runnable as-is for the verb the user
    // actually ran. `status`/`delete` callers pass their own verb so the hint
    // doesn't dead-end on `fbrain get` (which reads instead of updating /
    // silently fails to delete); an omitted verb stays `get` so the throw is
    // well-formed for any future caller.
    const mk = () =>
      mockNode({
        designhash: [row("dup1")],
        taskhash: [row("dup1", { status: "open", design_slug: "" })],
      });

    await expect(
      resolveBySlug({ node: mk(), cfg, slug: "dup1", recoveryVerb: "status" }),
    ).rejects.toMatchObject({
      code: "ambiguous_slug",
      hint: "Re-run with --type, e.g. `fbrain status dup1 --type design`.",
    });

    await expect(
      resolveBySlug({ node: mk(), cfg, slug: "dup1", recoveryVerb: "delete" }),
    ).rejects.toMatchObject({
      code: "ambiguous_slug",
      hint: "Re-run with --type, e.g. `fbrain delete dup1 --type design`.",
    });

    await expect(
      resolveBySlug({ node: mk(), cfg, slug: "dup1", recoveryVerb: "get" }),
    ).rejects.toMatchObject({
      code: "ambiguous_slug",
      hint: "Re-run with --type, e.g. `fbrain get dup1 --type design`.",
    });

    // Omitting the verb keeps the historical `get` example.
    await expect(
      resolveBySlug({ node: mk(), cfg, slug: "dup1" }),
    ).rejects.toMatchObject({
      code: "ambiguous_slug",
      hint: "Re-run with --type, e.g. `fbrain get dup1 --type design`.",
    });
  });

  test(
    "untyped lookup detects a slug present in multiple types",
    async () => {
      // `fbrain get`/`status`/`delete` in their untyped form must error if the
      // slug exists under more than one type. Each type is resolved with a
      // single keyed point-read, so the ambiguity is detected directly (the old
      // per-type flake-ride-out retry is gone — keyed reads don't flake).
      let taskQueryCalls = 0;
      const node: NodeClient = {
        baseUrl: "mock",
        userHash: "uh",
        async autoIdentity() {
          return { provisioned: true, userHash: "uh" };
        },
        async health() {
          return { ok: true, uptime_s: 1 };
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
        async listLoadedSchemas() {
          return [];
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
      await expect(
        resolveBySlug({ node, cfg, slug: "alpha" }),
      ).rejects.toMatchObject({
        code: "ambiguous_slug",
        message: 'Slug "alpha" exists in multiple schemas (design, task). Specify a `type`.',
      });
      // Each type is resolved with a single keyed read — ambiguity is detected
      // without any flake-ride-out retry.
      expect(taskQueryCalls).toBe(1);
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

  // Point-read miss tests mirror the findBySlug ones above: a typo'd slug on a
  // populated schema surfaces "No record" in one query. The per-type retry
  // budget is still spent on an empty page (saturated-daemon flake) so a real
  // row whose schema flakes to 0 is still found.
  describe("point-read miss on populated pages", () => {
    function countingNode(
      perHashPages: Record<string, Array<Array<{ slug: string; tags?: string[] }>>>,
    ): { node: NodeClient; calls: () => Record<string, number> } {
      const callCounts: Record<string, number> = {};
      const node: NodeClient = {
        baseUrl: "mock",
        userHash: "uh",
        async autoIdentity() {
          return { provisioned: true, userHash: "uh" };
        },
        async health() {
          return { ok: true, uptime_s: 1 };
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
        async listLoadedSchemas() {
          return [];
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
          const pages = perHashPages[schemaHash] ?? [[]];
          const idx = Math.min(callCounts[schemaHash] ?? 0, pages.length - 1);
          callCounts[schemaHash] = (callCounts[schemaHash] ?? 0) + 1;
          const page = pages[idx] ?? [];
          const results = page.map((r) => ({
            fields: {
              slug: r.slug,
              title: "T",
              body: "B",
              status: "draft",
              tags: r.tags ?? [],
              created_at: "2026-05-01T00:00:00Z",
              updated_at: "2026-05-01T00:00:00Z",
            },
            key: { hash: r.slug, range: null },
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
      return { node, calls: () => callCounts };
    }
    const noSleep = { sleep: async () => {} };

    test("typed not-found on a populated schema → one query, no retry burn", async () => {
      // The whole point of the read-path fix: `fbrain get <typo>` against a
      // populated schema must error in ~one round-trip, not after the full
      // 5×250 ms budget. Pre-fix the `r !== null` retry predicate was
      // unreachable so each typo'd lookup slept ~1.1 s before "No record".
      const { node, calls } = countingNode({
        designhash: [[{ slug: "other-a" }, { slug: "other-b" }]],
      });
      await expect(
        resolveBySlug({
          node,
          cfg,
          slug: "ghost",
          type: "design",
          retryOptions: noSleep,
        }),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(calls()["designhash"]).toBe(1);
    });

    test("untyped not-found across populated schemas → one query per type", async () => {
      // Same fix at the untyped sweep level — every type's lookup
      // short-circuits on its own populated page. Pre-fix this burned
      // 5 retries × every schema in parallel (~1.1 s wall-clock).
      // The describe-block cfg overrides design+task hashes; concepts and the
      // remaining six MEMO-backed types share TEST_HASHES.concept. Seed every
      // hash that any registered type would query.
      const allHashes = Array.from(
        new Set(RECORD_TYPES.map((t) => cfg.schemaHashes[t]!)),
      );
      const seed: Record<string, Array<Array<{ slug: string }>>> = {};
      for (const h of allHashes) {
        seed[h] = [[{ slug: `existing-in-${h}` }]];
      }
      const { node, calls } = countingNode(seed);
      await expect(
        resolveBySlug({ node, cfg, slug: "nope", retryOptions: noSleep }),
      ).rejects.toMatchObject({ code: "not_found" });
      for (const h of allHashes) {
        expect(calls()[h]).toBe(1);
      }
    });

    test("real row is found in ONE keyed read per type (no flake ride-out needed)", async () => {
      // The lookup is a keyed point-read now, which doesn't have the full-scan
      // empty-result flake the old ride-out rode out (measured 0/180). A real
      // row is surfaced by a single read — no empty→hit retry.
      const { node, calls } = countingNode({
        designhash: [[{ slug: "real" }]],
      });
      const r = await resolveBySlug({
        node,
        cfg,
        slug: "real",
        type: "design",
        retryOptions: noSleep,
      });
      expect(r.type).toBe("design");
      expect(r.record.slug).toBe("real");
      expect(calls()["designhash"]).toBe(1);
    });

    test("untyped not-found across EMPTY schemas → exactly ONE query per type (fresh-node get/delete)", async () => {
      // `fbrain get <slug>` on a fresh node sweeps all type pages — with keyed
      // point-reads every empty type resolves in exactly ONE query (no empty-
      // page retry budget), so a not-found `get`/`delete` costs one keyed read
      // per type instead of the old EMPTY_PAGE_RETRY_ATTEMPTS × types. Pin the
      // per-type count so a future change that reroutes resolveBySlug back
      // through a full-scan retry re-trips the fresh-node cliff.
      const allHashes = Array.from(
        new Set(RECORD_TYPES.map((t) => cfg.schemaHashes[t]!)),
      );
      const seed: Record<string, Array<Array<{ slug: string }>>> = {};
      for (const h of allHashes) seed[h] = [[]];
      const { node, calls } = countingNode(seed);
      await expect(
        resolveBySlug({ node, cfg, slug: "nope-on-fresh-node", retryOptions: noSleep }),
      ).rejects.toMatchObject({ code: "not_found" });
      for (const h of allHashes) {
        expect(calls()[h]).toBe(1);
      }
    });

    test("raw mode: populated page with a tombstoned matching slug → one query, not_found", async () => {
      // Symmetric to the findBySlug tombstone test, but routed through
      // the raw path that delete.ts takes. resolveBySlug must still drop the
      // tombstone post-hoc and short-circuit (the page is populated → no
      // retry burn).
      const { node, calls } = countingNode({
        designhash: [[{ slug: "doomed", tags: [TOMBSTONE_TAG] }]],
      });
      await expect(
        resolveBySlug({
          node,
          cfg,
          slug: "doomed",
          type: "design",
          raw: true,
          retryOptions: noSleep,
        }),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(calls()["designhash"]).toBe(1);
    });
  });
});

// The read-after-write honesty fix: the fold_db native index's post-mutation
// visibility FLICKERS, so a single positive probe is a false positive. These
// pin the consecutive-hit contract directly on `verifyVectorIndexed` — a fake
// node whose `search` returns a scripted per-call hit pattern.
describe("verifyVectorIndexed — consecutive-hit (anti-flicker) contract", () => {
  const noSleep = async (): Promise<void> => {};

  // A NodeClient whose only meaningful method is `search`, scripted by a
  // per-call boolean: true → the probe returns the slug; false → it doesn't.
  // Out-of-range calls return the LAST entry (steady-state after the pattern).
  function flickerNode(
    slug: string,
    pattern: boolean[],
  ): { node: NodeClient; calls: () => number } {
    let n = 0;
    const node = {
      async search(): Promise<NativeIndexHit[]> {
        const hit = pattern[Math.min(n, pattern.length - 1)] ?? false;
        n++;
        if (!hit) return [];
        return [
          {
            schema_name: "s",
            field: "body",
            key_value: { hash: slug, range: null },
            value: "b",
            metadata: { score: 1 },
          },
        ];
      },
    } as unknown as NodeClient;
    return { node, calls: () => n };
  }

  test("default requires 2 consecutive hits", () => {
    expect(VECTOR_INDEX_VERIFY_CONSECUTIVE).toBe(2);
  });

  test("a single transient hit then a miss is NOT visible (the false-positive case)", async () => {
    // miss, HIT, miss, HIT, miss, HIT — never two in a row.
    const { node, calls } = flickerNode("s1", [false, true, false, true, false, true]);
    const visible = await verifyVectorIndexed(node, "sh", "s1", "q", {
      sleep: noSleep,
      maxAttempts: 6,
    });
    expect(visible).toBe(false);
    expect(calls()).toBe(6); // spent the whole budget chasing a streak
  });

  test("two consecutive hits → visible, and stops as soon as the streak is met", async () => {
    // miss, HIT, miss, HIT, HIT — streak reaches 2 on the 5th probe.
    const { node, calls } = flickerNode("s2", [false, true, false, true, true]);
    const visible = await verifyVectorIndexed(node, "sh", "s2", "q", {
      sleep: noSleep,
      maxAttempts: 6,
    });
    expect(visible).toBe(true);
    expect(calls()).toBe(5); // returned the moment the streak closed, didn't burn the 6th
  });

  test("a steadily-visible index confirms in exactly `consecutiveHits` probes", async () => {
    const { node, calls } = flickerNode("s3", [true, true, true, true]);
    const visible = await verifyVectorIndexed(node, "sh", "s3", "q", {
      sleep: noSleep,
      maxAttempts: 6,
    });
    expect(visible).toBe(true);
    expect(calls()).toBe(2); // first probe + one confirming probe (the common warm case)
  });

  // The warm-path latency contract (card fbrain-put-vector-verify-no-warm-sleep):
  // while the hit streak is alive the confirming probe fires immediately — a
  // caught-up index costs ZERO sleeps, so a warm `fbrain put` no longer pays a
  // mandatory 350ms inter-probe wait. Backoff is burned only after a miss.
  test("warm path (index caught up) pays ZERO sleeps", async () => {
    const { node, calls } = flickerNode("s3w", [true, true]);
    const sleeps: number[] = [];
    const visible = await verifyVectorIndexed(node, "sh", "s3w", "q", {
      maxAttempts: 6,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(visible).toBe(true);
    expect(calls()).toBe(2);
    expect(sleeps).toEqual([]); // hit → confirming hit, back-to-back, no backoff
  });

  test("lagging path budget unchanged: a persistent miss sleeps once per retry", async () => {
    const { node, calls } = flickerNode("s3l", [false]);
    const sleeps: number[] = [];
    const visible = await verifyVectorIndexed(node, "sh", "s3l", "q", {
      maxAttempts: 6,
      backoffMs: 7,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(visible).toBe(false);
    expect(calls()).toBe(6);
    // Same budget as before the warm-path fix: one backoff before each of
    // attempts 2..6 (never before the first probe).
    expect(sleeps).toEqual([7, 7, 7, 7, 7]);
  });

  test("a miss re-arms the backoff; a live streak suppresses it", async () => {
    // HIT, miss, HIT, HIT:
    //   probe 1 (hit, streak 1)  → no sleep before it (first attempt)
    //   probe 2 (miss, streak 0) → no sleep before it (streak was alive)
    //   probe 3 (hit, streak 1)  → SLEEPS first (previous probe missed)
    //   probe 4 (hit, streak 2)  → no sleep (streak alive) → visible
    const { node, calls } = flickerNode("s3m", [true, false, true, true]);
    const sleeps: number[] = [];
    const visible = await verifyVectorIndexed(node, "sh", "s3m", "q", {
      maxAttempts: 6,
      backoffMs: 7,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(visible).toBe(true);
    expect(calls()).toBe(4);
    expect(sleeps).toEqual([7]);
  });

  test("consecutiveHits is tunable: 3-in-a-row required", async () => {
    // HIT, HIT, miss, HIT, HIT, HIT — first pair is broken by the miss; the
    // streak of 3 only closes on the final probe.
    const { node } = flickerNode("s4", [true, true, false, true, true, true]);
    const visible = await verifyVectorIndexed(node, "sh", "s4", "q", {
      sleep: noSleep,
      maxAttempts: 6,
      consecutiveHits: 3,
    });
    expect(visible).toBe(true);
  });

  test("a probe that throws counts as a miss and resets the streak (never fails the write)", async () => {
    let n = 0;
    // HIT, throw, HIT, HIT — the throw between the first two hits resets the
    // streak; visibility is only confirmed on the trailing consecutive pair.
    const node = {
      async search(): Promise<NativeIndexHit[]> {
        const i = n++;
        if (i === 1) throw new Error("native index transiently unavailable");
        return [
          {
            schema_name: "s",
            field: "body",
            key_value: { hash: "s5", range: null },
            value: "b",
            metadata: { score: 1 },
          },
        ];
      },
    } as unknown as NodeClient;
    const visible = await verifyVectorIndexed(node, "sh", "s5", "q", {
      sleep: noSleep,
      maxAttempts: 6,
    });
    expect(visible).toBe(true); // recovered into a fresh streak; never threw
  });

  test("an index that never surfaces the slug → not visible, no throw", async () => {
    const { node, calls } = flickerNode("s6", [false]);
    const visible = await verifyVectorIndexed(node, "sh", "s6", "q", {
      sleep: noSleep,
      maxAttempts: 4,
    });
    expect(visible).toBe(false);
    expect(calls()).toBe(4);
  });
});
