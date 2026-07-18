// Cost-bound tests for the no-match / miss paths (card
// fbrain-cheap-no-match-paths, teardown 2026-07-05 finding 11).
//
// Before this card, rendering a one-line hint on a no-match path could pull
// large fractions of the corpus:
//   - `hasAnyLiveRecord` (the empty-brain probe behind the search/ask/list
//     no-result hints) ran a fully-paginated `queryAll` per schema hash with
//     ALL fields including `body`.
//   - the MCP `fbrain_get` miss enrichment listed EVERY record of every type
//     (full fields, full pagination) to fuzzy-rank nearest slugs.
//   - `fbrain link`'s wrong-type error decoration fanned out a lookup per
//     record type, re-issuing identical queries for types sharing a schema
//     hash.
//
// These tests pin the cheap contract with a mock transport that records every
// /api/query request body: each no-match path completes within ONE small
// query per schema (slug+tags projection, capped limit, offset 0, and NO
// second page even when the node claims `has_more: true`), while the
// user-facing hint text stays byte-identical.

import { afterEach, describe, expect, test } from "bun:test";

import { newReadClientFromCfg, FbrainError } from "../../src/client.ts";
import {
  hasAnyLiveRecord,
  NO_MATCH_PROBE_PAGE_LIMIT,
  TOMBSTONE_TAG,
} from "../../src/record.ts";
import { listCmd } from "../../src/commands/list.ts";
import { linkCmd } from "../../src/commands/link.ts";
import { createFbrainMcpServer } from "../../src/mcp/server.ts";
import { RECORD_TYPES } from "../../src/schemas.ts";
import { buildTestCfg, TEST_HASHES } from "../util.ts";

const cfg = buildTestCfg({ userHash: "uh" });

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

// One recorded /api/query request. `keyed` marks a point-read (a `filter`
// body member — `queryByKey`'s HashKey lookup); unkeyed calls are page scans.
type QueryCall = {
  schema: string;
  fields: string[];
  limit: number | undefined;
  offset: number | undefined;
  keyed: boolean;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Stub `globalThis.fetch`, recording every /api/query request body and
// answering each from `respond`. Non-query endpoints get harmless OKs.
function installQueryMock(respond: (call: QueryCall) => unknown): {
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    if (url.endsWith("/api/query")) {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
      } catch {
        // fall through with the empty body
      }
      const call: QueryCall = {
        schema: String(body.schema_name ?? ""),
        fields: Array.isArray(body.fields) ? body.fields.map(String) : [],
        limit: typeof body.limit === "number" ? body.limit : undefined,
        offset: typeof body.offset === "number" ? body.offset : undefined,
        keyed: body.filter !== undefined,
      };
      calls.push(call);
      return jsonResponse(respond(call));
    }
    return jsonResponse({ ok: true });
  }) as unknown as typeof fetch;
  return { calls };
}

function row(slug: string, over: Record<string, unknown> = {}) {
  return {
    fields: {
      slug,
      title: `T ${slug}`,
      body: "B",
      status: "draft",
      tags: [],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      ...over,
    },
    key: { hash: slug, range: null },
  };
}

// A page response that CLAIMS more data exists. A cost-bounded caller must
// never come back for the second page; a paginating caller would.
function pageWithMore(rows: unknown[], totalCount = 5000) {
  return {
    ok: true,
    results: rows,
    total_count: totalCount,
    returned_count: rows.length,
    has_more: true,
  };
}

function emptyPage() {
  return { ok: true, results: [], total_count: 0, returned_count: 0 };
}

const ALL_HASHES = RECORD_TYPES.map((t) => TEST_HASHES[t]);

