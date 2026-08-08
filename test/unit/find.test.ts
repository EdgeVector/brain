// Unit tests for `fbrain find` — retrieval by an explicit array of match
// probes, fused via RRF. Mirrors the ask.ts hybrid-pipeline test harness
// (test/unit/ask-vector-tiebreak.test.ts) but keys the stubbed vector plane
// on the PROBE text so each `--match` can surface a different hit set —
// the thing find.ts actually has to fuse across.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findCmd } from "../../src/commands/find.ts";
import {
  appSearchAsLegacyNativeIndex,
  legacySearchResponseBody,
  buildTestCfg,
  TEST_HASHES,
  wrapFetchWithTypeListIndex,
} from "../util.ts";

const realFetch = globalThis.fetch;
let cacheDir = "";
let savedCacheEnv: string | undefined;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "fbrain-find-test-"));
  savedCacheEnv = process.env.FBRAIN_CACHE_DIR;
  process.env.FBRAIN_CACHE_DIR = cacheDir;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedCacheEnv === undefined) delete process.env.FBRAIN_CACHE_DIR;
  else process.env.FBRAIN_CACHE_DIR = savedCacheEnv;
  rmSync(cacheDir, { recursive: true, force: true });
});

type RowFields = Record<string, unknown>;

function designRow(slug: string, body: string): RowFields {
  return {
    slug,
    title: `T-${slug}`,
    body,
    status: "draft",
    tags: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function vectorHit(schemaName: string, slug: string, score: number): Record<string, unknown> {
  return {
    schema_name: schemaName,
    schema_display_name: null,
    field: "body",
    key_value: { hash: slug, range: null },
    value: "fragment",
    metadata: { score, match_type: "semantic" },
  };
}

// Per-probe vector hits, keyed by the exact probe text the SDK's
// `client.search(query, ...)` sends as `body.query`. Lets each `--match`
// surface a distinct doc set so the test can assert fusion, not just a
// single-probe passthrough.
function installStub(opts: {
  designRows: RowFields[];
  hitsByQuery: Record<string, Record<string, unknown>[]>;
}): void {
  const inner = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === "string" ? input : String(input);
    const appSearch = appSearchAsLegacyNativeIndex(rawUrl, init);
    const url = appSearch?.url ?? rawUrl;
    if (url.includes("/api/query")) {
      const body = init?.body ? (JSON.parse(init.body as string) as { schema_name: string }) : undefined;
      const schema = body?.schema_name;
      const rows = schema === TEST_HASHES.design ? opts.designRows : [];
      return new Response(
        JSON.stringify({
          ok: true,
          results: rows.map((f) => ({ fields: f, key: { hash: f.slug, range: null } })),
          total_count: rows.length,
          returned_count: rows.length,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/api/native-index/search")) {
      const rawBody = init?.body ? (JSON.parse(init.body as string) as { query?: string }) : {};
      const hits = opts.hitsByQuery[rawBody.query ?? ""] ?? [];
      return new Response(
        JSON.stringify(legacySearchResponseBody({ ok: true, results: hits }, appSearch)),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
  globalThis.fetch = wrapFetchWithTypeListIndex(inner, (type) =>
    type === "design" ? opts.designRows : [],
  );
}

describe("findCmd", () => {
  test("a single probe retrieves the record its vector hit names", async () => {
    const cfg = buildTestCfg();
    const designRows = [designRow("solo", "narwhal facts")];
    installStub({
      designRows,
      hitsByQuery: {
        "narwhal probe": [vectorHit(TEST_HASHES.design, "solo", 0.7)],
      },
    });

    const result = await findCmd({
      cfg,
      matches: ["narwhal probe"],
      print: () => {},
    });

    expect(result.hits.map((h) => h.slug)).toEqual(["solo"]);
  });

  test("two probes fuse via RRF: a record hit by BOTH probes outranks one hit by only one", async () => {
    const cfg = buildTestCfg();
    const designRows = [
      designRow("shared", "elephant"),
      designRow("aonly", "elephant"),
      designRow("bonly", "elephant"),
    ];
    installStub({
      designRows,
      hitsByQuery: {
        "probe alpha": [
          vectorHit(TEST_HASHES.design, "shared", 0.9),
          vectorHit(TEST_HASHES.design, "aonly", 0.6),
        ],
        "probe beta": [
          vectorHit(TEST_HASHES.design, "shared", 0.9),
          vectorHit(TEST_HASHES.design, "bonly", 0.6),
        ],
      },
    });

    const result = await findCmd({
      cfg,
      matches: ["probe alpha", "probe beta"],
      limit: 10,
      print: () => {},
    });

    const slugs = result.hits.map((h) => h.slug);
    expect(new Set(slugs)).toEqual(new Set(["shared", "aonly", "bonly"]));
    // RRF fuses, doesn't just concatenate: "shared" contributes from both
    // match[0] and match[1] rankers, so its fused score beats a doc that
    // only one probe surfaced — it must rank first.
    expect(slugs[0]).toBe("shared");

    const sharedHit = result.hits.find((h) => h.slug === "shared")!;
    expect(sharedHit.matchHits.map((m) => m.idx).sort()).toEqual([0, 1]);
    expect(sharedHit.maxSimilarity).toBe(0.9);
    const aonlyHit = result.hits.find((h) => h.slug === "aonly")!;
    expect(aonlyHit.matchHits.map((m) => m.idx)).toEqual([0]);
    const bonlyHit = result.hits.find((h) => h.slug === "bonly")!;
    expect(bonlyHit.matchHits.map((m) => m.idx)).toEqual([1]);
  });

  test("no matches from any probe returns an empty hit list, not an error", async () => {
    const cfg = buildTestCfg();
    installStub({ designRows: [], hitsByQuery: {} });

    const result = await findCmd({
      cfg,
      matches: ["nothing here"],
      print: () => {},
    });

    expect(result.hits).toEqual([]);
  });

  test("--json emits the same payload onResult delivers", async () => {
    const cfg = buildTestCfg();
    const designRows = [designRow("solo", "narwhal facts")];
    installStub({
      designRows,
      hitsByQuery: {
        "narwhal probe": [vectorHit(TEST_HASHES.design, "solo", 0.7)],
      },
    });

    let onResultPayload: unknown;
    const printed: string[] = [];
    await findCmd({
      cfg,
      matches: ["narwhal probe"],
      json: true,
      print: (l) => printed.push(l),
      onResult: (p) => {
        onResultPayload = p;
      },
    });

    expect(JSON.parse(printed[0]!)).toEqual(onResultPayload);
    expect((onResultPayload as Array<{ slug: string }>).map((h) => h.slug)).toEqual(["solo"]);
  });
});
