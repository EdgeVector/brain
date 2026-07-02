import { afterEach, describe, expect, test } from "bun:test";

import { backlinksCmd } from "../../src/commands/backlinks.ts";
import { TEST_HASHES, buildTestCfg } from "../util.ts";

const cfg = buildTestCfg({ userHash: "uh" });
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

function row(slug: string, fields: Record<string, unknown>) {
  return { fields, key: { hash: slug, range: null } };
}

function base(slug: string, over: Record<string, unknown> = {}) {
  return {
    slug,
    title: slug,
    body: "",
    status: "active",
    tags: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("backlinksCmd", () => {
  test("returns explicit legacy, explicit generic, and body wiki backlinks", async () => {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.task) {
        return queryResp([
          row("task-edge", {
            ...base("task-edge", { status: "open" }),
            design_slug: "target",
          }),
        ]);
      }
      if (body.schema_name === TEST_HASHES.concept) {
        return queryResp([
          row("concept-edge", {
            ...base("concept-edge"),
            tags: ["link:design:target"],
          }),
        ]);
      }
      if (body.schema_name === TEST_HASHES.reference) {
        return queryResp([
          row("dangling-note", {
            ...base("dangling-note", { status: "broken" }),
            body: "Still intends to reference [[target]] later.",
          }),
        ]);
      }
      return queryResp([]);
    }) as unknown as typeof fetch;

    let captured: unknown;
    const lines: string[] = [];
    await backlinksCmd({
      cfg,
      slug: "target",
      type: "design",
      print: (l) => lines.push(l),
      onResult: (json) => {
        captured = json;
      },
    });

    expect(lines.join("\n")).toContain("backlinks for design target:");
    expect(captured).toMatchObject({
      slug: "target",
      type: "design",
      linked_from: [
        { type: "concept", slug: "concept-edge", via: ["explicit"] },
        { type: "reference", slug: "dangling-note", via: ["body"] },
        { type: "task", slug: "task-edge", via: ["explicit"] },
      ],
    });
  });

  test("keeps dangling wiki-link intent queryable without a target record", async () => {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.reference) {
        return queryResp([
          row("future-note", {
            ...base("future-note"),
            body: "Create [[future-target]] when the design settles.",
          }),
        ]);
      }
      return queryResp([]);
    }) as unknown as typeof fetch;

    let captured: unknown;
    await backlinksCmd({
      cfg,
      slug: "future-target",
      onResult: (json) => {
        captured = json;
      },
      print: () => {},
    });

    expect(captured).toMatchObject({
      slug: "future-target",
      linked_from: [{ type: "reference", slug: "future-note", via: ["body"] }],
    });
  });
});