describe("hasAnyLiveRecord — single small page per schema", () => {
  test("live row on the first schema: ONE slug+tags query total, no second page", async () => {
    const { calls } = installQueryMock(() => pageWithMore([row("alive")]));
    const node = newReadClientFromCfg(cfg);
    await expect(hasAnyLiveRecord(node, cfg)).resolves.toBe(true);
    // Short-circuits on the first live row: exactly one /api/query in total,
    // even though the node reported has_more=true with a 5000 total_count.
    expect(calls).toHaveLength(1);
    const probe = calls[0]!;
    expect(probe.fields.sort()).toEqual(["slug", "tags"]);
    expect(probe.fields).not.toContain("body");
    expect(probe.limit).toBe(NO_MATCH_PROBE_PAGE_LIMIT);
    expect(probe.offset).toBe(0);
    expect(probe.keyed).toBe(false);
  });

  test("empty brain: exactly one small page per schema hash, never paginated", async () => {
    // Every schema answers with a tombstone-only page that claims more rows
    // exist — the probe must take the single page as its sample and move on,
    // not loop pagination per schema.
    const { calls } = installQueryMock(() =>
      pageWithMore([row("gone", { tags: [TOMBSTONE_TAG] })], 5000),
    );
    const node = newReadClientFromCfg(cfg);
    await expect(hasAnyLiveRecord(node, cfg)).resolves.toBe(false);
    expect(calls).toHaveLength(ALL_HASHES.length);
    const seen = new Set<string>();
    for (const c of calls) {
      expect(seen.has(c.schema)).toBe(false); // one call per schema hash
      seen.add(c.schema);
      expect(c.fields).not.toContain("body");
      expect(c.limit).toBe(NO_MATCH_PROBE_PAGE_LIMIT);
    }
    expect(seen).toEqual(new Set(ALL_HASHES));
  });
});

describe("list --status no-match — probe cost + unchanged hint", () => {
  test("populated brain: probe adds one small body-less query; hint text identical", async () => {
    // Every type holds one live row whose status doesn't match the filter.
    // Post-keys-first-fix (this card), the SWEEP itself is now also
    // body-less — a --status list no longer needs `listRecords`' full-field
    // fetch either, only `listRecordKeys`' skinny projection. So the sweep
    // and the empty-brain probe are distinguished by `limit`
    // (QUERY_PAGE_SIZE=1000 for the sweep vs NO_MATCH_PROBE_PAGE_LIMIT=100
    // for the probe), not by a `body` field neither call ever requests
    // anymore.
    const { calls } = installQueryMock((call) => {
      if (call.limit === NO_MATCH_PROBE_PAGE_LIMIT) {
        // The probe: a live row, with has_more bait — a cost-bounded probe
        // must never chase it.
        return pageWithMore([row("r1", { status: "open" })]);
      }
      // The keys-first sweep: one full page per type, no further pages —
      // unlike the probe, a real sweep must actually finish.
      return { ok: true, results: [row("r1", { status: "open" })], total_count: 1, returned_count: 1 };
    });
    const lines: string[] = [];
    await listCmd({
      cfg,
      status: "nonexistent",
      print: (l) => lines.push(l),
    });

    // Hint text is byte-identical to the pre-card output.
    expect(lines).toEqual([
      "no records",
      "hint:  no records match that filter — try `fbrain list` with no --type/--status/--tag",
    ]);

    const sweepCalls = calls.filter((c) => c.limit !== NO_MATCH_PROBE_PAGE_LIMIT);
    const probeCalls = calls.filter((c) => c.limit === NO_MATCH_PROBE_PAGE_LIMIT);
    // One sweep query per type (the retry stops on the first attempt because
    // live rows are visible), then ONE probe query total.
    expect(sweepCalls).toHaveLength(RECORD_TYPES.length);
    for (const c of sweepCalls) {
      // The keys-first fix: never a title/body fetch for a bounded/filtered
      // list, only the skinny slug/tags/updated_at/status projection.
      expect(c.fields).not.toContain("body");
      expect(c.fields).not.toContain("title");
    }
    expect(probeCalls).toHaveLength(1);
    expect(probeCalls[0]!.fields.sort()).toEqual(["slug", "tags"]);
    expect(probeCalls[0]!.limit).toBe(NO_MATCH_PROBE_PAGE_LIMIT);
    expect(probeCalls[0]!.offset).toBe(0);
  });

  test("agent-channel empty-brain hint unchanged, one probe page per schema", async () => {
    const { calls } = installQueryMock(() => emptyPage());
    const lines: string[] = [];
    await listCmd({
      cfg,
      status: "nonexistent",
      agent: true,
      print: (l) => lines.push(l),
    });
    expect(lines).toEqual([
      "no records",
      "hint:  no records yet — create your first with the `fbrain_put` tool, then try again",
    ]);
    // Filtered (keys-only) sweep retries its budget on a genuinely-empty
    // brain (existing behavior, unchanged); the probe itself is bounded to
    // one small page per schema hash. Distinguish sweep vs. probe by
    // `limit` — this card's fix means the sweep is body-less too, so a
    // `body`-field check can no longer tell them apart.
    const probeCalls = calls.filter((c) => c.limit === NO_MATCH_PROBE_PAGE_LIMIT);
    expect(probeCalls).toHaveLength(ALL_HASHES.length);
    for (const c of probeCalls) {
      expect(c.limit).toBe(NO_MATCH_PROBE_PAGE_LIMIT);
      expect(c.fields).not.toContain("body");
    }
    const sweepCalls = calls.filter((c) => c.limit !== NO_MATCH_PROBE_PAGE_LIMIT);
    expect(sweepCalls.length).toBeGreaterThan(0);
    for (const c of sweepCalls) {
      expect(c.fields).not.toContain("body");
    }
  });
});

