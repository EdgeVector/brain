import { describe, expect, test } from "bun:test";

import { tagCmd } from "../../src/commands/tag.ts";
import { buildTestCfg, TEST_HASHES } from "../util.ts";

const cfg = buildTestCfg({ userHash: "uh" });

type MutationBody = {
  key_value?: { hash?: string };
  fields_and_values?: Record<string, unknown>;
};

function conceptRow(
  slug: string,
  over: Partial<Record<string, unknown>> = {},
): { fields: Record<string, unknown>; key: { hash: string; range: null } } {
  return {
    fields: {
      slug,
      title: "Original title",
      body: "line one\nline two\n",
      status: "active",
      tags: ["existing"],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      ...over,
    },
    key: { hash: slug, range: null },
  };
}

function installRecordMock(rows: Record<string, unknown>[]): {
  mutations: MutationBody[];
  restore: () => void;
} {
  const originalFetch = globalThis.fetch;
  const mutations: MutationBody[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.endsWith("/api/query")) {
      const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          ok: true,
          results: body.schema_name === TEST_HASHES.concept ? rows : [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/api/mutation")) {
      mutations.push(JSON.parse((init?.body as string) ?? "{}") as MutationBody);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return {
    mutations,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

describe("tagCmd", () => {
  test("adds tags while preserving body/title/status/created_at", async () => {
    const { mutations, restore } = installRecordMock([
      conceptRow("note", { tags: ["existing"] }),
    ]);
    try {
      const lines: string[] = [];
      let result;
      await tagCmd({
        cfg,
        slug: "note",
        type: "concept",
        add: ["owner:fbrain,area:status", "owner:fbrain"],
        print: (line) => lines.push(line),
        onResult: (payload) => {
          result = payload;
        },
      });

      expect(lines).toEqual([
        "tags changed for concept note: +owner:fbrain +area:status",
      ]);
      expect(result).toMatchObject({
        action: "tags_changed",
        type: "concept",
        slug: "note",
        added: ["owner:fbrain", "area:status"],
        removed: [],
        tags: ["existing", "owner:fbrain", "area:status"],
      });
      expect(mutations).toHaveLength(1);
      const fields = mutations[0]!.fields_and_values!;
      expect(mutations[0]!.key_value!.hash).toBe("note");
      expect(fields.title).toBe("Original title");
      expect(fields.body).toBe("line one\nline two\n");
      expect(fields.status).toBe("active");
      expect(fields.created_at).toBe("2026-01-01T00:00:00Z");
      expect(fields.tags).toEqual(["existing", "owner:fbrain", "area:status"]);
    } finally {
      restore();
    }
  });

  test("removes tags while preserving the rest of the record", async () => {
    const { mutations, restore } = installRecordMock([
      conceptRow("note", { tags: ["existing", "drop", "keep"] }),
    ]);
    try {
      let result;
      await tagCmd({
        cfg,
        slug: "note",
        type: "concept",
        rm: ["drop,absent"],
        print: () => {},
        onResult: (payload) => {
          result = payload;
        },
      });

      expect(result).toMatchObject({
        removed: ["drop"],
        tags: ["existing", "keep"],
      });
      expect(mutations).toHaveLength(1);
      expect(mutations[0]!.fields_and_values!.body).toBe("line one\nline two\n");
      expect(mutations[0]!.fields_and_values!.tags).toEqual(["existing", "keep"]);
    } finally {
      restore();
    }
  });

  test("idempotent add/remove is a no-op success with no write", async () => {
    const { mutations, restore } = installRecordMock([
      conceptRow("note", { tags: ["existing"] }),
    ]);
    try {
      const lines: string[] = [];
      let result;
      await tagCmd({
        cfg,
        slug: "note",
        type: "concept",
        add: ["existing"],
        rm: ["absent"],
        print: (line) => lines.push(line),
        onResult: (payload) => {
          result = payload;
        },
      });

      expect(lines).toEqual(["tags unchanged for concept note"]);
      expect(result).toMatchObject({
        added: [],
        removed: [],
        tags: ["existing"],
      });
      expect(mutations).toHaveLength(0);
    } finally {
      restore();
    }
  });

  test("ambiguous untyped slug errors before mutation", async () => {
    const originalFetch = globalThis.fetch;
    const mutations: MutationBody[] = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/api/query")) {
        const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
        const results =
          body.schema_name === TEST_HASHES.concept || body.schema_name === TEST_HASHES.task
            ? [conceptRow("dual")]
            : [];
        return new Response(JSON.stringify({ ok: true, results }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/mutation")) {
        mutations.push(JSON.parse((init?.body as string) ?? "{}") as MutationBody);
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    try {
      await expect(
        tagCmd({ cfg, slug: "dual", add: ["owner:fbrain"], print: () => {} }),
      ).rejects.toMatchObject({
        code: "ambiguous_slug",
        hint: "Re-run with --type, e.g. `fbrain tag dual --type task`.",
      });
      expect(mutations).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
