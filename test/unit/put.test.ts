// Unit tests for the put command: frontmatter parser, type resolution,
// title fallback. Behavior of the actual upsert (create vs update,
// preservation of created_at) is covered by the integration suite
// against the real fold harness.

import { afterEach, describe, expect, test } from "bun:test";

import {
  parseFrontmatter,
  putCmd,
  splitFrontmatter,
} from "../../src/commands/put.ts";
import { FbrainError } from "../../src/client.ts";
import { RECORDS, type RecordType } from "../../src/schemas.ts";
import { buildTestCfg, TEST_HASHES } from "../util.ts";

const DESIGN_HASH = TEST_HASHES.design;

const cfg = buildTestCfg({ userHash: "uh" });

describe("splitFrontmatter", () => {
  test("no frontmatter at all returns null + the body verbatim", () => {
    const r = splitFrontmatter("just a body, no leading ---\n");
    expect(r.frontmatter).toBeNull();
    expect(r.body).toBe("just a body, no leading ---");
  });

  test("frontmatter + body splits cleanly", () => {
    const r = splitFrontmatter("---\ntype: design\n---\nthe body\n");
    expect(r.frontmatter).toBe("type: design");
    expect(r.body).toBe("the body");
  });

  test("frontmatter only (no body) returns empty body string", () => {
    const r = splitFrontmatter("---\ntype: design\ntitle: T\n---\n");
    expect(r.frontmatter).toBe("type: design\ntitle: T");
    expect(r.body).toBe("");
  });

  test("frontmatter without trailing newline still works", () => {
    const r = splitFrontmatter("---\ntype: task\n---");
    expect(r.frontmatter).toBe("type: task");
    expect(r.body).toBe("");
  });

  test("entirely empty input → no frontmatter, empty body", () => {
    const r = splitFrontmatter("");
    expect(r.frontmatter).toBeNull();
    expect(r.body).toBe("");
  });

  test("CRLF line endings are tolerated", () => {
    const r = splitFrontmatter("---\r\ntype: design\r\n---\r\nthe body\r\n");
    expect(r.frontmatter).toBe("type: design");
    expect(r.body).toBe("the body");
  });
});

describe("parseFrontmatter", () => {
  test("null input → no type/title/tags", () => {
    const r = parseFrontmatter(null);
    expect(r.type).toBeUndefined();
    expect(r.title).toBeUndefined();
    expect(r.tags).toEqual([]);
  });

  test("empty string → no type/title/tags", () => {
    const r = parseFrontmatter("");
    expect(r.type).toBeUndefined();
    expect(r.tags).toEqual([]);
  });

  test("simple scalars", () => {
    const r = parseFrontmatter("type: design\ntitle: My Title");
    expect(r.type).toBe("design");
    expect(r.title).toBe("My Title");
  });

  test("inline tags list", () => {
    const r = parseFrontmatter("tags: [a, b, c]");
    expect(r.tags).toEqual(["a", "b", "c"]);
  });

  test("inline empty tags list", () => {
    const r = parseFrontmatter("tags: []");
    expect(r.tags).toEqual([]);
  });

  test("block tags list", () => {
    const r = parseFrontmatter("tags:\n  - a\n  - b\n  - c");
    expect(r.tags).toEqual(["a", "b", "c"]);
  });

  test("block tags list with quoted items", () => {
    const r = parseFrontmatter('tags:\n  - "first"\n  - \'second\'');
    expect(r.tags).toEqual(["first", "second"]);
  });

  test("quoted scalar values are unquoted", () => {
    const r = parseFrontmatter('title: "Quoted Title"\ntype: \'task\'');
    expect(r.title).toBe("Quoted Title");
    expect(r.type).toBe("task");
  });

  test("extra unknown keys are preserved in .raw and ignored", () => {
    const r = parseFrontmatter("type: design\ntitle: T\nauthor: alice");
    expect(r.type).toBe("design");
    expect(r.title).toBe("T");
    expect(r.raw.author).toBe("alice");
  });

  test("malformed line throws frontmatter_malformed with line number", () => {
    try {
      parseFrontmatter("type: design\nthisLineHasNoColon\ntitle: T");
      throw new Error("should not reach");
    } catch (err) {
      expect(err).toBeInstanceOf(FbrainError);
      const fe = err as FbrainError;
      expect(fe.code).toBe("frontmatter_malformed");
      expect(fe.message).toContain("line 2");
      expect(fe.message).toContain("thisLineHasNoColon");
    }
  });
});

