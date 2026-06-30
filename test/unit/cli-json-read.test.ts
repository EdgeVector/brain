// `--json` machine-readable output mode on the three read commands
// (`fbrain list`, `fbrain get`, `fbrain search`). Pins:
//
//   - Stdout is exactly one parseable JSON document — no human-formatted
//     table rows, no `note:` lines, no truncation hints.
//   - The documented field set is present (and matches what the human
//     surface shows, minus body in `list`).
//   - Advisory lines (truncation hint on list, weak-match note +
//     empty-result hint on search) route to stderr via `printErr` so
//     `jq` pipelines see clean stdout.
//   - Empty results emit `[]` instead of the human "no records" /
//     "no matches" sentinel.

import { afterEach, describe, expect, test } from "bun:test";

import { listCmd } from "../../src/commands/list.ts";
import { getRecord } from "../../src/commands/get.ts";
import { searchCmd } from "../../src/commands/search.ts";
import { statusCmd } from "../../src/commands/status.ts";
import { TEST_HASHES, buildTestCfg } from "../util.ts";

const cfg = buildTestCfg({ userHash: "uh" });

type Fields = Record<string, unknown>;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function queryResp(results: unknown[]): Response {
  return new Response(JSON.stringify({ ok: true, results }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function asRow(slug: string, fields: Fields) {
  return { fields, key: { hash: slug, range: null } };
}

function spikeFields(slug: string, over: Fields = {}): Fields {
  return {
    slug,
    title: `T ${slug}`,
    body: `body of ${slug}`,
    status: "exploring",
    tags: [],
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-26T00:00:00Z",
    ...over,
  };
}

function designFields(slug: string, over: Fields = {}): Fields {
  return {
    slug,
    title: `D ${slug}`,
    body: `body of ${slug}`,
    status: "draft",
    tags: [],
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...over,
  };
}

function taskFields(slug: string, over: Fields = {}): Fields {
  return {
    slug,
    title: `Task ${slug}`,
    body: `body of ${slug}`,
    status: "open",
    tags: [],
    design_slug: "",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...over,
  };
}

describe("listCmd --json", () => {
  test("emits a JSON array on stdout with the documented field set", async () => {
    const row = spikeFields("alpha", { tags: ["a", "b"] });
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.spike) {
        return queryResp([asRow("alpha", row)]);
      }
      return queryResp([]);
    }) as unknown as typeof fetch;

    const out: string[] = [];
    const err: string[] = [];
    await listCmd({
      cfg,
      type: "spike",
      json: true,
      print: (l) => out.push(l),
      printErr: (l) => err.push(l),
    });

    // Exactly one stdout line — the JSON document — and it parses.
    expect(out.length).toBe(1);
    const parsed = JSON.parse(out[0]!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      type: "spike",
      slug: "alpha",
      title: "T alpha",
      status: "exploring",
      tags: ["a", "b"],
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-05-26T00:00:00Z",
    });
    // No advisories triggered (well under DEFAULT_LIST_LIMIT).
    expect(err).toEqual([]);
  });

  test("empty result emits `[]`, not 'no records'", async () => {
    globalThis.fetch = (async () => queryResp([])) as unknown as typeof fetch;
    const out: string[] = [];
    const err: string[] = [];
    await listCmd({
      cfg,
      type: "spike",
      json: true,
      print: (l) => out.push(l),
      printErr: (l) => err.push(l),
    });
    expect(out).toEqual(["[]"]);
    expect(JSON.parse(out[0]!)).toEqual([]);
    // Empty brain now also emits the create-your-first hint — on stderr, so
    // stdout stays a clean parseable `[]` for jq pipelines.
    expect(err).toHaveLength(1);
    expect(err[0]).toContain("no records yet");
  });

  test("truncation hint routes to stderr, not stdout", async () => {
    // 25 spike rows, no explicit -n → default cap of 20 trims 5.
    // Under --json the trimmed array goes to stdout and the "K more"
    // advisory MUST go to stderr so jq still sees a clean array.
    const rows = Array.from({ length: 25 }, (_, i) =>
      spikeFields(`slug-${String(i).padStart(2, "0")}`, {
        updated_at: `2026-05-${String(1 + i).padStart(2, "0")}T00:00:00Z`,
      }),
    );
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.spike) {
        return queryResp(rows.map((r) => asRow(String(r.slug), r)));
      }
      return queryResp([]);
    }) as unknown as typeof fetch;

    const out: string[] = [];
    const err: string[] = [];
    await listCmd({
      cfg,
      type: "spike",
      json: true,
      print: (l) => out.push(l),
      printErr: (l) => err.push(l),
    });

    expect(out.length).toBe(1);
    const parsed = JSON.parse(out[0]!);
    expect(parsed).toHaveLength(20);
    // The advisory is on stderr and NOT polluting the JSON document.
    expect(err.length).toBe(1);
    expect(err[0]).toContain("5 more");
    // Sanity: stdout has no human "more" sentinel.
    expect(out[0]).not.toContain("more (use");
  });

  test("design_slug is included for types that carry it", async () => {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.task) {
        return queryResp([
          asRow("t1", taskFields("t1", { design_slug: "auth" })),
        ]);
      }
      return queryResp([]);
    }) as unknown as typeof fetch;

    const out: string[] = [];
    await listCmd({
      cfg,
      type: "task",
      json: true,
      print: (l) => out.push(l),
      printErr: () => {},
    });
    const parsed = JSON.parse(out[0]!);
    expect(parsed[0].design_slug).toBe("auth");
  });
});