type ToolCallback = (
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;

function toolsOf(server: ReturnType<typeof createFbrainMcpServer>): Record<string, ToolCallback> {
  const map = (server as unknown as { _registeredTools: Record<string, { handler: ToolCallback }> })
    ._registeredTools;
  const out: Record<string, ToolCallback> = {};
  for (const [name, t] of Object.entries(map)) out[name] = t.handler;
  return out;
}

describe("MCP fbrain_get miss — candidate scan cost + unchanged hint", () => {
  test("typed miss: two keyed lookups + one small candidate page, hint identical", async () => {
    const { calls } = installQueryMock((call) => {
      if (call.keyed) return emptyPage(); // the get lookup: slug not found
      // Candidate scan: rows plus has_more bait — the enrichment must take
      // its sample from this single page.
      return pageWithMore([
        row("deployment-rollback-decision"),
        row("deploy-runbook"),
        row("billing-cleanup"),
        row("release-gate"),
      ]);
    });
    const tools = toolsOf(createFbrainMcpServer({ cfg }));
    const res = await tools.fbrain_get!({
      slug: "deployment-rolback-decision",
      type: "design",
    });
    expect(res.isError).toBe(true);
    const text = res.content[0]!.text ?? "";
    expect(text).toContain("No design: deployment-rolback-decision");
    expect(text).toContain("Nearest candidate slugs");
    expect(text).toContain("deployment-rollback-decision");
    expect(text).toContain("deploy-runbook");

    // Exactly three design-schema queries: the keyed point-read miss, one
    // normalized separator/case point-read retry, then ONE bounded slug+tags
    // page for the fuzzy candidates. No full-field listing, no pagination.
    const designCalls = calls.filter((c) => c.schema === TEST_HASHES.design);
    expect(designCalls).toHaveLength(3);
    expect(calls).toHaveLength(3); // no other schema touched on a typed miss
    expect(designCalls.filter((c) => c.keyed)).toHaveLength(2);
    const scan = designCalls.find((c) => !c.keyed)!;
    expect(scan.fields.sort()).toEqual(["slug", "tags"]);
    expect(scan.fields).not.toContain("body");
    expect(scan.limit).toBe(NO_MATCH_PROBE_PAGE_LIMIT);
    expect(scan.offset).toBe(0);
  });

  test("untyped miss: at most two keyed lookups + one small page per type", async () => {
    const { calls } = installQueryMock((call) => {
      if (call.keyed) return emptyPage();
      if (call.schema === TEST_HASHES.design) {
        return pageWithMore([row("alpha-beta")]);
      }
      return pageWithMore([]);
    });
    const tools = toolsOf(createFbrainMcpServer({ cfg }));
    const res = await tools.fbrain_get!({ slug: "alpha-betaa" });
    expect(res.isError).toBe(true);
    const text = res.content[0]!.text ?? "";
    expect(text).toContain("Nearest candidate slugs: alpha-beta (design)");

    // Per schema: one keyed resolve miss, one normalized keyed retry, and one
    // bounded candidate page — never more, even with has_more=true on every
    // page response.
    for (const hash of ALL_HASHES) {
      const perSchema = calls.filter((c) => c.schema === hash);
      expect(perSchema).toHaveLength(3);
      const keyed = perSchema.filter((c) => c.keyed);
      const scans = perSchema.filter((c) => !c.keyed);
      expect(keyed).toHaveLength(2);
      expect(scans).toHaveLength(1);
      expect(scans[0]!.fields).not.toContain("body");
      expect(scans[0]!.limit).toBe(NO_MATCH_PROBE_PAGE_LIMIT);
    }
    expect(calls).toHaveLength(ALL_HASHES.length * 3);
  });
});

describe("link wrong-type decoration — deduped, early-exit, single-attempt", () => {
  test("stops probing at the first hit; untouched types are never queried", async () => {
    // Task t1 exists; link target "c1" is not a design but IS a concept.
    const { calls } = installQueryMock((call) => {
      if (call.schema === TEST_HASHES.task && call.keyed) {
        // First keyed task call resolves t1; the decoration's later probe
        // for "c1" on the task schema misses.
        const key = calls.filter((c) => c.schema === TEST_HASHES.task && c.keyed).length;
        return key === 1
          ? { ok: true, results: [row("t1", { status: "open", design_slug: "" })] }
          : emptyPage();
      }
      if (call.schema === TEST_HASHES.concept) {
        return { ok: true, results: [row("c1")] };
      }
      return emptyPage();
    });
    let err: unknown;
    try {
      await linkCmd({ cfg, taskSlug: "t1", designSlug: "c1", print: () => {} });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FbrainError);
    const fe = err as FbrainError;
    expect(fe.code).toBe("dangling_design_slug");
    // Message and hint text unchanged.
    expect(fe.message).toBe("'c1' is a concept, not a design.");
    expect(fe.hint).toBe(
      "Pick a design (`fbrain list --type design`), or create one with `fbrain design new <slug>`.",
    );
    // Early exit: the probe walks task → concept (RECORD_TYPES order minus
    // the design target) and stops on the concept hit. The seven remaining
    // types are never queried.
    for (const t of ["preference", "reference", "agent", "project", "spike", "sop", "decision"] as const) {
      expect(calls.filter((c) => c.schema === TEST_HASHES[t])).toHaveLength(0);
    }
    // Total: t1 lookup + c1-as-design lookup + task probe + concept probe.
    expect(calls).toHaveLength(4);
    for (const c of calls) expect(c.keyed).toBe(true); // all single-attempt point-reads
  });

  test("types sharing a schema hash are probed once, not once per type", async () => {
    // Give the six MEMO-envelope types one shared hash: the decoration must
    // issue ONE probe for that hash instead of six identical lookups.
    const MEMO_HASH = "b".repeat(64);
    const sharedCfg = buildTestCfg({
      userHash: "uh",
      schemaHashes: {
        design: TEST_HASHES.design,
        task: TEST_HASHES.task,
        concept: MEMO_HASH,
        preference: MEMO_HASH,
        reference: MEMO_HASH,
        agent: MEMO_HASH,
        project: MEMO_HASH,
        spike: MEMO_HASH,
        sop: MEMO_HASH,
        decision: TEST_HASHES.decision,
      },
    });
    const { calls } = installQueryMock((call) => {
      if (call.schema === TEST_HASHES.task && call.keyed) {
        const key = calls.filter((c) => c.schema === TEST_HASHES.task && c.keyed).length;
        return key === 1
          ? { ok: true, results: [row("t1", { status: "open", design_slug: "" })] }
          : emptyPage();
      }
      return emptyPage(); // "ghost" resolves nowhere
    });
    let err: unknown;
    try {
      await linkCmd({ cfg: sharedCfg, taskSlug: "t1", designSlug: "ghost", print: () => {} });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FbrainError);
    const fe = err as FbrainError;
    expect(fe.code).toBe("dangling_design_slug");
    expect(fe.message).toBe("No design: ghost");
    // The shared MEMO hash is probed exactly once for the whole 7-type group.
    expect(calls.filter((c) => c.schema === MEMO_HASH)).toHaveLength(1);
    // Full miss decoration: t1 lookup + ghost-as-design + probes over the
    // unique non-design hashes (task, memo, decision) = 5 keyed point-reads.
    expect(calls).toHaveLength(5);
  });
});
