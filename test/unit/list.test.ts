// Unit tests for `fbrain list`.
//
// The list command's read-flake behavior (added 2026-05-26): when the
// caller passes --status or --tag, the per-type sweep is wrapped in
// withReadRetry so a status/tag write immediately followed by a filtered
// list rides out the polluted-daemon flake (docs/phase-7-search-latency
// -spike.md). The retry stops as soon as the sweep surfaces any
// non-tombstoned row — the user filter is applied after, so a sweep that
// returns a row that doesn't match the filter still terminates retry.
//
// When no --status/--tag is set, empty is a legitimate signal and we
// skip retry entirely so unfiltered empty lists don't burn the budget.

import { describe, expect, test } from "bun:test";

import { listCmd } from "../../src/commands/list.ts";
import { TOMBSTONE_TAG } from "../../src/record.ts";
import { tagIndexSlug } from "../../src/tag-index.ts";
import {
  buildTestCfg,
  RECORD_TYPES,
  TEST_HASHES,
  TEST_TAG_INDEX_HASH,
} from "../util.ts";

const cfg = buildTestCfg({
  userHash: "uh",
  schemaHashes: { ...TEST_HASHES },
});

type Fields = Record<string, unknown>;

function spikeRow(slug: string, over: Partial<Fields> = {}): Fields {
  return {
    slug,
    title: `T ${slug}`,
    body: "B",
    status: "exploring",
    tags: [],
    kind: "spike",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-26T00:00:00Z",
    ...over,
  };
}

