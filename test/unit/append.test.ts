// Unit tests for `fbrain append <slug>` — the body-append primitive that grows
// a record without a full rewrite (the third leg of the read/write asymmetry
// fix). Covers the pure separator policy (`appendBody`) and the command's
// read-modify-write against a mocked node.

import { afterEach, describe, expect, test } from "bun:test";

import { appendBody, appendCmd } from "../../src/commands/append.ts";
import { FbrainError } from "../../src/client.ts";
import { buildTestCfg, TEST_HASHES } from "../util.ts";

const cfg = buildTestCfg({
  userHash: "uh",
  schemaHashes: { ...TEST_HASHES, concept: "concepthash" },
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type RowFields = Record<string, unknown>;
function conceptRow(slug: string, over: Partial<RowFields> = {}): RowFields {
  return {
    slug,
    title: "T",
    body: "existing body",
    status: "active",
    tags: ["k"],
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...over,
  };
}

describe("appendBody (separator policy)", () => {
  test("empty existing body seeds it byte-exact (no separator)", () => {
    expect(appendBody("", "hello", false)).toBe("hello");
  });

  test("non-empty body gets a blank-line separator by default", () => {
    expect(appendBody("para one", "para two", false)).toBe("para one\n\npara two");
  });

  test("body ending in a single newline gets one more (→ blank line)", () => {
    expect(appendBody("para one\n", "para two", false)).toBe("para one\n\npara two");
  });

  test("body already ending in a blank line gets NO extra separator", () => {
    expect(appendBody("para one\n\n", "para two", false)).toBe("para one\n\npara two");
  });

  test("raw mode concatenates byte-exact regardless of trailing whitespace", () => {
    expect(appendBody("para one", "para two", true)).toBe("para onepara two");
    expect(appendBody("", "x", true)).toBe("x");
  });
});

describe("appendCmd", () => {
  test("appends to the existing body and writes back preserving other fields", async () => {
    const captured: { update?: Record<string, unknown> } = {};
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/api/query")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.schema_name !== cfg.schemaHashes.concept) {
          return new Response(JSON.stringify({ ok: true, results: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            ok: true,
            results: [{ fields: conceptRow("note"), key: { hash: "note", range: null } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/api/mutation")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.mutation_type === "update") captured.update = body;
        return new Response(JSON.stringify({ ok: true, success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    const results: unknown[] = [];
    const lines: string[] = [];
    await appendCmd({
      cfg,
      slug: "note",
      chunk: "appended line",
      type: "concept",
      print: (l) => lines.push(l),
      onResult: (r) => results.push(r),
    });

    // The update mutation lands the GROWN body, keyed on the trimmed slug.
    expect(captured.update).toBeDefined();
    const fields = (captured.update!.fields_and_values ?? captured.update!.fields) as
      | Record<string, unknown>
      | undefined;
    expect(fields?.body).toBe("existing body\n\nappended line");
    // Non-body fields preserved.
    expect(fields?.title).toBe("T");
    expect(fields?.status).toBe("active");

    // Structured result reports growth (never shrinks).
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      action: "appended",
      type: "concept",
      slug: "note",
      oldBodyChars: "existing body".length,
    });
    expect(lines[0]).toContain("appended");
  });

  test("empty chunk is rejected with empty_append (nothing to append)", async () => {
    await expect(
      appendCmd({ cfg, slug: "note", chunk: "", type: "concept" }),
    ).rejects.toThrow(FbrainError);
  });
});
