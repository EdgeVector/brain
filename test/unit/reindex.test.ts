// Unit tests for `fbrain reindex` (G3c).
//
// Responsibilities (per docs/phase-7-search-latency-spike.md G3c):
//   1. Iterate every live record across all 8 types (or just the one
//      named via --type).
//   2. Skip tombstoned records — they are NOT reindexed.
//   3. For each live record, fire an update mutation with the record's
//      existing fields, refreshing only `updated_at`. fold_db's
//      mutation pipeline re-runs `index_record` and refreshes the
//      embedding entry in place.
//   4. --dry-run lists what would be reindexed without writing.
//   5. Verbose prints per-record outcome (kept | reindexed |
//      skipped-tombstone).
//
// These tests pin the behavior against a stubbed fetch that mimics
// fold_db's query/mutation surface.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildReindexFields, reindexCmd } from "../../src/commands/reindex.ts";
import { TOMBSTONE_TAG } from "../../src/record.ts";
import type { FbrainRecord } from "../../src/record.ts";
import { buildTestCfg, TEST_HASHES } from "../util.ts";

const cfg = buildTestCfg({
  userHash: "uh",
  schemaHashes: { ...TEST_HASHES },
});

type RowFields = Record<string, unknown>;

function designRow(slug: string, over: Partial<RowFields> = {}): RowFields {
  return {
    slug,
    title: `t-${slug}`,
    body: `body-${slug}`,
    status: "draft",
    tags: [],
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...over,
  };
}

function taskRow(slug: string, over: Partial<RowFields> = {}): RowFields {
  return {
    slug,
    title: `tt-${slug}`,
    body: `tbody-${slug}`,
    status: "open",
    tags: [],
    design_slug: "",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...over,
  };
}

function conceptRow(slug: string, over: Partial<RowFields> = {}): RowFields {
  return {
    slug,
    title: `c-${slug}`,
    body: `cbody-${slug}`,
    status: "active",
    tags: [],
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...over,
  };
}

function preferenceRow(slug: string, over: Partial<RowFields> = {}): RowFields {
  return {
    ...conceptRow(slug),
    status: "active",
    ...over,
  };
}

