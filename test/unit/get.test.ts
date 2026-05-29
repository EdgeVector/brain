// Unit tests for `fbrain get` — focused on the dangling-design annotation.
//
// A task's design_slug is validated on write (`task new --design` / `link`),
// so a reference that no longer resolves to a live design means the design
// was deleted out from under the task. `get` surfaces that by tagging the
// `design:` line with "(deleted)" instead of printing a live-looking pointer.

import { afterEach, describe, expect, test } from "bun:test";

import { getRecord } from "../../src/commands/get.ts";
import { TEST_HASHES, buildTestCfg } from "../util.ts";

const cfg = buildTestCfg({ userHash: "uh" });

type RowFields = Record<string, unknown>;

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

function asRow(slug: string, fields: RowFields) {
  return { fields, key: { hash: slug, range: null } };
}

function taskFields(slug: string, over: RowFields = {}): RowFields {
  return {
    slug,
    title: "T",
    body: "",
    status: "open",
    tags: [],
    design_slug: "",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...over,
  };
}

function designFields(slug: string): RowFields {
  return {
    slug,
    title: "D",
    body: "",
    status: "draft",
    tags: [],
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
  };
}

describe("getRecord — dangling design reference", () => {
  test("marks the design line '(deleted)' when the referenced design is gone", async () => {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.task) {
        return queryResp([asRow("orphan", taskFields("orphan", { design_slug: "gone-design" }))]);
      }
      // design schema (and the existence probe) return nothing — the parent is gone.
      return queryResp([]);
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    await getRecord({ cfg, slug: "orphan", type: "task", print: (l) => lines.push(l) });
    expect(lines.join("\n")).toContain("design:     gone-design (deleted)");
  }, 30_000);

  test("leaves the design line clean when the referenced design is still live", async () => {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.task) {
        return queryResp([asRow("child", taskFields("child", { design_slug: "live-design" }))]);
      }
      if (body.schema_name === TEST_HASHES.design) {
        return queryResp([asRow("live-design", designFields("live-design"))]);
      }
      return queryResp([]);
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    await getRecord({ cfg, slug: "child", type: "task", print: (l) => lines.push(l) });
    const out = lines.join("\n");
    expect(out).toContain("design:     live-design");
    expect(out).not.toContain("(deleted)");
  });

  test("a task with no design reference prints '(none)' and probes no design", async () => {
    let designProbes = 0;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.task) {
        return queryResp([asRow("freestanding", taskFields("freestanding"))]);
      }
      if (body.schema_name === TEST_HASHES.design) designProbes++;
      return queryResp([]);
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    await getRecord({ cfg, slug: "freestanding", type: "task", print: (l) => lines.push(l) });
    expect(lines.join("\n")).toContain("design:     (none)");
    expect(designProbes).toBe(0);
  });
});
