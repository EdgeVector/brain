// Unit tests for the search command's fragment→record resolution +
// dedupe path. Uses a mocked fetch so we control the search and query
// responses without standing up a real node.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { dedupeHits, searchCmd } from "../../src/commands/search.ts";
import type { NativeIndexHit } from "../../src/client.ts";
import { buildTestCfg, TEST_HASHES } from "../util.ts";

const DESIGN_HASH = TEST_HASHES.design;
const TASK_HASH = TEST_HASHES.task;
const OTHER_HASH = "1111111111111111111111111111111111111111111111111111111111111111";

const cfg = buildTestCfg({ userHash: "test-hash" });

function hit(opts: Partial<NativeIndexHit> & { slug: string; schemaName: string }): NativeIndexHit {
  return {
    schema_name: opts.schemaName,
    schema_display_name: opts.schema_display_name ?? null,
    field: opts.field ?? "body",
    key_value: { hash: opts.slug, range: null },
    value: opts.value ?? "fragment text",
    metadata: opts.metadata ?? { score: 0.5, match_type: "semantic" },
  };
}

describe("dedupeHits", () => {
  test("collapses multiple fragments of same record to highest-score", () => {
    const hits: NativeIndexHit[] = [
      hit({ slug: "a", schemaName: DESIGN_HASH, schema_display_name: "Design", metadata: { score: 0.3 } }),
      hit({ slug: "a", schemaName: DESIGN_HASH, schema_display_name: "Design", metadata: { score: 0.7 } }),
      hit({ slug: "a", schemaName: DESIGN_HASH, schema_display_name: "Design", metadata: { score: 0.5 } }),
    ];
    const out = dedupeHits(hits);
    expect(out).toHaveLength(1);
    expect(out[0]!.metadata!.score).toBe(0.7);
  });

  test("keeps distinct records separate", () => {
    const hits: NativeIndexHit[] = [
      hit({ slug: "a", schemaName: DESIGN_HASH, schema_display_name: "Design" }),
      hit({ slug: "b", schemaName: DESIGN_HASH, schema_display_name: "Design" }),
    ];
    expect(dedupeHits(hits)).toHaveLength(2);
  });

  test("treats Design+slug and Task+slug as distinct keys", () => {
    const hits: NativeIndexHit[] = [
      hit({ slug: "x", schemaName: DESIGN_HASH, schema_display_name: "Design" }),
      hit({ slug: "x", schemaName: TASK_HASH, schema_display_name: "Task" }),
    ];
    expect(dedupeHits(hits)).toHaveLength(2);
  });

  test("skips hits with no key_value.hash", () => {
    const hits: NativeIndexHit[] = [
      { ...hit({ slug: "ignored", schemaName: DESIGN_HASH, schema_display_name: "Design" }), key_value: { hash: null, range: null } },
      hit({ slug: "kept", schemaName: DESIGN_HASH, schema_display_name: "Design" }),
    ];
    const out = dedupeHits(hits);
    expect(out).toHaveLength(1);
    expect(out[0]!.key_value.hash).toBe("kept");
  });
});

const realFetch = globalThis.fetch;

type MockResponse = { status: number; body?: unknown };