describe("getRecord --json", () => {
  test("emits a JSON object on stdout with body included", async () => {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.spike) {
        return queryResp([
          asRow(
            "my-spike",
            spikeFields("my-spike", {
              title: "Hello",
              body: "this is the body",
              tags: ["x", "y"],
            }),
          ),
        ]);
      }
      return queryResp([]);
    }) as unknown as typeof fetch;

    const out: string[] = [];
    await getRecord({
      cfg,
      slug: "my-spike",
      type: "spike",
      json: true,
      print: (l) => out.push(l),
    });

    expect(out.length).toBe(1);
    const parsed = JSON.parse(out[0]!);
    expect(parsed).toEqual({
      type: "spike",
      slug: "my-spike",
      title: "Hello",
      status: "exploring",
      tags: ["x", "y"],
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-05-26T00:00:00Z",
      body: "this is the body",
    });
    // No human-formatted lines like `[spike] my-spike` mixed in.
    expect(out[0]).not.toContain("[spike]");
    expect(out[0]).not.toContain("title:");
  });

  test("task with live design link surfaces design_slug without design_missing", async () => {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.task) {
        return queryResp([
          asRow("child", taskFields("child", { design_slug: "live-design" })),
        ]);
      }
      if (body.schema_name === TEST_HASHES.design) {
        return queryResp([asRow("live-design", designFields("live-design"))]);
      }
      return queryResp([]);
    }) as unknown as typeof fetch;

    const out: string[] = [];
    await getRecord({
      cfg,
      slug: "child",
      type: "task",
      json: true,
      print: (l) => out.push(l),
    });
    const parsed = JSON.parse(out[0]!);
    expect(parsed.design_slug).toBe("live-design");
    expect(parsed.design_missing).toBeUndefined();
  });

  test("task with dangling design link flags design_missing: true", async () => {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.task) {
        return queryResp([
          asRow(
            "orphan",
            taskFields("orphan", { design_slug: "gone-design" }),
          ),
        ]);
      }
      return queryResp([]);
    }) as unknown as typeof fetch;

    const out: string[] = [];
    await getRecord({
      cfg,
      slug: "orphan",
      type: "task",
      json: true,
      print: (l) => out.push(l),
    });
    const parsed = JSON.parse(out[0]!);
    expect(parsed.design_slug).toBe("gone-design");
    expect(parsed.design_missing).toBe(true);
  }, 30_000);

  test("design carries `children: [{slug, status}]` for its tasks", async () => {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.design) {
        return queryResp([asRow("auth", designFields("auth"))]);
      }
      if (body.schema_name === TEST_HASHES.task) {
        return queryResp([
          asRow(
            "wire-oauth",
            taskFields("wire-oauth", {
              design_slug: "auth",
              status: "in_progress",
              updated_at: "2026-05-02T00:00:00Z",
            }),
          ),
          asRow(
            "login-ui",
            taskFields("login-ui", {
              design_slug: "auth",
              status: "open",
              updated_at: "2026-05-03T00:00:00Z",
            }),
          ),
        ]);
      }
      return queryResp([]);
    }) as unknown as typeof fetch;

    const out: string[] = [];
    await getRecord({
      cfg,
      slug: "auth",
      type: "design",
      json: true,
      print: (l) => out.push(l),
    });
    const parsed = JSON.parse(out[0]!);
    // login-ui has the newer updated_at, so it sorts first.
    expect(parsed.children).toEqual([
      { slug: "login-ui", status: "open" },
      { slug: "wire-oauth", status: "in_progress" },
    ]);
  });
});