// Build a fetch stub that serves one query response per schema_hash and
// captures every mutation. Mutation responses are always 200/success.
function stubFetch(opts: {
  queries: Record<string, RowFields[]>;
  onMutation?: (body: {
    schema: string;
    mutation_type: string;
    fields_and_values: Record<string, unknown>;
    key_value: { hash: string; range: null };
  }) => void;
}): { restore: () => void; mutations: unknown[] } {
  const mutations: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.endsWith("/api/query")) {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const rows = opts.queries[body.schema_name] ?? [];
      return new Response(
        JSON.stringify({
          ok: true,
          results: rows.map((fields) => {
            const slug = fields.slug;
            const hash = typeof slug === "string" ? slug : "";
            return { fields, key: { hash, range: null } };
          }),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/api/mutation")) {
      const body = JSON.parse((init?.body as string) ?? "{}");
      mutations.push(body);
      opts.onMutation?.(body);
      return new Response(JSON.stringify({ ok: true, success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { restore: () => { globalThis.fetch = originalFetch; }, mutations };
}

describe("buildReindexFields", () => {
  test("design: preserves user fields, bumps updated_at, omits kind markers", () => {
    const rec: FbrainRecord = {
      slug: "d1",
      title: "T",
      body: "B",
      status: "approved",
      tags: ["a", "b"],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-02-01T00:00:00Z",
    };
    const out = buildReindexFields("design", rec, "2026-05-24T20:00:00Z");
    expect(out).toEqual({
      slug: "d1",
      title: "T",
      body: "B",
      status: "approved",
      tags: ["a", "b"],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-05-24T20:00:00Z",
    });
    // No kind/marker fields on design.
    expect("kind" in out).toBe(false);
    expect("v1_marker_a" in out).toBe(false);
  });

  test("task: includes design_slug, defaults empty when missing", () => {
    const rec: FbrainRecord = {
      slug: "t1",
      title: "T",
      body: "B",
      status: "in_progress",
      tags: [],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-02-01T00:00:00Z",
    };
    const out = buildReindexFields("task", rec, "2026-05-24T20:00:00Z");
    expect(out.design_slug).toBe("");

    const withParent = { ...rec, design_slug: "parent-d" };
    const out2 = buildReindexFields("task", withParent, "2026-05-24T20:00:00Z");
    expect(out2.design_slug).toBe("parent-d");
  });

  test("concept (Phase 6): per-kind schema, no kind/marker fields", () => {
    // Post-Phase-E each Phase 6 kind has its own dedicated 7-field
    // schema. buildReindexFields targets the per-kind canonical, which
    // doesn't carry the legacy `kind` discriminator or v1_marker_*.
    const rec: FbrainRecord = {
      slug: "c1",
      title: "C",
      body: "Body",
      status: "active",
      tags: ["t1"],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-02-01T00:00:00Z",
    };
    const out = buildReindexFields("concept", rec, "2026-05-24T20:00:00Z");
    expect("kind" in out).toBe(false);
    expect("v1_marker_a" in out).toBe(false);
    expect("v1_marker_b" in out).toBe(false);
    expect(out.updated_at).toBe("2026-05-24T20:00:00Z");
  });
});

describe("reindexCmd", () => {
  test("reindexes every live record across all 8 types, skips tombstones", async () => {
    // TEST_HASHES gives each Phase 6 type a distinct synthetic hash;
    // each `--type X` iteration queries via X's hash, so we stash rows
    // per type hash here.
    const { restore, mutations } = stubFetch({
      queries: {
        [TEST_HASHES.design]: [
          designRow("alive-d"),
          designRow("dead-d", {
            tags: [TOMBSTONE_TAG],
            title: "(deleted)",
            body: "",
            status: "archived",
          }),
        ],
        [TEST_HASHES.task]: [taskRow("alive-t")],
        [TEST_HASHES.concept]: [
          conceptRow("alive-c"),
          conceptRow("dead-c", {
            tags: [TOMBSTONE_TAG],
            title: "(deleted)",
            status: "archived",
          }),
        ],
        [TEST_HASHES.preference]: [preferenceRow("alive-p")],
      },
    });
    try {
      const lines: string[] = [];
      const result = await reindexCmd({
        cfg,
        print: (l) => lines.push(l),
      });
      // 2 tombstones (dead-d, dead-c) skipped; everything else reindexed.
      expect(result.skippedTombstone).toBe(2);
      expect(result.reindexed).toBe(4); // alive-d, alive-t, alive-c, alive-p
      expect(result.scanned).toBe(6);
      // Per-type breakdown so a regression that double-counts shows up.
      expect(result.byType.design).toEqual({ reindexed: 1, skippedTombstone: 1 });
      expect(result.byType.task).toEqual({ reindexed: 1, skippedTombstone: 0 });
      expect(result.byType.concept).toEqual({ reindexed: 1, skippedTombstone: 1 });
      expect(result.byType.preference).toEqual({ reindexed: 1, skippedTombstone: 0 });
      // Only update mutations fired — no creates, no deletes.
      for (const m of mutations) {
        expect((m as { mutation_type: string }).mutation_type).toBe("update");
      }
      // 4 live updates fired (one per non-tombstoned record).
      expect(mutations.length).toBe(4);
      expect(lines.join("\n")).toContain("reindexed 4 record(s)");
      expect(lines.join("\n")).toContain("skipped 2 tombstoned");
    } finally {
      restore();
    }
  });

  test("--dry-run: counts but fires no mutations", async () => {
    const { restore, mutations } = stubFetch({
      queries: {
        [TEST_HASHES.design]: [designRow("d1"), designRow("d2")],
        [TEST_HASHES.concept]: [
          conceptRow("c1"),
          conceptRow("c-dead", { tags: [TOMBSTONE_TAG] }),
        ],
      },
    });
    try {
      const lines: string[] = [];
      const result = await reindexCmd({
        cfg,
        dryRun: true,
        print: (l) => lines.push(l),
      });
      expect(mutations.length).toBe(0);
      expect(result.reindexed).toBe(3); // d1, d2, c1
      expect(result.skippedTombstone).toBe(1);
      expect(lines.join("\n")).toContain("dry-run: would reindex 3");
    } finally {
      restore();
    }
  });

  test("--type narrows to a single type", async () => {
    const { restore, mutations } = stubFetch({
      queries: {
        [TEST_HASHES.design]: [designRow("d1")],
        [TEST_HASHES.task]: [taskRow("t1")],
        [TEST_HASHES.concept]: [conceptRow("c1")],
      },
    });
    try {
      const lines: string[] = [];
      const result = await reindexCmd({
        cfg,
        type: "task",
        print: (l) => lines.push(l),
      });
      // Only the task should be touched.
      expect(result.scanned).toBe(1);
      expect(result.reindexed).toBe(1);
      expect(mutations.length).toBe(1);
      expect((mutations[0] as { schema: string }).schema).toBe(
        TEST_HASHES.task,
      );
      expect(lines.join("\n")).toContain("type=task");
    } finally {
      restore();
    }
  });

  test("update payload preserves all fields, refreshes only updated_at", async () => {
    const seeded = designRow("seed", {
      title: "Seeded title",
      body: "Seeded body",
      status: "approved",
      tags: ["a", "b"],
      created_at: "2026-01-15T03:04:05Z",
      updated_at: "2026-02-15T03:04:05Z",
    });
    const { restore, mutations } = stubFetch({
      queries: {
        [TEST_HASHES.design]: [seeded],
      },
    });
    try {
      await reindexCmd({ cfg, type: "design", print: () => {} });
      expect(mutations.length).toBe(1);
      const m = mutations[0] as {
        schema: string;
        mutation_type: string;
        fields_and_values: Record<string, unknown>;
        key_value: { hash: string; range: null };
      };
      expect(m.schema).toBe(TEST_HASHES.design);
      expect(m.mutation_type).toBe("update");
      expect(m.key_value).toEqual({ hash: "seed", range: null });
      expect(m.fields_and_values.slug).toBe("seed");
      expect(m.fields_and_values.title).toBe("Seeded title");
      expect(m.fields_and_values.body).toBe("Seeded body");
      expect(m.fields_and_values.status).toBe("approved");
      expect(m.fields_and_values.tags).toEqual(["a", "b"]);
      expect(m.fields_and_values.created_at).toBe("2026-01-15T03:04:05Z");
      // updated_at must be a refreshed RFC 3339 string, NOT the original.
      const newUpdated = m.fields_and_values.updated_at as string;
      expect(typeof newUpdated).toBe("string");
      expect(newUpdated).not.toBe("2026-02-15T03:04:05Z");
      expect(Number.isFinite(Date.parse(newUpdated))).toBe(true);
    } finally {
      restore();
    }
  });

  test("verbose: emits per-record outcomes including skipped-tombstone", async () => {
    const { restore } = stubFetch({
      queries: {
        [TEST_HASHES.design]: [
          designRow("live"),
          designRow("dead", { tags: [TOMBSTONE_TAG] }),
        ],
      },
    });
    try {
      const verboseLines: string[] = [];
      await reindexCmd({
        cfg,
        type: "design",
        verbose: (m) => verboseLines.push(m),
        print: () => {},
      });
      const joined = verboseLines.join("\n");
      expect(joined).toContain("reindexed design/live");
      expect(joined).toContain("skipped-tombstone design/dead");
    } finally {
      restore();
    }
  });

  test("verbose under --dry-run reports 'kept' for live records", async () => {
    const { restore } = stubFetch({
      queries: {
        [TEST_HASHES.design]: [designRow("kept-one")],
      },
    });
    try {
      const verboseLines: string[] = [];
      await reindexCmd({
        cfg,
        type: "design",
        dryRun: true,
        verbose: (m) => verboseLines.push(m),
        print: () => {},
      });
      expect(verboseLines.join("\n")).toContain("kept design/kept-one");
    } finally {
      restore();
    }
  });

  test("empty store: scanned/reindexed/skipped all 0, no mutations", async () => {
    const { restore, mutations } = stubFetch({ queries: {} });
    try {
      const lines: string[] = [];
      const result = await reindexCmd({ cfg, print: (l) => lines.push(l) });
      expect(result).toMatchObject({
        scanned: 0,
        reindexed: 0,
        skippedTombstone: 0,
      });
      expect(mutations.length).toBe(0);
      expect(lines.join("\n")).toContain("reindexed 0 record(s)");
    } finally {
      restore();
    }
  });
});

describe("reindexCmd --bm25", () => {
  // kill-scan-brain follow-up: this is the explicit OFFLINE pre-warm path
  // for the client-side BM25 cache `ask`/`search` read on every call — the
  // counterpart to the inline (now visibly-noted) rebuild `ask` does on a
  // cold/stale cache. Isolate FBRAIN_CACHE_DIR per test so this suite never
  // touches a real cache directory left on disk.
  let cacheDir: string;
  let savedCacheEnv: string | undefined;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "fbrain-reindex-bm25-test-"));
    savedCacheEnv = process.env.FBRAIN_CACHE_DIR;
    process.env.FBRAIN_CACHE_DIR = cacheDir;
  });

  afterEach(() => {
    if (savedCacheEnv === undefined) delete process.env.FBRAIN_CACHE_DIR;
    else process.env.FBRAIN_CACHE_DIR = savedCacheEnv;
    rmSync(cacheDir, { recursive: true, force: true });
  });

  test("--dry-run reports the intent and issues no query/mutation", async () => {
    const { restore, mutations } = stubFetch({
      queries: { [TEST_HASHES.design]: [designRow("d1")] },
    });
    try {
      const lines: string[] = [];
      const result = await reindexCmd({
        cfg,
        bm25: true,
        dryRun: true,
        print: (l) => lines.push(l),
      });
      expect(lines.join("\n")).toContain("dry-run: --bm25 would rebuild");
      expect(mutations.length).toBe(0);
      expect(result.scanned).toBe(0);
    } finally {
      restore();
    }
  });

  test("cold cache: rebuilds and reports the record count; a second run is already-warm", async () => {
    const { restore, mutations } = stubFetch({
      queries: {
        [TEST_HASHES.design]: [designRow("d1"), designRow("d2")],
        [TEST_HASHES.task]: [taskRow("t1")],
      },
    });
    try {
      const coldLines: string[] = [];
      const cold = await reindexCmd({
        cfg,
        bm25: true,
        print: (l) => coldLines.push(l),
      });
      expect(coldLines.join("\n")).toContain("rebuilt bm25 cache (3 record(s))");
      expect(cold.scanned).toBe(3);
      expect(cold.reindexed).toBe(3);
      // Read-only: no mutation fired, unlike the embedding-refresh mode.
      expect(mutations.length).toBe(0);

      const warmLines: string[] = [];
      const warm = await reindexCmd({
        cfg,
        bm25: true,
        print: (l) => warmLines.push(l),
      });
      expect(warmLines.join("\n")).toContain("bm25 cache already warm (3 record(s))");
      expect(warm.scanned).toBe(3);
    } finally {
      restore();
    }
  });
});