const realFetch = globalThis.fetch;

type MockHandler = (url: string, init?: RequestInit) => { status: number; body?: unknown };

function installMock(handler: MockHandler): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    const out = handler(url, init);
    return new Response(JSON.stringify(out.body ?? {}), {
      status: out.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("putCmd — pre-request validation + dispatch", () => {
  test("invalid slug rejects before any HTTP traffic", async () => {
    let touched = false;
    installMock(() => {
      touched = true;
      return { status: 500 };
    });
    await expect(
      putCmd({ cfg, slug: "Bad Slug", input: "---\ntype: design\n---\n" }),
    ).rejects.toMatchObject({ code: "invalid_slug" });
    expect(touched).toBe(false);
  });

  test("unsupported type rejects before any HTTP traffic", async () => {
    let touched = false;
    installMock(() => {
      touched = true;
      return { status: 500 };
    });
    await expect(
      putCmd({
        cfg,
        slug: "anything",
        // `concep` is a typo — Phase 6 supports `concept`, not `concep`.
        input: "---\ntype: concep\n---\nbody",
      }),
    ).rejects.toMatchObject({ code: "unsupported_type" });
    expect(touched).toBe(false);
  });

  test("mixed-case type is normalised", async () => {
    const mutations: Array<Record<string, unknown>> = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        return { status: 200, body: { ok: true, results: [] } };
      }
      if (url.endsWith("/api/mutation")) {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        mutations.push(body);
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    const r = await putCmd({
      cfg,
      slug: "mixed-case-test",
      input: "---\ntype: DESIGN\ntitle: Test\n---\nbody here",
    });
    expect(r.type).toBe("design");
    expect(r.action).toBe("created");
    expect(mutations).toHaveLength(1);
    expect(mutations[0]!.mutation_type).toBe("create");
    expect(mutations[0]!.schema).toBe(DESIGN_HASH);
  });

  test("creates on first put, updates on second, preserves created_at", async () => {
    const existingRow = {
      fields: {
        slug: "round-trip",
        title: "Original",
        body: "old body",
        status: "reviewed",
        tags: ["initial"],
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      key: { hash: "round-trip", range: null },
    };

    // First mock: empty results → create path.
    const mutations1: Array<Record<string, unknown>> = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) return { status: 200, body: { ok: true, results: [] } };
      if (url.endsWith("/api/mutation")) {
        mutations1.push(JSON.parse((init?.body as string) ?? "{}"));
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    const created = await putCmd({
      cfg,
      slug: "round-trip",
      input: "---\ntype: design\ntitle: First\ntags: [a]\n---\nfirst body",
    });
    expect(created.action).toBe("created");
    expect(mutations1[0]!.mutation_type).toBe("create");

    // Second mock: existing row → update path; verify created_at preserved.
    const mutations2: Array<Record<string, unknown>> = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        return { status: 200, body: { ok: true, results: [existingRow] } };
      }
      if (url.endsWith("/api/mutation")) {
        mutations2.push(JSON.parse((init?.body as string) ?? "{}"));
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    const updated = await putCmd({
      cfg,
      slug: "round-trip",
      input: "---\ntype: design\ntitle: Second\ntags: [b]\n---\nsecond body",
    });
    expect(updated.action).toBe("updated");
    expect(mutations2[0]!.mutation_type).toBe("update");
    const fields = mutations2[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.created_at).toBe("2026-01-01T00:00:00.000Z");
    expect(fields.status).toBe("reviewed");
    expect(fields.title).toBe("Second");
    expect(fields.body).toBe("second body");
    expect(fields.tags).toEqual(["b"]);
    expect(typeof fields.updated_at).toBe("string");
    expect(fields.updated_at).not.toBe("2026-01-01T00:00:00.000Z");
  });

  test("no frontmatter at all → defaults to design, title from H1", async () => {
    const mutations: Array<Record<string, unknown>> = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) return { status: 200, body: { ok: true, results: [] } };
      if (url.endsWith("/api/mutation")) {
        mutations.push(JSON.parse((init?.body as string) ?? "{}"));
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    const r = await putCmd({
      cfg,
      slug: "h1-titled",
      input: "# Title From H1\n\nthe rest of the body",
    });
    expect(r.type).toBe("design");
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.title).toBe("Title From H1");
  });

  test("no frontmatter and no H1 → title falls back to slug", async () => {
    const mutations: Array<Record<string, unknown>> = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) return { status: 200, body: { ok: true, results: [] } };
      if (url.endsWith("/api/mutation")) {
        mutations.push(JSON.parse((init?.body as string) ?? "{}"));
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    await putCmd({
      cfg,
      slug: "no-title",
      input: "just some body text, no heading at all",
    });
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.title).toBe("no-title");
  });

  test("frontmatter-only (empty body) is valid", async () => {
    const mutations: Array<Record<string, unknown>> = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) return { status: 200, body: { ok: true, results: [] } };
      if (url.endsWith("/api/mutation")) {
        mutations.push(JSON.parse((init?.body as string) ?? "{}"));
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    const r = await putCmd({
      cfg,
      slug: "fm-only",
      input: "---\ntype: design\ntitle: Just FM\n---\n",
    });
    expect(r.action).toBe("created");
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.body).toBe("");
    expect(fields.title).toBe("Just FM");
  });

  test("entirely empty input is accepted (matches gbrain) and falls back to slug-title design", async () => {
    const mutations: Array<Record<string, unknown>> = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) return { status: 200, body: { ok: true, results: [] } };
      if (url.endsWith("/api/mutation")) {
        mutations.push(JSON.parse((init?.body as string) ?? "{}"));
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    const r = await putCmd({ cfg, slug: "totally-empty", input: "" });
    expect(r.action).toBe("created");
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.body).toBe("");
    expect(fields.title).toBe("totally-empty");
  });

  test("type: task on create populates design_slug to empty string", async () => {
    const mutations: Array<Record<string, unknown>> = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) return { status: 200, body: { ok: true, results: [] } };
      if (url.endsWith("/api/mutation")) {
        mutations.push(JSON.parse((init?.body as string) ?? "{}"));
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    const r = await putCmd({
      cfg,
      slug: "t1",
      input: "---\ntype: task\ntitle: First task\n---\nbody",
    });
    expect(r.type).toBe("task");
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.design_slug).toBe("");
    expect(fields.status).toBe("open");
  });

  test.each([
    "concept",
    "preference",
    "reference",
    "agent",
    "project",
    "spike",
  ] as const)("type: %s creates a record with the type's default status", async (type) => {
    const mutations: Array<Record<string, unknown>> = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) return { status: 200, body: { ok: true, results: [] } };
      if (url.endsWith("/api/mutation")) {
        mutations.push(JSON.parse((init?.body as string) ?? "{}"));
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    const r = await putCmd({
      cfg,
      slug: `${type}-smoke`,
      input: `---\ntype: ${type}\ntitle: Smoke\ntags: [phase6]\n---\nbody for ${type}`,
    });
    expect(r.type).toBe(type as RecordType);
    expect(r.action).toBe("created");
    expect(mutations).toHaveLength(1);
    expect(mutations[0]!.mutation_type).toBe("create");
    expect(mutations[0]!.schema).toBe(TEST_HASHES[type as RecordType]);
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.status).toBe(RECORDS[type as RecordType].defaultStatus);
    expect(fields.title).toBe("Smoke");
    expect(fields.tags).toEqual(["phase6"]);
    // Non-task types should NOT have design_slug.
    expect("design_slug" in fields).toBe(false);
  });

  test("update preserves existing design_slug on a task put", async () => {
    const existing = {
      fields: {
        slug: "t-with-parent",
        title: "Old",
        body: "old",
        status: "in_progress",
        tags: [],
        design_slug: "parent-design",
        created_at: "2026-02-02T00:00:00.000Z",
        updated_at: "2026-02-02T00:00:00.000Z",
      },
      key: { hash: "t-with-parent", range: null },
    };
    const mutations: Array<Record<string, unknown>> = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        return { status: 200, body: { ok: true, results: [existing] } };
      }
      if (url.endsWith("/api/mutation")) {
        mutations.push(JSON.parse((init?.body as string) ?? "{}"));
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    await putCmd({
      cfg,
      slug: "t-with-parent",
      input: "---\ntype: task\ntitle: New\n---\nnew body",
    });
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.design_slug).toBe("parent-design");
    expect(fields.status).toBe("in_progress");
    expect(fields.created_at).toBe("2026-02-02T00:00:00.000Z");
  });
});