type MockResponse = { status: number; body?: unknown };

function installSequencedMock(
  handler: (url: string, init?: RequestInit) => MockResponse,
): void {
  globalThis.fetch = (async (
    input: unknown,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    const next = handler(url, init);
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

function hit(opts: {
  slug: string;
  schemaName: string;
  score?: number;
  schema_display_name?: string | null;
}) {
  return {
    schema_name: opts.schemaName,
    schema_display_name: opts.schema_display_name ?? null,
    field: "body",
    key_value: { hash: opts.slug, range: null },
    value: "fragment text",
    metadata: { score: opts.score ?? 0.5, match_type: "semantic" },
  };
}

describe("searchCmd --json", () => {
  test("emits a JSON array of {slug, score, type, title, snippet, confidence} hits", async () => {
    const recordRow = {
      fields: {
        slug: "alpha",
        title: "Alpha design",
        body: "blueberry octopus",
        status: "draft",
        tags: [],
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
              hit({
                slug: "alpha",
                schemaName: TEST_HASHES.design,
                schema_display_name: "Design",
                score: 0.6,
              }),
            ],
            user_hash: cfg.userHash,
          },
        };
      }
      if (url.includes("/api/query")) {
        return {
          status: 200,
          body: {
            ok: true,
            results: [recordRow],
            total_count: 1,
            returned_count: 1,
          },
        };
      }
      return { status: 404, body: { error: "unknown" } };
    });
    const out: string[] = [];
    const err: string[] = [];
    await searchCmd({
      cfg,
      query: "blueberry",
      json: true,
      print: (l) => out.push(l),
      printErr: (l) => err.push(l),
    });
    expect(out.length).toBe(1);
    const parsed = JSON.parse(out[0]!);
    expect(parsed).toEqual([
      {
        slug: "alpha",
        score: 0.6,
        type: "design",
        title: "Alpha design",
        // Body "blueberry octopus" with query "blueberry" → the snippet is the
        // (short) whole body, surfacing the answer inline in the JSON document.
        snippet: "blueberry octopus",
        confidence: "strong",
      },
    ]);
    // 0.6 clears the STRONG_SCORE ceiling — a real hit, so no weak-match
    // advisory. (The point of this test is JSON-stdout purity: any advisory
    // that did fire would land on stderr, never in the parseable document.)
    expect(err).toEqual([]);
    // Sanity: no human table padding in the JSON document.
    expect(out[0]).not.toContain("0.600");
    expect(out[0]).not.toContain("Alpha design  ");
  });

  test("empty result on a populated brain emits `[]` on stdout; latency hint moves to stderr", async () => {
    // The brain HOLDS records (the empty-brain probe sees a live row), so a
    // no-match query keeps the fresh-write-latency / `fbrain ask` hint — and
    // that hint must stay on stderr so stdout is a clean `[]` for jq.
    const liveRow = {
      fields: {
        slug: "an-existing-record",
        title: "Already here",
        body: "unrelated body",
        status: "draft",
        tags: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      key: { hash: "an-existing-record", range: null },
    };
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        return {
          status: 200,
          body: { ok: true, results: [], user_hash: cfg.userHash },
        };
      }
      if (url.includes("/api/query")) {
        return { status: 200, body: { ok: true, results: [liveRow] } };
      }
      return { status: 200, body: { ok: true, results: [] } };
    });
    const out: string[] = [];
    const err: string[] = [];
    await searchCmd({
      cfg,
      query: "ghost",
      json: true,
      print: (l) => out.push(l),
      printErr: (l) => err.push(l),
    });
    expect(out).toEqual(["[]"]);
    expect(JSON.parse(out[0]!)).toEqual([]);
    // The empty-result hint stays useful for interactive users — pin it
    // to stderr so it doesn't pollute jq.
    expect(err.length).toBe(1);
    expect(err[0]).toContain("fbrain ask <query>");
  });

  test("rounds the score to 6 decimals; perfect f32 cosine serializes as 1, not 1.0000001192092896", async () => {
    // The native index ships cosines as f32 and the node promotes back to
    // f64 on the wire, so a perfect match arrives as 1.0000001192092896
    // (= f32(1.0)). Left raw, a consumer filtering on the natural cosine
    // contract `score <= 1.0` silently drops the single best hit. Pin
    // both the >1.0 bug and the 6-dp noise strip.
    const rows = [
      {
        fields: {
          slug: "perfect",
          title: "Exact match",
          body: "",
          status: "draft",
          tags: [],
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
        key: { hash: "perfect", range: null },
      },
      {
        fields: {
          slug: "noisy",
          title: "Sub-1 match",
          body: "",
          status: "draft",
          tags: [],
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
        key: { hash: "noisy", range: null },
      },
    ];
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        return {
          status: 200,
          body: {
            ok: true,
            results: [
              hit({
                slug: "perfect",
                schemaName: TEST_HASHES.design,
                schema_display_name: "Design",
                score: 1.0000001192092896,
              }),
              hit({
                slug: "noisy",
                schemaName: TEST_HASHES.design,
                schema_display_name: "Design",
                score: 0.3730545341968536,
              }),
            ],
            user_hash: cfg.userHash,
          },
        };
      }
      if (url.includes("/api/query")) {
        return {
          status: 200,
          body: {
            ok: true,
            results: rows,
            total_count: rows.length,
            returned_count: rows.length,
          },
        };
      }
      return { status: 404, body: { error: "unknown" } };
    });
    const out: string[] = [];
    const err: string[] = [];
    await searchCmd({
      cfg,
      query: "exact",
      json: true,
      print: (l) => out.push(l),
      printErr: (l) => err.push(l),
    });
    expect(out.length).toBe(1);
    const parsed = JSON.parse(out[0]!) as Array<{ slug: string; score: number }>;
    expect(parsed).toHaveLength(2);
    const perfect = parsed.find((p) => p.slug === "perfect")!;
    const noisy = parsed.find((p) => p.slug === "noisy")!;
    // The bug: raw f32-promoted-to-f64 exceeds the cosine contract.
    expect(perfect.score).toBe(1);
    expect(perfect.score).toBeLessThanOrEqual(1);
    // 6-decimal rounding strips the 17-digit float noise.
    expect(noisy.score).toBe(0.373055);
    // Raw value must NOT appear in the serialized document.
    expect(out[0]).not.toContain("1.0000001192092896");
    expect(out[0]).not.toContain("0.3730545341968536");
  });

  test("preserves a null score as null (not 0) under --json", async () => {
    // `hit.score` is `number | null` (search.ts:56,146). A score-less hit
    // must round-trip as JSON null, not collapse to 0 via the rounding path.
    const recordRow = {
      fields: {
        slug: "no-score",
        title: "Unscored",
        body: "",
        status: "draft",
        tags: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      key: { hash: "no-score", range: null },
    };
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        return {
          status: 200,
          body: {
            ok: true,
            results: [
              {
                schema_name: TEST_HASHES.design,
                schema_display_name: "Design",
                field: "body",
                key_value: { hash: "no-score", range: null },
                value: "fragment text",
                // No `score` key — metadata.score is undefined, so
                // search.ts:146 routes through to `score: null`.
                metadata: { match_type: "semantic" },
              },
            ],
            user_hash: cfg.userHash,
          },
        };
      }
      if (url.includes("/api/query")) {
        return {
          status: 200,
          body: {
            ok: true,
            results: [recordRow],
            total_count: 1,
            returned_count: 1,
          },
        };
      }
      return { status: 404, body: {} };
    });
    const out: string[] = [];
    const err: string[] = [];
    await searchCmd({
      cfg,
      query: "anything",
      json: true,
      print: (l) => out.push(l),
      printErr: (l) => err.push(l),
    });
    const parsed = JSON.parse(out[0]!) as Array<{ slug: string; score: number | null }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.score).toBeNull();
  });

  test("weak top score routes the `note:` advisory to stderr", async () => {
    // Score < 0.35 triggers the weak-match note. Under --json that
    // advisory must NOT contaminate the stdout JSON document.
    const recordRow = {
      fields: {
        slug: "weak",
        title: "Distant match",
        body: "",
        status: "draft",
        tags: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      key: { hash: "weak", range: null },
    };
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        return {
          status: 200,
          body: {
            ok: true,
            results: [
              hit({
                slug: "weak",
                schemaName: TEST_HASHES.design,
                schema_display_name: "Design",
                score: 0.2,
              }),
            ],
            user_hash: cfg.userHash,
          },
        };
      }
      if (url.includes("/api/query")) {
        return {
          status: 200,
          body: {
            ok: true,
            results: [recordRow],
            total_count: 1,
            returned_count: 1,
          },
        };
      }
      return { status: 404, body: {} };
    });
    const out: string[] = [];
    const err: string[] = [];
    await searchCmd({
      cfg,
      query: "gibberish",
      json: true,
      print: (l) => out.push(l),
      printErr: (l) => err.push(l),
    });
    expect(out.length).toBe(1);
    const parsed = JSON.parse(out[0]!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].score).toBe(0.2);
    expect(parsed[0].type).toBe("design");
    // Note went to stderr, NOT stdout.
    expect(err.length).toBe(1);
    expect(err[0]).toContain("no strong matches");
    expect(out[0]).not.toContain("note:");
  });
});