// Stub `globalThis.fetch` so listCmd's per-type sweep sees the rows the
// test wants. `responsesBySchema[hash]` is the queue of result arrays
// returned for successive /api/query calls against that schema. Anything
// not enqueued returns []. Non-query endpoints (autoIdentity, bootstrap)
// get harmless OKs.
//
// Replay-last semantics: once the queue is down to its LAST entry, further
// calls keep re-serving that same entry rather than falling off the end to
// `[]`. This matters since the keys-first list path (this card) issues MORE
// `/api/query` calls per schema than the old full-body sweep did — one for
// the key-only listing, then one bounded point-get per row in the final
// page (`findBySlug` → `queryByKey`, which ALSO posts to `/api/query`, just
// with a `filter: {HashKey}` the stub ignores). Every point-get after the
// first call re-reads the same underlying row set the key sweep saw, and
// the SDK's own `findQueryRowByKey` picks the exact match out of it — so a
// test only needs to enqueue the full row set once (as before); it does not
// need to know how many extra point-get round trips the fix now makes.
function stubFetch(
  responsesBySchema: Map<string, Array<Fields[]>>,
  opts: { missingSchemas?: ReadonlySet<string> } = {},
): {
  restore: () => void;
  callsBySchema: Map<string, number>;
} {
  const callsBySchema = new Map<string, number>();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.endsWith("/api/query")) {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const schema = String(body.schema_name);
      const n = (callsBySchema.get(schema) ?? 0) + 1;
      callsBySchema.set(schema, n);
      if (opts.missingSchemas?.has(schema)) {
        return new Response(
          JSON.stringify({ error: `Schema not found: ${schema}` }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      const queue = responsesBySchema.get(schema);
      const rows =
        queue && queue.length > 0
          ? queue.length > 1
            ? queue.shift()!
            : queue[0]!
          : [];
      const results = rows.map((fields) => ({
        fields,
        key: { hash: String(fields.slug ?? "k"), range: null },
      }));
      return new Response(
        JSON.stringify({
          ok: true,
          results,
          total_count: results.length,
          returned_count: results.length,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    // Default OK for anything else (identity bootstrap, schema loads).
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { restore: () => void (globalThis.fetch = originalFetch), callsBySchema };
}

describe("listCmd — read-flake retry", () => {
  test("--field projects record summaries as TSV without the human table", async () => {
    const newer = spikeRow("newer", {
      status: "concluded",
      updated_at: "2026-05-27T00:00:00Z",
    });
    const older = spikeRow("older", {
      status: "exploring",
      updated_at: "2026-05-26T00:00:00Z",
    });
    const responses = new Map<string, Array<Fields[]>>([
      [TEST_HASHES.spike, [[older, newer]]],
    ]);
    const { restore } = stubFetch(responses);
    const lines: string[] = [];
    try {
      await listCmd({
        cfg,
        type: "spike",
        fields: ["slug", "status"],
        print: (l) => lines.push(l),
      });
    } finally {
      restore();
    }

    expect(lines).toEqual(["newer\tconcluded", "older\texploring"]);
  });

  test("with --status filter: empty sweep then hit prints the row", async () => {
    // First sweep on the spike schema returns nothing; second returns the
    // row with the updated status. Mirrors the 2026-05-26 dogfood repro
    // where a status write was momentarily invisible to a follow-up list.
    const row = spikeRow("retry-target", { status: "concluded" });
    const responses = new Map<string, Array<Fields[]>>([
      [TEST_HASHES.spike, [[], [row]]],
    ]);
    const { restore, callsBySchema } = stubFetch(responses);
    const lines: string[] = [];
    try {
      await listCmd({
        cfg,
        type: "spike",
        status: "concluded",
        print: (l) => lines.push(l),
      });
    } finally {
      restore();
    }
    // 2 key-only sweeps (empty, then hit) + 1 point-get to hydrate the one
    // matched row's body for the page (the keys-first fix this card lands).
    expect(callsBySchema.get(TEST_HASHES.spike)).toBe(3);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("retry-target");
    expect(lines[0]).toContain("concluded");
  });

  test("with --status filter: first sweep hits → no retry consumed", async () => {
    const row = spikeRow("first-try", { status: "concluded" });
    const responses = new Map<string, Array<Fields[]>>([
      [TEST_HASHES.spike, [[row]]],
    ]);
    const { restore, callsBySchema } = stubFetch(responses);
    const lines: string[] = [];
    try {
      await listCmd({
        cfg,
        type: "spike",
        status: "concluded",
        print: (l) => lines.push(l),
      });
    } finally {
      restore();
    }
    // 1 key-only sweep (first try hits, no retry) + 1 point-get to hydrate
    // the matched row's body for the page.
    expect(callsBySchema.get(TEST_HASHES.spike)).toBe(2);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("first-try");
  });

  test("with --status filter: every sweep empty → 'no records' after budget spent", async () => {
    const responses = new Map<string, Array<Fields[]>>([
      [TEST_HASHES.spike, []], // all reads default to []
    ]);
    const { restore, callsBySchema } = stubFetch(responses);
    const lines: string[] = [];
    try {
      await listCmd({
        cfg,
        type: "spike",
        status: "concluded",
        print: (l) => lines.push(l),
      });
    } finally {
      restore();
    }
    // 5 attempts is the READ_RETRY_ATTEMPTS default for the filtered sweep,
    // then the empty-result hint path probes hasAnyLiveRecord once per schema
    // hash (spike included) → 5 + 1 = 6 spike /api/query calls.
    expect(callsBySchema.get(TEST_HASHES.spike)).toBe(6);
    // Brain is genuinely empty → the create-your-first hint (a filter was set,
    // but an empty brain wins: there's nothing to filter, so guide the new dev).
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("no records");
    expect(lines[1]).toContain("no records yet");
    expect(lines[1]).toContain("fbrain <type> new <slug>");
  });

  test("with --tag filter (no --status): retries on empty-then-hit", async () => {
    // The retry must trigger for --tag as well, not just --status.
    const row = spikeRow("tag-target", { tags: ["dogfood"] });
    const responses = new Map<string, Array<Fields[]>>([
      [TEST_HASHES.spike, [[], [row]]],
    ]);
    const { restore, callsBySchema } = stubFetch(responses);
    const lines: string[] = [];
    try {
      await listCmd({
        cfg,
        type: "spike",
        tag: "dogfood",
        print: (l) => lines.push(l),
      });
    } finally {
      restore();
    }
    expect(callsBySchema.get(TEST_HASHES.spike)).toBe(2);
    expect(lines[0]).toContain("tag-target");
    expect(lines[0]).toContain("dogfood");
  });

  test("no --status/--tag filter: empty sweep returns immediately without retry", async () => {
    // Without a user filter, empty is a legitimate signal — the per-type
    // sweep should not burn the retry budget. With --type spike + no
    // status/tag, exactly one /api/query for the spike schema is expected.
    const responses = new Map<string, Array<Fields[]>>([
      [TEST_HASHES.spike, []],
    ]);
    const { restore, callsBySchema } = stubFetch(responses);
    const lines: string[] = [];
    try {
      await listCmd({
        cfg,
        type: "spike",
        print: (l) => lines.push(l),
      });
    } finally {
      restore();
    }
    // One sweep call (no retry without a filter), then the empty-result hint
    // path probes hasAnyLiveRecord across every schema → +1 spike call.
    expect(callsBySchema.get(TEST_HASHES.spike)).toBe(2);
    // Genuinely-empty brain → create-your-first hint.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("no records");
    expect(lines[1]).toContain("no records yet");
  });

  test("retry budget stops once a non-tombstoned row appears, even if user filter excludes it", async () => {
    // The retry rides out empty-sweep flake, not "no matching row" — once
    // the sweep surfaces ANY non-tombstoned record we trust the per-call
    // result and let the user filter decide. Here the row's status is
    // "exploring" but the caller asked for "concluded": the retry must
    // terminate after the first hit (1 sweep), not keep retrying.
    const row = spikeRow("wrong-status", { status: "exploring" });
    const responses = new Map<string, Array<Fields[]>>([
      // First slice = the sweep (terminates retry on the first hit); the
      // second slice is consumed by the empty-result hint path's
      // hasAnyLiveRecord probe, which must also see the live row so the brain
      // reads as NON-empty → the filter hint (not "create your first").
      [TEST_HASHES.spike, [[row], [row]]],
    ]);
    const { restore, callsBySchema } = stubFetch(responses);
    const lines: string[] = [];
    try {
      await listCmd({
        cfg,
        type: "spike",
        status: "concluded",
        print: (l) => lines.push(l),
      });
    } finally {
      restore();
    }
    // 1 sweep (no retry — first call hit) + 1 hasAnyLiveRecord probe = 2.
    expect(callsBySchema.get(TEST_HASHES.spike)).toBe(2);
    // A live record exists but the filter excluded it → the filter hint, NOT
    // the create-your-first hint (the brain is not empty).
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("no records");
    expect(lines[1]).toContain("no records match that filter");
    expect(lines[1]).not.toContain("no records yet");
  });

  test("unfiltered list caps at DEFAULT_LIST_LIMIT (20) with a 'K more' hint", async () => {
    // 25 spike rows, no filter, no explicit -n → list trims to 20
    // newest and emits a single trailing hint for the remaining 5.
    // The newest-first sort is by updated_at — make every row's
    // updated_at unique and increasing so the slice is deterministic.
    const rows = Array.from({ length: 25 }, (_, i) =>
      spikeRow(`slug-${String(i).padStart(2, "0")}`, {
        // Newer index → newer timestamp → first in the sort.
        updated_at: `2026-05-${String(1 + i).padStart(2, "0")}T00:00:00Z`,
      }),
    );
    const responses = new Map<string, Array<Fields[]>>([
      [TEST_HASHES.spike, [rows]],
    ]);
    const { restore } = stubFetch(responses);
    const lines: string[] = [];
    try {
      await listCmd({
        cfg,
        type: "spike",
        print: (l) => lines.push(l),
      });
    } finally {
      restore();
    }
    // 20 record lines + 1 hint line.
    expect(lines.length).toBe(21);
    expect(lines[20]).toBe(
      "… 5 more (use -n N to widen, or filter with --type/--tag)",
    );
    // The newest (slug-24, updated 2026-05-25) is first; the
    // 20th-newest (slug-05) is last among the data rows; slug-04 and
    // below are truncated.
    expect(lines[0]).toContain("slug-24");
    expect(lines[19]).toContain("slug-05");
    for (let i = 0; i < 5; i++) {
      const truncated = `slug-${String(i).padStart(2, "0")}`;
      expect(lines.slice(0, 20).some((l) => l.includes(truncated))).toBe(false);
    }
  });

  test("explicit -n overrides the default cap and suppresses the hint", async () => {
    // With `--limit 5` (CLI -n 5), output is exactly 5 record lines —
    // no truncation hint, even though there are more rows behind it.
    // The user asked for N; they already know they're seeing a slice.
    const rows = Array.from({ length: 25 }, (_, i) =>
      spikeRow(`slug-${String(i).padStart(2, "0")}`, {
        updated_at: `2026-05-${String(1 + i).padStart(2, "0")}T00:00:00Z`,
      }),
    );
    const responses = new Map<string, Array<Fields[]>>([
      [TEST_HASHES.spike, [rows]],
    ]);
    const { restore } = stubFetch(responses);
    const lines: string[] = [];
    try {
      await listCmd({
        cfg,
        type: "spike",
        limit: 5,
        print: (l) => lines.push(l),
      });
    } finally {
      restore();
    }
    expect(lines.length).toBe(5);
    expect(lines.some((l) => l.includes("more"))).toBe(false);
  });

  test("default cap with exactly 20 rows: no hint (nothing was truncated)", async () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      spikeRow(`slug-${String(i).padStart(2, "0")}`, {
        updated_at: `2026-05-${String(1 + i).padStart(2, "0")}T00:00:00Z`,
      }),
    );
    const responses = new Map<string, Array<Fields[]>>([
      [TEST_HASHES.spike, [rows]],
    ]);
    const { restore } = stubFetch(responses);
    const lines: string[] = [];
    try {
      await listCmd({
        cfg,
        type: "spike",
        print: (l) => lines.push(l),
      });
    } finally {
      restore();
    }
    expect(lines.length).toBe(20);
    expect(lines.some((l) => l.includes("more"))).toBe(false);
  });

  test("genuinely-empty result prints 'no records' even with default cap active", async () => {
    // Belt-and-braces: the empty-wins branch must come before the
    // truncation-hint path, otherwise an unfiltered list of an empty
    // store would print nothing (or a confusing "0 more" line).
    const responses = new Map<string, Array<Fields[]>>([
      [TEST_HASHES.spike, [[]]],
    ]);
    const { restore } = stubFetch(responses);
    const lines: string[] = [];
    try {
      await listCmd({
        cfg,
        type: "spike",
        print: (l) => lines.push(l),
      });
    } finally {
      restore();
    }
    // The empty-wins branch still fires before the truncation-hint path; on a
    // genuinely-empty brain it now also appends the create-your-first hint.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("no records");
    expect(lines[1]).toContain("no records yet");
  });

  test("columns align even when one slug is much longer than the rest", () => {
    // Regression for the padEnd(28) drift: with a 54-char slug
    // alongside short ones, the status column must start at the same
    // character offset on every row.
    // We exercise this through listCmd to keep the assertion on the
    // user-facing format, not the helper.
    return (async () => {
      const longSlug = "agent-pr-events-2026-05-25-091310-pr-created-master";
      const responses = new Map<string, Array<Fields[]>>([
        [
          TEST_HASHES.spike,
          [
            [
              spikeRow(longSlug, { updated_at: "2026-05-26T00:00:00Z" }),
              spikeRow("short", { updated_at: "2026-05-25T00:00:00Z" }),
            ],
          ],
        ],
      ]);
      const { restore } = stubFetch(responses);
      const lines: string[] = [];
      try {
        await listCmd({
          cfg,
          type: "spike",
          print: (l) => lines.push(l),
        });
      } finally {
        restore();
      }
      expect(lines.length).toBe(2);
      const statusIdx0 = lines[0]!.indexOf("exploring");
      const statusIdx1 = lines[1]!.indexOf("exploring");
      expect(statusIdx0).toBeGreaterThan(0);
      expect(statusIdx0).toBe(statusIdx1);
    })();
  });

  test("tombstoned-only sweep keeps retrying (tombstones don't count as a hit)", async () => {
    // If every visible row is tombstoned, the isHit predicate stays false
    // — same as truly empty. This protects against the polluted-daemon
    // case where stale tombstoned rows leak through while the live row
    // is briefly invisible.
    const tomb = spikeRow("ghost", { tags: [TOMBSTONE_TAG] });
    const live = spikeRow("alive", { status: "concluded" });
    const responses = new Map<string, Array<Fields[]>>([
      [TEST_HASHES.spike, [[tomb], [tomb, live]]],
    ]);
    const { restore, callsBySchema } = stubFetch(responses);
    const lines: string[] = [];
    try {
      await listCmd({
        cfg,
        type: "spike",
        status: "concluded",
        print: (l) => lines.push(l),
      });
    } finally {
      restore();
    }
    // 2 key-only sweeps (tombstone-only, then tombstone+live) + 1 point-get
    // to hydrate "alive"'s body for the page.
    expect(callsBySchema.get(TEST_HASHES.spike)).toBe(3);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("alive");
  });
});

// Pagination + filter-vs-cap regression. The `/api/query` endpoint
// defaults to limit=100 server-side and does not accept a tag/status
// filter in the body, so `queryAll` MUST paginate to surface a tagged
// record that lives outside the first page. Pre-fix: `fbrain list --tag
// foo` against a >100-record bucket silently dropped the older matches.
describe("listCmd — pagination across the server's /api/query cap", () => {
  // Stub that respects body.limit/body.offset and reports has_more
  // exactly like fold_db_node's QueryResponse contract (DEFAULT_QUERY_LIMIT
  // / MAX_QUERY_LIMIT in fold_db_node/src/handlers/query.rs). Returns one
  // server-cap-sized page per call and lets the caller iterate.
  function stubPaginatedFetch(
    rowsBySchema: Map<string, Fields[]>,
    opts: { defaultLimit?: number } = {},
  ): {
    restore: () => void;
    pageRequestsBySchema: Map<string, number>;
  } {
    const defaultLimit = opts.defaultLimit ?? 100;
    const pageRequestsBySchema = new Map<string, number>();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/api/query")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        const schema = String(body.schema_name);
        const limit =
          typeof body.limit === "number" ? body.limit : defaultLimit;
        const offset = typeof body.offset === "number" ? body.offset : 0;
        const all = rowsBySchema.get(schema) ?? [];
        const page = all.slice(offset, offset + limit);
        pageRequestsBySchema.set(
          schema,
          (pageRequestsBySchema.get(schema) ?? 0) + 1,
        );
        const results = page.map((fields) => ({
          fields,
          key: { hash: String(fields.slug ?? "k"), range: null },
        }));
        const hasMore = offset + page.length < all.length;
        return new Response(
          JSON.stringify({
            ok: true,
            results,
            total_count: all.length,
            returned_count: results.length,
            limit,
            offset,
            has_more: hasMore,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return {
      restore: () => void (globalThis.fetch = originalFetch),
      pageRequestsBySchema,
    };
  }

  function spikeRowAt(slug: string, updatedAt: string, over: Partial<Fields> = {}): Fields {
    return spikeRow(slug, { updated_at: updatedAt, ...over });
  }

  test("--tag finds the only match even when it's the OLDEST record (Phase 6 dogfood repro)", async () => {
    // 25 concepts in the bucket, only the oldest tagged `target`. With
    // -n 5, the post-filter result is 1 — not 0. This is the user-visible
    // contract: filters apply to the full set, not to the top-N window.
    const rows: Fields[] = Array.from({ length: 25 }, (_, i) =>
      spikeRowAt(
        `slug-${String(i).padStart(2, "0")}`,
        `2026-05-${String(1 + i).padStart(2, "0")}T00:00:00Z`,
        // slug-00 is the OLDEST (2026-05-01) and the only `target` row.
        i === 0 ? { tags: ["target"] } : {},
      ),
    );
    const { restore } = stubPaginatedFetch(
      new Map([[TEST_HASHES.spike, rows]]),
    );
    const lines: string[] = [];
    try {
      await listCmd({
        cfg,
        type: "spike",
        tag: "target",
        limit: 5,
        print: (l) => lines.push(l),
      });
    } finally {
      restore();
    }
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("slug-00");
  });

  test("--tag surfaces a match past the server's default 100-row cap", async () => {
    // 150 spikes in storage; only the LAST one carries the `target` tag.
    // Pre-fix the client sent no `limit` to /api/query and inherited the
    // server's DEFAULT_QUERY_LIMIT=100, so the matching row at storage
    // position 149 was invisible and `fbrain list --tag target` printed
    // "no records". With the fix the client passes limit=1000 (the
    // server's MAX_QUERY_LIMIT), the row is in the first page, and the
    // in-memory filter finds it.
    const rows: Fields[] = Array.from({ length: 150 }, (_, i) =>
      spikeRowAt(
        `slug-${String(i).padStart(3, "0")}`,
        `2026-04-${String(1 + (i % 30)).padStart(2, "0")}T00:${String(
          59 - Math.floor(i / 30),
        ).padStart(2, "0")}:00Z`,
        i === 149 ? { tags: ["target"] } : {},
      ),
    );
    const { restore } = stubPaginatedFetch(
      new Map([[TEST_HASHES.spike, rows]]),
    );
    const lines: string[] = [];
    try {
      await listCmd({
        cfg,
        type: "spike",
        tag: "target",
        print: (l) => lines.push(l),
      });
    } finally {
      restore();
    }
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("slug-149");
  });

  test("multi-page bucket (>QUERY_PAGE_SIZE rows) finds a match on page 2", async () => {
    // 1500 spikes — exceeds the client's QUERY_PAGE_SIZE (1000) so the
    // client must paginate. The match lives at storage position 1400,
    // inside page 2. Verifies queryAll's pagination loop terminates
    // correctly and aggregates results across pages.
    const matchIdx = 1400;
    const rows: Fields[] = Array.from({ length: 1500 }, (_, i) =>
      spikeRowAt(
        `slug-${String(i).padStart(4, "0")}`,
        `2026-04-${String(1 + (i % 30)).padStart(2, "0")}T00:${String(
          (i * 17) % 60,
        ).padStart(2, "0")}:00Z`,
        i === matchIdx ? { tags: ["target"] } : {},
      ),
    );
    const { restore, pageRequestsBySchema } = stubPaginatedFetch(
      new Map([[TEST_HASHES.spike, rows]]),
    );
    const lines: string[] = [];
    try {
      await listCmd({
        cfg,
        type: "spike",
        tag: "target",
        print: (l) => lines.push(l),
      });
    } finally {
      restore();
    }
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(`slug-${String(matchIdx).padStart(4, "0")}`);
    // 1500 records / 1000 per page = 2 pages. The retry path isn't
    // engaged because the first sweep saw ≥1 non-tombstoned row.
    expect(pageRequestsBySchema.get(TEST_HASHES.spike)).toBe(2);
  });

  test("--status finds a status-matched record in page 2", async () => {
    // Same bug class as --tag: the in-memory filter must see all rows.
    // 150 spikes, only the last has status "concluded".
    const rows: Fields[] = Array.from({ length: 150 }, (_, i) =>
      spikeRowAt(
        `slug-${String(i).padStart(3, "0")}`,
        `2026-04-${String(1 + (i % 30)).padStart(2, "0")}T00:00:00Z`,
        i === 149 ? { status: "concluded" } : {},
      ),
    );
    const { restore } = stubPaginatedFetch(
      new Map([[TEST_HASHES.spike, rows]]),
    );
    const lines: string[] = [];
    try {
      await listCmd({
        cfg,
        type: "spike",
        status: "concluded",
        print: (l) => lines.push(l),
      });
    } finally {
      restore();
    }
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("slug-149");
    expect(lines[0]).toContain("concluded");
  });

  test("a 1000-record bucket's KEY sweep resolves in a single page request (QUERY_PAGE_SIZE)", async () => {
    // 1000 rows fits in one client page (QUERY_PAGE_SIZE), so the key-only
    // sweep (this card's fix: list keys first, filter/sort/offset/limit,
    // THEN hydrate) sees exactly one /api/query when we set defaultLimit to
    // the same size — the sweep itself never fragments regardless of corpus
    // size. Pre-fix the client sent no `limit` at all and inherited the
    // server's 100-row default — 10x more round trips at this scale for the
    // sweep alone. On top of that one sweep call, the default-capped page
    // (DEFAULT_LIST_LIMIT=20) costs exactly 20 more point-get calls to
    // hydrate those 20 rows' bodies — bounded by the PAGE size, never by the
    // 1000-row corpus size. 1 (sweep) + 20 (hydrate) = 21 total.
    const rows: Fields[] = Array.from({ length: 1000 }, (_, i) =>
      spikeRowAt(
        `slug-${String(i).padStart(4, "0")}`,
        `2026-04-${String(1 + (i % 30)).padStart(2, "0")}T00:00:00Z`,
      ),
    );
    const { restore, pageRequestsBySchema } = stubPaginatedFetch(
      new Map([[TEST_HASHES.spike, rows]]),
      { defaultLimit: 1000 },
    );
    try {
      await listCmd({
        cfg,
        type: "spike",
        print: () => {},
      });
    } finally {
      restore();
    }
    expect(pageRequestsBySchema.get(TEST_HASHES.spike)).toBe(21);
  });
});

// Deterministic ordering when multiple records share an `updated_at`. The
// node's `/api/query` row order is documented to be unstable
// (fold_db_node/src/handlers/query.rs `.skip(offset).take(limit)` over an
// unordered set — see the queryAll comment in src/client.ts), so a sort by
// `updated_at` alone leaves tied records in whatever order the node served
// them. With `-n N` truncation that means `fbrain list` can swap WHICH rows
// it shows across invocations on the same store. Ties are realistic in
// practice: `fbrain migrate` / `init` seed batches stamp identical
// timestamps, and `nowIso()` is millisecond-resolution so any two
// `put` / `status` / `link` calls in the same ms collide.
describe("listCmd — deterministic ordering on tied updated_at", () => {
  test("same rows in different input orders produce identical list output", async () => {
    // 10 spikes, all sharing the same updated_at. Feed them to the
    // listCmd in ascending and descending input orders (the two
    // adversarial orderings the node could pick). With a stable sort by
    // updated_at only, the post-sort output mirrors the input — so the
    // top-5 slice differs between runs. With a slug tie-breaker it does
    // not. The test asserts equality between the two runs' outputs.
    const sharedTs = "2026-05-26T00:00:00Z";
    const ascending: Fields[] = Array.from({ length: 10 }, (_, i) =>
      spikeRow(`slug-${String(i).padStart(2, "0")}`, { updated_at: sharedTs }),
    );
    const descending = [...ascending].reverse();

    const runOnce = async (rows: Fields[]): Promise<string[]> => {
      const responses = new Map<string, Array<Fields[]>>([
        [TEST_HASHES.spike, [rows]],
      ]);
      const { restore } = stubFetch(responses);
      const lines: string[] = [];
      try {
        await listCmd({
          cfg,
          type: "spike",
          limit: 5,
          print: (l) => lines.push(l),
        });
      } finally {
        restore();
      }
      return lines;
    };

    const fromAsc = await runOnce(ascending);
    const fromDesc = await runOnce(descending);
    expect(fromAsc.length).toBe(5);
    expect(fromDesc.length).toBe(5);
    // The two runs must produce the same ordered output — anything else
    // means the node's row order is leaking into the user-visible list.
    expect(fromAsc).toEqual(fromDesc);
  });

  test("ties on updated_at break by slug ascending", async () => {
    // Pin the tie-breaker direction so a future change to the sort
    // (e.g. flipping slug direction) trips the test loudly instead of
    // silently changing what `fbrain list -n N` shows.
    const sharedTs = "2026-05-26T00:00:00Z";
    const rows: Fields[] = [
      spikeRow("slug-99", { updated_at: sharedTs }),
      spikeRow("slug-00", { updated_at: sharedTs }),
      spikeRow("slug-50", { updated_at: sharedTs }),
    ];
    const responses = new Map<string, Array<Fields[]>>([
      [TEST_HASHES.spike, [rows]],
    ]);
    const { restore } = stubFetch(responses);
    const lines: string[] = [];
    try {
      await listCmd({
        cfg,
        type: "spike",
        print: (l) => lines.push(l),
      });
    } finally {
      restore();
    }
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain("slug-00");
    expect(lines[1]).toContain("slug-50");
    expect(lines[2]).toContain("slug-99");
  });

  test("newer updated_at still wins over the tie-breaker", async () => {
    // Guard against a regression that drops the primary sort and ranks
    // by slug only. The newer row must still come first regardless of
    // alphabetical slug order.
    const rows: Fields[] = [
      // Alphabetically earlier slug but OLDER — must NOT appear first.
      spikeRow("aaa-older", { updated_at: "2026-05-01T00:00:00Z" }),
      spikeRow("zzz-newer", { updated_at: "2026-05-26T00:00:00Z" }),
    ];
    const responses = new Map<string, Array<Fields[]>>([
      [TEST_HASHES.spike, [rows]],
    ]);
    const { restore } = stubFetch(responses);
    const lines: string[] = [];
    try {
      await listCmd({
        cfg,
        type: "spike",
        print: (l) => lines.push(l),
      });
    } finally {
      restore();
    }
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("zzz-newer");
    expect(lines[1]).toContain("aaa-older");
  });
});

describe("listCmd — updated_since, offset, count, and tag index", () => {
  test("updatedSinceMs filters before offset/limit; count ignores offset/limit", async () => {
    const rows: Fields[] = [
      spikeRow("old", { updated_at: "2026-06-30T00:00:00Z" }),
      spikeRow("middle", { updated_at: "2026-07-01T00:00:00Z" }),
      spikeRow("new", { updated_at: "2026-07-02T00:00:00Z" }),
    ];
    const run = async (count: boolean): Promise<string[]> => {
      const responses = new Map<string, Array<Fields[]>>([
        [TEST_HASHES.spike, [rows]],
      ]);
      const { restore } = stubFetch(responses);
      const lines: string[] = [];
      try {
        await listCmd({
          cfg,
          type: "spike",
          updatedSinceMs: Date.parse("2026-07-01T00:00:00Z"),
          offset: 1,
          limit: 1,
          count,
          print: (l) => lines.push(l),
        });
      } finally {
        restore();
      }
      return lines;
    };

    const page = await run(false);
    expect(page).toHaveLength(1);
    expect(page[0]).toContain("middle");
    expect(page[0]).not.toContain("old");

    const counted = await run(true);
    expect(counted).toEqual(["2"]);
  });

  test("--count fetches keys only — never requests title/body fields", async () => {
    // `--count` never renders a row, so it must not pay for a full-field
    // corpus drain: the request `/api/query` sends for the count sweep
    // should carry `listRecordKeys`' skinny projection (slug/tags/updated_at),
    // not `listRecords`' full field set (title, body, ...).
    const rows: Fields[] = [spikeRow("a"), spikeRow("b")];
    const requestedFields: string[][] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/api/query")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        requestedFields.push(body.fields ?? []);
        const results = rows.map((fields) => ({
          fields,
          key: { hash: String(fields.slug ?? "k"), range: null },
        }));
        return new Response(
          JSON.stringify({
            ok: true,
            results,
            total_count: results.length,
            returned_count: results.length,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    try {
      await listCmd({ cfg, type: "spike", count: true, print: (l) => lines.push(l) });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(lines).toEqual(["2"]);
    expect(requestedFields.length).toBeGreaterThan(0);
    for (const fields of requestedFields) {
      expect(fields).not.toContain("title");
      expect(fields).not.toContain("body");
    }
  });

  test("--tag can resolve from the per-tag index with only member point reads", async () => {
    const indexRow = {
      slug: tagIndexSlug("indexed"),
      tag: "indexed",
      members: ["spike:from-index"],
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-02T00:00:00Z",
    };
    const indexedSpike = spikeRow("from-index", { tags: ["indexed"] });
    const responses = new Map<string, Array<Fields[]>>([
      [TEST_TAG_INDEX_HASH, [[indexRow]]],
      [TEST_HASHES.spike, [[indexedSpike]]],
    ]);
    const { restore, callsBySchema } = stubFetch(responses);
    const lines: string[] = [];
    try {
      await listCmd({
        cfg,
        type: "spike",
        tag: "indexed",
        print: (l) => lines.push(l),
      });
    } finally {
      restore();
    }

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("from-index");
    expect(callsBySchema.get(TEST_TAG_INDEX_HASH)).toBe(1);
    expect(callsBySchema.get(TEST_HASHES.spike)).toBe(1);
  });
});

describe("listCmd — stale config missing decision hash", () => {
  test("unfiltered list skips the missing decision hash and returns other records", async () => {
    const oldCfg = buildTestCfg({
      userHash: "uh",
      schemaHashes: { ...TEST_HASHES },
    });
    delete oldCfg.schemaHashes.decision;

    const row = spikeRow("usable-output");
    const responses = new Map<string, Array<Fields[]>>([
      [TEST_HASHES.spike, [[row]]],
    ]);
    const { restore, callsBySchema } = stubFetch(responses);
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      await listCmd({
        cfg: oldCfg,
        print: (l) => stdout.push(l),
        printErr: (l) => stderr.push(l),
      });
    } finally {
      restore();
    }

    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toContain("usable-output");
    expect(stderr.some((l) => l.includes("decision") && l.includes("skipping"))).toBe(true);
    expect(stderr.some((l) => l.includes("init --grant-consent"))).toBe(true);
    expect(callsBySchema.has(TEST_HASHES.decision)).toBe(false);
    expect([...callsBySchema.keys()]).not.toContain("undefined");
  });

  test("unfiltered list skips a stale registered decision hash and returns all healthy records", async () => {
    const staleDecisionHash = "0".repeat(64);
    const staleCfg = buildTestCfg({
      userHash: "uh",
      schemaHashes: { ...TEST_HASHES, decision: staleDecisionHash },
    });

    const responses = new Map<string, Array<Fields[]>>();
    for (const type of RECORD_TYPES) {
      if (type === "decision") continue;
      responses.set(TEST_HASHES[type], [[spikeRow(`${type}-healthy`)]]);
    }
    const { restore, callsBySchema } = stubFetch(responses, {
      missingSchemas: new Set([staleDecisionHash]),
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      await listCmd({
        cfg: staleCfg,
        print: (l) => stdout.push(l),
        printErr: (l) => stderr.push(l),
      });
    } finally {
      restore();
    }

    expect(stdout).toHaveLength(RECORD_TYPES.length - 1);
    for (const type of RECORD_TYPES) {
      if (type === "decision") continue;
      expect(stdout.some((l) => l.includes(`${type}-healthy`))).toBe(true);
    }
    expect(stderr.some((l) => l.includes("decision") && l.includes("skipping"))).toBe(true);
    expect(stderr.some((l) => l.includes("init --grant-consent"))).toBe(true);
    expect(callsBySchema.get(staleDecisionHash)).toBe(1);
  });

  test("explicit --type decision with no hash returns a normal empty result, not missing_schema_hash", async () => {
    const oldCfg = buildTestCfg({
      userHash: "uh",
      schemaHashes: { ...TEST_HASHES },
    });
    delete oldCfg.schemaHashes.decision;

    const responses = new Map<string, Array<Fields[]>>();
    const { restore, callsBySchema } = stubFetch(responses);
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      await listCmd({
        cfg: oldCfg,
        type: "decision",
        print: (l) => stdout.push(l),
        printErr: (l) => stderr.push(l),
      });
    } finally {
      restore();
    }

    expect(stdout[0]).toBe("no records");
    expect(stderr.some((l) => l.includes("decision") && l.includes("skipping"))).toBe(true);
    expect(callsBySchema.has(TEST_HASHES.decision)).toBe(false);
    expect([...callsBySchema.keys()]).not.toContain("undefined");
  });
});

describe("listCmd — empty-node create-your-first hint (parity with search/ask)", () => {
  test("brand-new EMPTY brain points the new dev at creating their first record", async () => {
    // `fbrain list` is step 2 of init's Next-steps — the FIRST content command
    // a fresh dev runs. On a zero-record brain every schema page is empty, so
    // the hasAnyLiveRecord probe reports empty and the hint is the calm
    // "create your first record" guidance search (#276) / ask (#279) give.
    const responses = new Map<string, Array<Fields[]>>(); // every schema → []
    const { restore } = stubFetch(responses);
    const lines: string[] = [];
    try {
      await listCmd({ cfg, print: (l) => lines.push(l) });
    } finally {
      restore();
    }
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("no records");
    expect(lines[1]).toMatch(/^hint:\s/);
    expect(lines[1]).toContain("no records yet");
    expect(lines[1]).toContain("fbrain <type> new <slug>");
    expect(lines[1]).toContain("list again");
  });

  test("POPULATED brain + a filter that matches nothing gets the filter hint, NOT create-first", async () => {
    // A live spike record exists, but `--tag nonexistent` matches none. The
    // hasAnyLiveRecord probe sees the live row → the brain reads as non-empty,
    // so the hint must be the filter-specific nudge, never "create your first"
    // (that would be wrong — they DO have records).
    const row = spikeRow("already-here", { tags: ["real-tag"] });
    const responses = new Map<string, Array<Fields[]>>([
      // First slice: the --tag sweep (retries on empty, but this hits on the
      // first call → terminates). Second slice: the hasAnyLiveRecord probe,
      // which must also see the live row.
      [TEST_HASHES.spike, [[row], [row]]],
    ]);
    const { restore } = stubFetch(responses);
    const lines: string[] = [];
    try {
      await listCmd({ cfg, type: "spike", tag: "nonexistent", print: (l) => lines.push(l) });
    } finally {
      restore();
    }
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("no records");
    expect(lines[1]).toMatch(/^hint:\s/);
    expect(lines[1]).toContain("no records match that filter");
    expect(lines[1]).not.toContain("no records yet");
  });

  test("--json on an empty brain keeps stdout `[]` and routes the hint to stderr", async () => {
    const responses = new Map<string, Array<Fields[]>>(); // empty brain
    const { restore } = stubFetch(responses);
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      await listCmd({
        cfg,
        json: true,
        print: (l) => stdout.push(l),
        printErr: (l) => stderr.push(l),
      });
    } finally {
      restore();
    }
    // Stdout is a single parseable empty array — jq pipelines stay clean.
    expect(stdout).toEqual(["[]"]);
    // The hint lands on stderr.
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain("no records yet");
  });
});
