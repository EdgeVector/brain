// Unit tests for `fbrain status <slug> [<new-status>]`.
//
// Pins the key-normalization parity with put/delete/link. A record stored
// under slug "foo" (because `put " foo "` trimmed) must be reachable from
// `fbrain status " foo " in_progress` — pre-fix, the read path resolved
// via the resolver (which trims) but the update path used the UNTRIMMED
// input as keyHash, so the mutation landed on a different key from the
// row the user just saw and the status silently failed to stick.

import { describe, expect, test } from "bun:test";

import { statusCmd } from "../../src/commands/status.ts";
import { buildTestCfg, TEST_HASHES } from "../util.ts";

const cfg = buildTestCfg({
  userHash: "uh",
  schemaHashes: {
    ...TEST_HASHES,
    design: "designhash",
    task: "taskhash",
  },
});

type RowFields = Record<string, unknown>;

function taskRow(slug: string, over: Partial<RowFields> = {}): RowFields {
  return {
    slug,
    title: "Tt",
    body: "Bt",
    status: "open",
    tags: [],
    design_slug: "",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...over,
  };
}

describe("statusCmd — slug whitespace trim (parity with put/delete/link)", () => {
  test("`status \" foo \" in_progress` updates the row stored under \"foo\" (mutation lands on trimmed keyHash)", async () => {
    // The row sits under slug "foo" (how put would have written it after
    // trimming " foo "). Resolve-by-slug already normalises, so the read
    // succeeds either way — what this test pins is that the FOLLOW-UP
    // updateRecord mutation also targets "foo", not " foo ", so the
    // status change actually sticks on the canonical record.
    const captured: { update?: Record<string, unknown> } = {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/api/query")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.schema_name !== cfg.taskSchemaHash) {
          return new Response(JSON.stringify({ ok: true, results: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            ok: true,
            results: [{ fields: taskRow("foo"), key: { hash: "foo", range: null } }],
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
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const lines: string[] = [];
      // Note surrounding whitespace — what a shell autocomplete or copy-paste
      // might leave on the slug. `put " foo "` would have stored slug "foo".
      await statusCmd({
        cfg,
        slug: "  foo  ",
        newStatus: "in_progress",
        type: "task",
        print: (l) => lines.push(l),
      });
      // The whole point of the fix: the mutation targets the TRIMMED key, so
      // it actually lands on the stored row instead of pointing at "  foo  "
      // (which fold_db would treat as a different key entirely).
      const u = captured.update as {
        key_value: { hash: string };
        fields_and_values: { slug: string; status: string };
      };
      expect(u.key_value.hash).toBe("foo");
      // The row's own `slug` field is preserved from what the resolver read.
      expect(u.fields_and_values.slug).toBe("foo");
      expect(u.fields_and_values.status).toBe("in_progress");
      // Success line uses the trimmed slug — consistent with how put / delete
      // / link echo it.
      expect(lines.join("\n")).toContain("task foo: open → in_progress");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("read-only `status \" foo \"` getter also accepts a padded slug", async () => {
    // The bare getter has always trimmed indirectly (resolveBySlug normalises),
    // but pin the behavior so a future refactor can't regress the getter while
    // fixing the setter.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/api/query")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.schema_name !== cfg.taskSchemaHash) {
          return new Response(JSON.stringify({ ok: true, results: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            ok: true,
            results: [{ fields: taskRow("foo", { status: "blocked" }), key: { hash: "foo", range: null } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const lines: string[] = [];
      await statusCmd({
        cfg,
        slug: "  foo  ",
        type: "task",
        print: (l) => lines.push(l),
      });
      expect(lines).toEqual(["blocked"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