describe("statusCmd --json (show mode)", () => {
  function installShowMock(slug: string, fields: Fields, schema: string) {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === schema) {
        return queryResp([asRow(slug, fields)]);
      }
      return queryResp([]);
    }) as unknown as typeof fetch;
  }

  test("emits a single `{slug, type, status}` object on stdout", async () => {
    installShowMock(
      "my-task",
      taskFields("my-task", { status: "in_progress" }),
      TEST_HASHES.task,
    );
    const out: string[] = [];
    await statusCmd({
      cfg,
      slug: "my-task",
      type: "task",
      json: true,
      print: (l) => out.push(l),
    });
    expect(out.length).toBe(1);
    const parsed = JSON.parse(out[0]!);
    expect(parsed).toEqual({
      slug: "my-task",
      type: "task",
      status: "in_progress",
    });
    // No human bare-word leakage — the object, not just `in_progress`.
    expect(out[0]).not.toBe("in_progress");
  });

  test("without --json still prints the bare status word", async () => {
    installShowMock(
      "my-task",
      taskFields("my-task", { status: "open" }),
      TEST_HASHES.task,
    );
    const out: string[] = [];
    await statusCmd({
      cfg,
      slug: "my-task",
      type: "task",
      print: (l) => out.push(l),
    });
    expect(out).toEqual(["open"]);
  });
});