function installSequencedMock(handler: (url: string, init?: RequestInit) => MockResponse): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    const next = handler(url, init);
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("searchCmd", () => {
  test("resolves a single hit and prints slug+score+type+title", async () => {
    const recordRow = {
      fields: {
        slug: "alpha",
        title: "Alpha design",
        body: "blueberry octopus",
        status: "draft",
        tags: ["x"],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
      },
      key: { hash: "alpha", range: null },
    };
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        return {
          status: 200,
          body: {
            ok: true,
            results: [
              hit({ slug: "alpha", schemaName: DESIGN_HASH, schema_display_name: "Design", metadata: { score: 0.42 } }),
            ],
            user_hash: cfg.userHash,
          },
        };
      }
      if (url.includes("/api/query")) {
        return { status: 200, body: { ok: true, results: [recordRow], total_count: 1, returned_count: 1 } };
      }
      return { status: 404, body: { error: "unknown" } };
    });
    const lines: string[] = [];
    await searchCmd({ cfg, query: "blueberry", print: (l) => lines.push(l) });
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("alpha");
    expect(lines[0]).toContain("0.420");
    expect(lines[0]).toContain("Design");
    expect(lines[0]).toContain("Alpha design");
  });

  test("silently skips stale hits where findBySlug returns nothing", async () => {
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        return {
          status: 200,
          body: {
            ok: true,
            results: [
              hit({ slug: "ghost", schemaName: DESIGN_HASH, schema_display_name: "Design" }),
            ],
            user_hash: cfg.userHash,
          },
        };
      }
      if (url.includes("/api/query")) {
        return { status: 200, body: { ok: true, results: [], total_count: 0, returned_count: 0 } };
      }
      return { status: 404, body: { error: "unknown" } };
    });
    const lines: string[] = [];
    await searchCmd({ cfg, query: "anything", print: (l) => lines.push(l) });
    expect(lines).toEqual(["no matches"]);
  });

  test("skips hits whose schema_name matches neither Design nor Task", async () => {
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        return {
          status: 200,
          body: {
            ok: true,
            results: [
              hit({ slug: "x", schemaName: OTHER_HASH, schema_display_name: "Other" }),
            ],
            user_hash: cfg.userHash,
          },
        };
      }
      return { status: 200, body: { ok: true, results: [] } };
    });
    const lines: string[] = [];
    await searchCmd({ cfg, query: "x", print: (l) => lines.push(l) });
    expect(lines).toEqual(["no matches"]);
  });

  test("tolerates missing metadata.score → prints — in the score column", async () => {
    const recordRow = {
      fields: {
        slug: "x",
        title: "X",
        body: "...",
        status: "draft",
        tags: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      key: { hash: "x", range: null },
    };
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        return {
          status: 200,
          body: {
            ok: true,
            results: [
              {
                schema_name: DESIGN_HASH,
                schema_display_name: "Design",
                field: "body",
                key_value: { hash: "x", range: null },
                value: "fragment",
                // no metadata
              } as NativeIndexHit,
            ],
            user_hash: cfg.userHash,
          },
        };
      }
      if (url.includes("/api/query")) {
        return { status: 200, body: { ok: true, results: [recordRow] } };
      }
      return { status: 404 };
    });
    const lines: string[] = [];
    await searchCmd({ cfg, query: "x", print: (l) => lines.push(l) });
    expect(lines[0]).toContain("—");
  });

  test("applies -n limit", async () => {
    const rows = ["a", "b", "c", "d"].map((slug) => ({
      fields: {
        slug,
        title: `T-${slug}`,
        body: "...",
        status: "draft",
        tags: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      key: { hash: slug, range: null },
    }));
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        return {
          status: 200,
          body: {
            ok: true,
            results: rows.map((r, i) =>
              hit({
                slug: r.fields.slug,
                schemaName: DESIGN_HASH,
                schema_display_name: "Design",
                metadata: { score: 0.9 - i * 0.1 },
              }),
            ),
            user_hash: cfg.userHash,
          },
        };
      }
      if (url.includes("/api/query")) {
        return { status: 200, body: { ok: true, results: rows } };
      }
      return { status: 404 };
    });
    const lines: string[] = [];
    await searchCmd({ cfg, query: "x", limit: 2, print: (l) => lines.push(l) });
    expect(lines).toHaveLength(2);
    // Highest-scoring first.
    expect(lines[0]).toContain("a");
    expect(lines[1]).toContain("b");
  });

  test("--exact passes ?exact=true on the wire", async () => {
    let capturedUrl = "";
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        capturedUrl = url;
        return { status: 200, body: { ok: true, results: [], user_hash: cfg.userHash } };
      }
      return { status: 200, body: { ok: true, results: [] } };
    });
    await searchCmd({ cfg, query: "blue", exact: true, print: () => {} });
    expect(capturedUrl).toContain("exact=true");
  });

  test("--min-score passes ?min_score on the wire", async () => {
    let capturedUrl = "";
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        capturedUrl = url;
        return { status: 200, body: { ok: true, results: [], user_hash: cfg.userHash } };
      }
      return { status: 200, body: { ok: true, results: [] } };
    });
    await searchCmd({ cfg, query: "blue", minScore: 0.6, print: () => {} });
    expect(capturedUrl).toContain("min_score=0.6");
  });
});

beforeEach(() => {});
