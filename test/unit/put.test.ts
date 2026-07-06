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
import { tagIndexSlug } from "../../src/tag-index.ts";
import { buildTestCfg, TEST_HASHES } from "../util.ts";

const DESIGN_HASH = TEST_HASHES.design;

// Default cfg points at a NON-loopback node so `putCmd`'s post-write
// vector-index confirmation (`confirmVectorIndexed`, gated to local nodes)
// short-circuits to `indexPending: false` without probing the native index.
// That keeps every existing put test focused on its own concern (frontmatter,
// create/update, the record-list verify-read) and free of the search-parity
// round-trip + backoff. The dedicated search-parity tests below use a loopback
// cfg + an injected no-op sleep to exercise the confirmation explicitly.
const cfg = buildTestCfg({ userHash: "uh", nodeUrl: "http://10.0.0.1:9001" });

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

  // Pre-fix, an opened-but-not-closed frontmatter silently fell through to
  // `frontmatter=null, body=<entire input verbatim>` — so the YAML-looking
  // keys above the missing close fence were dropped from the parse AND
  // pollute the body. A scripted put with `--type` set then wrote a record
  // whose body contained literal `---\ntype: X\n…` text. Refuse instead.
  test("opening `---` with no closing fence throws frontmatter_unclosed", () => {
    expect(() =>
      splitFrontmatter("---\ntype: concept\ntitle: My Thing\nbody after\n"),
    ).toThrow(FbrainError);
    expect(() =>
      splitFrontmatter("---\ntype: concept\ntitle: My Thing\nbody after\n"),
    ).toThrow(/frontmatter/i);
  });

  test("opening `---` alone (no closing, no content) throws frontmatter_unclosed", () => {
    expect(() => splitFrontmatter("---\n")).toThrow(FbrainError);
  });

  test("CRLF opening with no closing also throws", () => {
    expect(() =>
      splitFrontmatter("---\r\ntype: design\r\nbody\r\n"),
    ).toThrow(FbrainError);
  });

  // Empty frontmatter (`---\n---\n`) parses to an empty frontmatter string
  // and a normal body. Pre-fix this fell through to "no frontmatter" and
  // the fences leaked into the body — a minor sibling of the missing-close
  // bug above, fixed by the same rewrite.
  test("empty frontmatter (open then immediately close) → empty string + body", () => {
    const r = splitFrontmatter("---\n---\nthe body\n");
    expect(r.frontmatter).toBe("");
    expect(r.body).toBe("the body");
  });

  // Regression for the un-fenced-frontmatter trap: pre-fix, input whose first
  // lines were `type: …` / `slug: …` but lacked the leading `---` fence fell
  // through to "no frontmatter, body = entire input", then bubbled up as
  // `missing_slug` / `missing_type` — telling the user to "set `slug:` in
  // frontmatter" when they LITERALLY had. Diagnose the missing fence instead.
  test("unfenced input starting with `type:` throws frontmatter_unfenced (not missing_type)", () => {
    expect(() =>
      splitFrontmatter("type: concept\ntitle: OAuth PKCE\n---\nUse PKCE.\n"),
    ).toThrow(FbrainError);
    try {
      splitFrontmatter("type: concept\ntitle: OAuth PKCE\n---\nUse PKCE.\n");
    } catch (err) {
      const fe = err as FbrainError;
      expect(fe.code).toBe("frontmatter_unfenced");
      expect(fe.message).toMatch(/---/);
      expect(fe.hint ?? "").toMatch(/---/);
    }
  });

  test("unfenced input starting with `slug:` throws frontmatter_unfenced (not missing_slug)", () => {
    expect(() =>
      splitFrontmatter("slug: oauth-pkce\ntype: concept\n---\nbody\n"),
    ).toThrow(FbrainError);
    try {
      splitFrontmatter("slug: oauth-pkce\ntype: concept\n---\nbody\n");
    } catch (err) {
      const fe = err as FbrainError;
      expect(fe.code).toBe("frontmatter_unfenced");
    }
  });

  // No false positive: prose with no key-looking first line still parses as
  // "no frontmatter, body = the prose verbatim", so downstream missing-type
  // / missing-slug errors still fire on a typeless/slugless body. Only the
  // YAML-key-shaped first line triggers the new targeted diagnosis.
  test("prose with no key-looking first line still parses as no-frontmatter", () => {
    const r = splitFrontmatter("just some text\n");
    expect(r.frontmatter).toBeNull();
    expect(r.body).toBe("just some text");
  });

  test("body starting with `# heading:` is not mistaken for unfenced frontmatter", () => {
    // `# heading: text` is a Markdown H1, not a YAML key — UNFENCED_KEY_PATTERN
    // only matches `slug|type|title|tags|status:` at the very start of the line.
    const r = splitFrontmatter("# heading: text\nbody\n");
    expect(r.frontmatter).toBeNull();
    expect(r.body).toBe("# heading: text\nbody");
  });
});

describe("parseFrontmatter", () => {
  test("null input → no type/title/tags", () => {
    const r = parseFrontmatter(null);
    expect(r.type).toBeUndefined();
    expect(r.title).toBeUndefined();
    // `undefined` rather than `[]` so `buildFields` can tell "user did not
    // write `tags:`" (preserve existing on update) apart from the explicit
    // `tags: []` clear-intent — see the tags-preservation regression below.
    expect(r.tags).toBeUndefined();
  });

  test("empty string → no type/title/tags", () => {
    const r = parseFrontmatter("");
    expect(r.type).toBeUndefined();
    expect(r.tags).toBeUndefined();
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

  // Regression: the inline-list splitter mishandled commas inside quoted
  // scalars — `tags: ["foo,bar"]` collapsed to `["\"foo", "bar\""]`, silently
  // corrupting any tag carrying a literal comma. The MCP `buildPutInput`
  // ALWAYS quotes a tag with a comma (so this fires through every MCP put
  // whose agent passed a comma-bearing tag) and any CLI user typing the
  // documented `["a,b", c]` YAML subset hit the same trap.
  test("inline tags list preserves commas inside double-quoted scalars", () => {
    const r = parseFrontmatter('tags: ["foo,bar", "ok", baz]');
    expect(r.tags).toEqual(["foo,bar", "ok", "baz"]);
  });

  test("inline tags list preserves commas inside single-quoted scalars", () => {
    const r = parseFrontmatter("tags: ['a,b', plain]");
    expect(r.tags).toEqual(["a,b", "plain"]);
  });

  // Regression: the inline-list parser didn't honor `\"` / `\\` inside a
  // double-quoted scalar, so the MCP `yamlScalar` escape protocol round-tripped
  // wrong — a tag like `a"b` came back as `a\"b` (backslash injected) and a
  // tag like `a"b,c` was split into two malformed items because `\"` was read
  // as the closing quote and the following `,` as a separator. Mirrors the
  // serializer in src/mcp/server.ts that always escapes `\` and `"` when it
  // wraps a tag in double quotes.
  test("inline tags list un-escapes \\\" and \\\\ inside double-quoted scalars", () => {
    const r = parseFrontmatter('tags: ["a\\"b", "a\\\\b", "a\\"b,c"]');
    expect(r.tags).toEqual(['a"b', "a\\b", 'a"b,c']);
  });

  // Regression companion: `yamlScalar` MCP serializer now escapes embedded
  // newlines / CRs as `\n` / `\r` so a multi-line scalar doesn't spill
  // across physical lines and break the line-based parser. The parser side
  // mirrors `\\` / `\"` un-escape and additionally turns `\n` / `\r` back
  // into newline / CR. Any other `\X` still passes through.
  test("double-quoted scalar un-escapes \\n and \\r", () => {
    const r = parseFrontmatter('title: "line one\\nline two\\r\\nline three"');
    expect(r.title).toBe("line one\nline two\r\nline three");
  });

  test("inline tags list un-escapes \\n inside double-quoted scalars", () => {
    const r = parseFrontmatter('tags: ["with\\nnewline", "plain"]');
    expect(r.tags).toEqual(["with\nnewline", "plain"]);
  });

  test("unknown `\\X` escapes still pass through verbatim", () => {
    // The serializer only emits `\\`, `\"`, `\n`, `\r`. Anything else
    // (e.g. `\t`) is not part of the subset and round-trips as the
    // literal backslash + char — matches the prior contract for `\X`.
    const r = parseFrontmatter('title: "tab\\there"');
    expect(r.title).toBe("tab\\there");
  });

  test("block tags list", () => {
    const r = parseFrontmatter("tags:\n  - a\n  - b\n  - c");
    expect(r.tags).toEqual(["a", "b", "c"]);
  });

  test("block tags list with quoted items", () => {
    const r = parseFrontmatter('tags:\n  - "first"\n  - \'second\'');
    expect(r.tags).toEqual(["first", "second"]);
  });

  // Regression: `tags:` written as a bare scalar (the most natural form a
  // user types, and the form the `--tag` CLI flag accepts) used to land in
  // `raw["tags"]` but never reach the typed `out.tags` slot — the scalar
  // branch only mapped slug/type/title/status. A `tags: onboarding` line in
  // frontmatter silently became zero tags on the created record, while the
  // exact same intent via `--tag onboarding` worked. Treat the scalar value
  // as an inline-list inner: split on commas (respecting quoted scalars)
  // so single-tag and comma-CSV forms both round-trip.
  test("scalar tags single value → one-element list", () => {
    const r = parseFrontmatter("tags: docs");
    expect(r.tags).toEqual(["docs"]);
  });

  test("scalar tags comma-separated → split list", () => {
    const r = parseFrontmatter("tags: docs, fold");
    expect(r.tags).toEqual(["docs", "fold"]);
  });

  test("scalar tags empty double-quoted → empty list (explicit clear)", () => {
    const r = parseFrontmatter('tags: ""');
    expect(r.tags).toEqual([]);
  });

  test("scalar tags empty single-quoted → empty list (explicit clear)", () => {
    const r = parseFrontmatter("tags: ''");
    expect(r.tags).toEqual([]);
  });

  // The comma-split lives ONLY on the tags scalar path — title/status/slug/type
  // with commas must still round-trip as one scalar. Without this guard,
  // a title like `Hello, world` would be torn into two pieces.
  test("scalar title with comma is not split (comma-split is tags-only)", () => {
    const r = parseFrontmatter("title: Hello, world");
    expect(r.title).toBe("Hello, world");
  });

  test("scalar status with comma is not split (comma-split is tags-only)", () => {
    const r = parseFrontmatter("status: a, b");
    expect(r.status).toBe("a, b");
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

  test("slug: field is captured", () => {
    const r = parseFrontmatter("type: concept\nslug: hello-2026\ntitle: Hello");
    expect(r.slug).toBe("hello-2026");
    expect(r.type).toBe("concept");
    expect(r.title).toBe("Hello");
  });

  test("quoted slug is unquoted like other scalars", () => {
    const r = parseFrontmatter('slug: "my-slug"\ntype: design');
    expect(r.slug).toBe("my-slug");
  });

  test("no slug: field → undefined", () => {
    const r = parseFrontmatter("type: design\ntitle: T");
    expect(r.slug).toBeUndefined();
  });

  test("status: field is captured into the typed slot (not just .raw)", () => {
    const r = parseFrontmatter("type: task\nstatus: in_progress\ntitle: T");
    expect(r.status).toBe("in_progress");
    expect(r.raw.status).toBe("in_progress");
  });

  test("quoted status: is unquoted like other scalars", () => {
    const r = parseFrontmatter('status: "reviewed"\ntype: design');
    expect(r.status).toBe("reviewed");
  });

  test("no status: field → undefined (not the empty string)", () => {
    const r = parseFrontmatter("type: design\ntitle: T");
    expect(r.status).toBeUndefined();
  });

  // Three-way distinction the absent/explicit/empty contract relies on. Pre-fix
  // the parser collapsed (a) and (c) to the same `[]`, so the put handler
  // couldn't tell "user said nothing about tags" from "user said `tags: []`" —
  // both clobbered existing tags on update.
  test("absent tags: field → undefined (distinct from explicit empty list)", () => {
    const r = parseFrontmatter("type: design\ntitle: T");
    expect(r.tags).toBeUndefined();
  });

  test("explicit `tags: []` → empty array (distinct from absent)", () => {
    const r = parseFrontmatter("type: design\ntags: []");
    expect(r.tags).toEqual([]);
  });

  test("explicit empty block-list `tags:` with no items → empty array (distinct from absent)", () => {
    // `tags:` with no value opens a block list; no `- item` lines follow,
    // so the user's explicit intent is "no tags". Must still be `[]`, not
    // `undefined`, so an update honors the clear instead of preserving.
    const r = parseFrontmatter("type: design\ntags:\ntitle: T");
    expect(r.tags).toEqual([]);
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

  // Block-scalar support — see #7852b. Pre-fix, a standard YAML `>-` /
  // `|` title threw `frontmatter_malformed` on the indented continuation
  // line (and a bulk-import path stored the literal `>-` as the title for
  // 15 records in Tom's brain).
  describe("block scalars", () => {
    test("folded `>-` title joins lines with space, strips trailing newline", () => {
      const r = parseFrontmatter(
        "type: concept\ntitle: >-\n  A long title that\n  wraps across lines",
      );
      expect(r.title).toBe("A long title that wraps across lines");
      expect(r.type).toBe("concept");
    });

    test("folded `>` (clip chomp) keeps single trailing newline", () => {
      const r = parseFrontmatter("title: >\n  hello\n  world");
      expect(r.title).toBe("hello world\n");
    });

    test("folded `>+` (keep chomp) preserves trailing blank lines", () => {
      const r = parseFrontmatter("title: >+\n  hello\n  world\n\n");
      expect(r.title).toBe("hello world\n\n\n");
    });

    test("literal `|` preserves line breaks as `\\n`", () => {
      const r = parseFrontmatter("type: concept\nraw_body: |\n  line one\n  line two\n  line three");
      // `raw_body` is an unknown key, so it lands in r.raw (not a typed slot).
      expect(r.raw.raw_body).toBe("line one\nline two\nline three\n");
    });

    test("literal `|-` strips trailing newline", () => {
      const r = parseFrontmatter("title: |-\n  line one\n  line two");
      expect(r.title).toBe("line one\nline two");
    });

    test("literal `|+` keeps trailing blank lines", () => {
      const r = parseFrontmatter("title: |+\n  hello\n\n");
      expect(r.title).toBe("hello\n\n\n");
    });

    test("folded `>` with blank line in middle emits a `\\n`", () => {
      const r = parseFrontmatter("title: >-\n  para one\n\n  para two");
      expect(r.title).toBe("para one\npara two");
    });

    test("block scalar stops when the next column-0 key starts", () => {
      const r = parseFrontmatter(
        "title: >-\n  folded title here\nstatus: in_progress\ntype: task",
      );
      expect(r.title).toBe("folded title here");
      expect(r.status).toBe("in_progress");
      expect(r.type).toBe("task");
    });

    test("block scalar at end of frontmatter (no trailing content)", () => {
      const r = parseFrontmatter("type: concept\ntitle: >-\n  the title");
      expect(r.title).toBe("the title");
    });

    test("status: as a folded scalar is captured into the typed slot", () => {
      const r = parseFrontmatter(
        "type: task\nstatus: >-\n  in_progress\ntitle: T",
      );
      expect(r.status).toBe("in_progress");
    });

    test("slug: as a folded scalar is captured into the typed slot", () => {
      const r = parseFrontmatter(
        "type: concept\nslug: >-\n  my-slug\ntitle: T",
      );
      expect(r.slug).toBe("my-slug");
    });

    test("explicit indent indicator `>2` honors the declared column", () => {
      const r = parseFrontmatter("title: >2-\n    extra indented body");
      // With explicitIndent=2, we strip 2 chars; the remaining 2 spaces
      // are part of the content.
      expect(r.title).toBe("  extra indented body");
    });

    test("genuine malformed line still throws after block scalar feature", () => {
      try {
        parseFrontmatter("title: >-\n  ok\nthisLineHasNoColon\ntype: task");
        throw new Error("should not reach");
      } catch (err) {
        expect(err).toBeInstanceOf(FbrainError);
        const fe = err as FbrainError;
        expect(fe.code).toBe("frontmatter_malformed");
        expect(fe.message).toContain("thisLineHasNoColon");
      }
    });

    test("unknown key with folded scalar is stored in .raw", () => {
      const r = parseFrontmatter("author: >-\n  Jane\n  Doe");
      expect(r.raw.author).toBe("Jane Doe");
    });
  });
});

const realFetch = globalThis.fetch;

type MockHandler = (url: string, init?: RequestInit) => { status: number; body?: unknown };

// Auto-stateful fetch mock. Tracks create/update mutations the test fires
// and, when the test's own handler returns an empty `/api/query` page for a
// matching `schema_name`, splices the written row into the response. This
// mirrors how real fold_db behaves on a warm node — once propagation lands,
// the row IS queryable — so the put-side verify-after-write step
// (`verifyRecordVisible` in record.ts) sees the row without each test
// growing its own "post-mutation, return the row" branch. Tests that
// explicitly seed an existing row (handler already returns a populated
// page) are left alone: the splice fires only on the empty-page branch.
type TrackedWrite = {
  schema: string;
  key: string;
  fields: Record<string, unknown>;
};

function installMock(handler: MockHandler): void {
  const writes: TrackedWrite[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    const out = handler(url, init);
    if (url.endsWith("/api/mutation") && typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        const kind = body.mutation_type;
        if (kind === "create" || kind === "update") {
          const keyVal = body.key_value as Record<string, unknown> | undefined;
          writes.push({
            schema: String(body.schema ?? ""),
            key: String(keyVal?.hash ?? ""),
            fields: (body.fields_and_values as Record<string, unknown>) ?? {},
          });
        }
      } catch {
        // Body wasn't JSON — ignore; tests that fire non-JSON bodies don't
        // care about the splice path.
      }
    }
    if (
      url.endsWith("/api/query") &&
      out.status === 200 &&
      typeof init?.body === "string"
    ) {
      const handlerResults = (out.body as Record<string, unknown> | undefined)?.results;
      if (Array.isArray(handlerResults) && handlerResults.length === 0) {
        try {
          const qBody = JSON.parse(init.body) as Record<string, unknown>;
          const schema = String(qBody.schema_name ?? "");
          const matches = writes
            .filter((w) => w.schema === schema)
            .map((w) => ({ fields: w.fields, key: { hash: w.key, range: null } }));
          if (matches.length > 0) {
            return new Response(
              JSON.stringify({ ...(out.body as object), results: matches }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
        } catch {
          // Same as above — non-JSON query bodies fall through.
        }
      }
    }
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

  test("slug from frontmatter alone is honored (no positional)", async () => {
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
      input: "---\ntype: concept\nslug: from-fm\ntitle: T\n---\nbody",
    });
    expect(r.slug).toBe("from-fm");
    expect(r.action).toBe("created");
    expect(mutations[0]!.mutation_type).toBe("create");
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.slug).toBe("from-fm");
  });

  test("no slug anywhere → rejected with missing_slug before any HTTP traffic", async () => {
    let touched = false;
    installMock(() => {
      touched = true;
      return { status: 500 };
    });
    await expect(
      putCmd({ cfg, input: "---\ntype: concept\ntitle: T\n---\nbody" }),
    ).rejects.toMatchObject({ code: "missing_slug" });
    expect(touched).toBe(false);
  });

  test("positional slug matches frontmatter slug → accepted", async () => {
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
      slug: "same-slug",
      input: "---\ntype: concept\nslug: same-slug\n---\nbody",
    });
    expect(r.slug).toBe("same-slug");
    expect(r.action).toBe("created");
  });

  test("positional slug conflicts with frontmatter slug → rejected with slug_conflict", async () => {
    let touched = false;
    installMock(() => {
      touched = true;
      return { status: 500 };
    });
    await expect(
      putCmd({
        cfg,
        slug: "cli-slug",
        input: "---\ntype: concept\nslug: other-slug\n---\nbody",
      }),
    ).rejects.toMatchObject({ code: "slug_conflict" });
    expect(touched).toBe(false);
  });

  test("invalid slug in frontmatter is caught by validateSlug", async () => {
    let touched = false;
    installMock(() => {
      touched = true;
      return { status: 500 };
    });
    await expect(
      putCmd({
        cfg,
        input: "---\ntype: concept\nslug: Bad Slug\n---\nbody",
      }),
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

  test("create honors a frontmatter created_at (historical-date preservation)", async () => {
    const mutations: Array<Record<string, unknown>> = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) return { status: 200, body: { ok: true, results: [] } };
      if (url.endsWith("/api/mutation")) {
        mutations.push(JSON.parse((init?.body as string) ?? "{}"));
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    const created = await putCmd({
      cfg,
      slug: "hist-decision",
      input:
        "---\ntype: decision\ntitle: An old call\nstatus: go\n" +
        "program: fbrain\ngate_slug: some-gate\ndecided_by: Tom\n" +
        "decided_on: 2026-06-23\ncreated_at: 2026-06-23T12:00:00Z\n---\nrationale",
    });
    expect(created.action).toBe("created");
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    // The real historical created_at is preserved, not overwritten with now.
    expect(fields.created_at).toBe("2026-06-23T12:00:00Z");
    // The decision's dedicated columns round-trip through the write.
    expect(fields.program).toBe("fbrain");
    expect(fields.gate_slug).toBe("some-gate");
    expect(fields.decided_by).toBe("Tom");
    expect(fields.decided_on).toBe("2026-06-23");
    // updated_at is still "now", not the historical date.
    expect(fields.updated_at).not.toBe("2026-06-23T12:00:00Z");
  });

  test("create ignores a malformed frontmatter created_at (falls back to now)", async () => {
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
      slug: "bad-created-at",
      input: "---\ntype: concept\ntitle: T\ncreated_at: not-a-date\n---\nbody",
    });
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.created_at).not.toBe("not-a-date");
    // A real ISO timestamp (now) instead of the garbage value.
    expect(Number.isNaN(Date.parse(fields.created_at as string))).toBe(false);
  });

  test("no frontmatter + --type design → title from H1", async () => {
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
      typeOverride: "design",
    });
    expect(r.type).toBe("design");
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.title).toBe("Title From H1");
  });

  test("no frontmatter, no H1, --type design → title falls back to slug", async () => {
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
      typeOverride: "design",
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

  test("entirely empty input is rejected with empty_stdin before any HTTP traffic", async () => {
    let touched = false;
    installMock(() => {
      touched = true;
      return { status: 500 };
    });
    await expect(
      putCmd({ cfg, slug: "totally-empty", input: "" }),
    ).rejects.toMatchObject({ code: "empty_stdin" });
    expect(touched).toBe(false);
  });

  test("whitespace-only input is rejected with empty_stdin", async () => {
    let touched = false;
    installMock(() => {
      touched = true;
      return { status: 500 };
    });
    await expect(
      putCmd({ cfg, slug: "ws-only", input: "   \n\n  \n" }),
    ).rejects.toMatchObject({ code: "empty_stdin" });
    expect(touched).toBe(false);
  });

  // Regression for the un-fenced-frontmatter trap: pre-fix, piping key-looking
  // content without the `---` fence silently folded those keys into the body
  // and surfaced as `missing_slug` — the hint then told the user to "set
  // `slug:` in frontmatter", which is exactly what they wrote. Refusal must
  // fire before any HTTP traffic.
  test("un-fenced-frontmatter input is rejected with frontmatter_unfenced before any HTTP traffic", async () => {
    let touched = false;
    installMock(() => {
      touched = true;
      return { status: 500 };
    });
    await expect(
      putCmd({
        cfg,
        input: "type: concept\nslug: oauth-pkce\ntitle: OAuth PKCE\n---\nUse PKCE.\n",
      }),
    ).rejects.toMatchObject({ code: "frontmatter_unfenced" });
    expect(touched).toBe(false);
  });

  // Regression for the missing-closing-fence bug: pre-fix, this input plus a
  // CLI `--type` override silently wrote a record whose body contained the
  // unclosed `---` and the YAML-looking metadata, dropping the user's
  // declared title from the parse. The pre-flight refusal must fire before
  // any HTTP traffic.
  test("opened-but-not-closed frontmatter is rejected before any HTTP traffic", async () => {
    let touched = false;
    installMock(() => {
      touched = true;
      return { status: 500 };
    });
    await expect(
      putCmd({
        cfg,
        slug: "unclosed",
        typeOverride: "concept",
        input: "---\ntype: concept\ntitle: My Thing\nbody text\n",
      }),
    ).rejects.toMatchObject({ code: "frontmatter_unclosed" });
    expect(touched).toBe(false);
  });

  test("frontmatter present, body empty → still accepted (explicit intent)", async () => {
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
      slug: "fm-empty-body",
      input: "---\ntype: concept\ntitle: X\n---\n",
    });
    expect(r.type).toBe("concept");
    expect(r.action).toBe("created");
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.body).toBe("");
    expect(fields.title).toBe("X");
  });

  test("body present, no frontmatter, no --type → rejected with missing_type", async () => {
    let touched = false;
    installMock(() => {
      touched = true;
      return { status: 500 };
    });
    await expect(
      putCmd({ cfg, slug: "body-only", input: "just body text\n" }),
    ).rejects.toMatchObject({ code: "missing_type" });
    expect(touched).toBe(false);
  });

  test("body present, no frontmatter, --type concept → accepted", async () => {
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
      slug: "body-only",
      input: "just body text\n",
      typeOverride: "concept",
    });
    expect(r.type).toBe("concept");
    expect(r.action).toBe("created");
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.body).toBe("just body text");
  });

  test("frontmatter present, no type: field, no --type → rejected with missing_type", async () => {
    let touched = false;
    installMock(() => {
      touched = true;
      return { status: 500 };
    });
    await expect(
      putCmd({
        cfg,
        slug: "no-type-field",
        input: "---\ntitle: just a title\n---\nbody",
      }),
    ).rejects.toMatchObject({ code: "missing_type" });
    expect(touched).toBe(false);
  });

  test("frontmatter present, no type: field, --type concept → accepted", async () => {
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
      slug: "fm-no-type",
      input: "---\ntitle: From FM\n---\nbody",
      typeOverride: "concept",
    });
    expect(r.type).toBe("concept");
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.title).toBe("From FM");
  });

  test("--type matches frontmatter type → no conflict, just accepted", async () => {
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
      slug: "agree",
      input: "---\ntype: task\ntitle: T\n---\nbody",
      typeOverride: "task",
    });
    expect(r.type).toBe("task");
  });

  test("--type disagrees with frontmatter type → rejected with type_conflict", async () => {
    let touched = false;
    installMock(() => {
      touched = true;
      return { status: 500 };
    });
    await expect(
      putCmd({
        cfg,
        slug: "disagree",
        input: "---\ntype: task\ntitle: T\n---\nbody",
        typeOverride: "design",
      }),
    ).rejects.toMatchObject({ code: "type_conflict" });
    expect(touched).toBe(false);
  });

  test("--type with an unsupported value rejects with unsupported_type", async () => {
    let touched = false;
    installMock(() => {
      touched = true;
      return { status: 500 };
    });
    await expect(
      putCmd({
        cfg,
        slug: "bad-override",
        input: "body",
        typeOverride: "concep",
      }),
    ).rejects.toMatchObject({ code: "unsupported_type" });
    expect(touched).toBe(false);
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

  test("type: task honors design_slug from frontmatter on create", async () => {
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
      slug: "t-with-frontmatter-parent",
      input: "---\ntype: task\ntitle: Task\ndesign_slug: parent-design\n---\nbody",
    });
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.design_slug).toBe("parent-design");
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
    expect(mutations).toHaveLength(2);
    expect(mutations[0]!.mutation_type).toBe("create");
    expect(mutations[0]!.schema).toBe(TEST_HASHES[type as RecordType]);
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.status).toBe(RECORDS[type as RecordType].defaultStatus);
    expect(fields.title).toBe("Smoke");
    expect(fields.tags).toEqual(["phase6"]);
    const indexFields = mutations[1]!.fields_and_values as Record<string, unknown>;
    expect(indexFields.slug).toBe(tagIndexSlug("phase6"));
    expect(indexFields.members).toEqual([`${type}:${type}-smoke`]);
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

  test("task design_slug in frontmatter overrides the existing value on update", async () => {
    const existing = {
      fields: {
        slug: "t-reparent",
        title: "Old",
        body: "old",
        status: "in_progress",
        tags: [],
        design_slug: "old-parent",
        created_at: "2026-02-02T00:00:00.000Z",
        updated_at: "2026-02-02T00:00:00.000Z",
      },
      key: { hash: "t-reparent", range: null },
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
      slug: "t-reparent",
      input: "---\ntype: task\ntitle: New\ndesign_slug: new-parent\n---\nnew body",
    });
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.design_slug).toBe("new-parent");
    expect(fields.created_at).toBe("2026-02-02T00:00:00.000Z");
  });

  // Regression: fold_db_node `/api/query` returns a non-deterministic
  // top-100 slice per schema, so a schema with >100 rows can have an
  // existing slug get skipped from the page. Pre-fix, the put handler
  // called findBySlug once and on a miss fell through to createRecord —
  // overwriting the row with a fresh `created_at` and printing "created"
  // even though it was an upsert. The retry hedge (mirrors what
  // resolveBySlug does for get/status/delete) must re-query until the
  // record surfaces.
  test("re-put of an existing slug updates in place (preserving created_at)", async () => {
    const existing = {
      fields: {
        slug: "flaky-upsert",
        title: "Original",
        body: "old body",
        status: "active",
        tags: ["initial"],
        created_at: "2026-03-03T00:00:00.000Z",
        updated_at: "2026-03-03T00:00:00.000Z",
        kind: "concept",
      },
      key: { hash: "flaky-upsert", range: null },
    };
    let queryCalls = 0;
    const mutations: Array<Record<string, unknown>> = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        queryCalls++;
        return { status: 200, body: { ok: true, results: [existing] } };
      }
      if (url.endsWith("/api/mutation")) {
        mutations.push(JSON.parse((init?.body as string) ?? "{}"));
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    const r = await putCmd({
      cfg,
      slug: "flaky-upsert",
      input: "---\ntype: concept\ntitle: Second\ntags: [b]\n---\nsecond body",
    });
    expect(r.action).toBe("updated");
    // Existence check (keyed point-read) + verify-after-write.
    expect(queryCalls).toBeGreaterThanOrEqual(2);
    expect(mutations).toHaveLength(1);
    expect(mutations[0]!.mutation_type).toBe("update");
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.created_at).toBe("2026-03-03T00:00:00.000Z");
    expect(fields.updated_at).not.toBe("2026-03-03T00:00:00.000Z");
    expect(typeof fields.updated_at).toBe("string");
    expect(fields.title).toBe("Second");
    expect(fields.body).toBe("second body");
  });

  // Regression: `status:` in frontmatter used to be silently dropped — the
  // parser extracted slug/type/title/tags into typed slots but `status:`
  // landed only in `.raw`, and `buildFields` always overrode it with
  // either the existing row's status or the type's defaultStatus. So a
  // user-typed `status: in_progress` never reached fold_db, and re-puts of
  // a fresh record always landed on `defaultStatus` regardless of what
  // the frontmatter asked for. The fix routes `parsed.status` into
  // `buildFields` as a first-priority winner (over both existing and
  // default), validated upstream by `ensureStatus` so an invalid status
  // can't reach the network.
  test("status: in frontmatter is honored on create", async () => {
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
      slug: "with-status",
      input: "---\ntype: task\ntitle: A task\nstatus: in_progress\n---\nbody",
    });
    expect(r.action).toBe("created");
    expect(mutations[0]!.mutation_type).toBe("create");
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    // Without the fix this lands on "open" (the task type's defaultStatus).
    expect(fields.status).toBe("in_progress");
  });

  test("status: in frontmatter overrides the existing record's status on update", async () => {
    const existing = {
      fields: {
        slug: "with-status-up",
        title: "Old",
        body: "old",
        status: "open",
        tags: [],
        design_slug: "",
        created_at: "2026-02-02T00:00:00.000Z",
        updated_at: "2026-02-02T00:00:00.000Z",
      },
      key: { hash: "with-status-up", range: null },
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
      slug: "with-status-up",
      input: "---\ntype: task\ntitle: New\nstatus: blocked\n---\nnew body",
    });
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    // Pre-fix: the existing "open" status would win and "blocked" would
    // be silently lost. The fix lets an explicit frontmatter status take
    // priority — symmetric with how `title:` and `tags:` already do.
    expect(fields.status).toBe("blocked");
  });

  test("re-put without a status: still preserves the existing status (no clobber)", async () => {
    // Mirrors the existing "preserves status if user moved it past default"
    // integration test, locked in at the unit layer so the new status
    // routing can't regress the preservation path.
    const existing = {
      fields: {
        slug: "no-status-line",
        title: "Old",
        body: "old",
        status: "reviewed",
        tags: [],
        created_at: "2026-02-02T00:00:00.000Z",
        updated_at: "2026-02-02T00:00:00.000Z",
      },
      key: { hash: "no-status-line", range: null },
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
      slug: "no-status-line",
      input: "---\ntype: design\ntitle: New\n---\nnew body",
    });
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.status).toBe("reviewed");
  });

  test("invalid status: in frontmatter is rejected before any HTTP traffic", async () => {
    let touched = false;
    installMock(() => {
      touched = true;
      return { status: 500 };
    });
    await expect(
      putCmd({
        cfg,
        slug: "bad-status",
        // "shipped" is not in TASK_STATUSES — must surface as invalid_status,
        // not silently fall through and write a defaulted "open" row.
        input: "---\ntype: task\ntitle: T\nstatus: shipped\n---\nbody",
      }),
    ).rejects.toMatchObject({ code: "invalid_status" });
    expect(touched).toBe(false);
  });

  test("status valid for one type but not another fails when the type disagrees", async () => {
    // `in_progress` is a Task status but not a Design status. Choosing the
    // wrong type for a valid-looking status must reject; the validation
    // pins to the RESOLVED type, not the raw string.
    let touched = false;
    installMock(() => {
      touched = true;
      return { status: 500 };
    });
    await expect(
      putCmd({
        cfg,
        slug: "wrong-type-status",
        input: "---\ntype: design\ntitle: T\nstatus: in_progress\n---\nbody",
      }),
    ).rejects.toMatchObject({ code: "invalid_status" });
    expect(touched).toBe(false);
  });

  // Regression: `tags:` followed the same shape of bug as `status:` (see
  // #108) — the parser defaulted `parsed.tags` to `[]` when no `tags:` line
  // was present, indistinguishable from an explicit `tags: []`. `buildFields`
  // then unconditionally wrote that `[]` to fold_db, so a re-put that
  // touched only the body silently cleared every existing tag. The fix
  // lifts `parsed.tags` to `string[] | undefined` so absence preserves and
  // explicit empty still clears — symmetric with the `status` cascade.
  test("re-put without a tags: line preserves the existing tags (no clobber)", async () => {
    const existing = {
      fields: {
        slug: "no-tags-line",
        title: "Old",
        body: "old",
        status: "reviewed",
        tags: ["alpha", "beta"],
        created_at: "2026-02-02T00:00:00.000Z",
        updated_at: "2026-02-02T00:00:00.000Z",
      },
      key: { hash: "no-tags-line", range: null },
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
      slug: "no-tags-line",
      input: "---\ntype: design\ntitle: New\n---\nnew body",
    });
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    // Pre-fix this was `[]` — every existing tag silently lost.
    expect(fields.tags).toEqual(["alpha", "beta"]);
  });

  test("re-put with explicit `tags: []` still clears the existing tags (no over-preserve)", async () => {
    // The other side of the absent/explicit contract: an explicit empty
    // list is a user instruction to clear, and must override existing
    // tags. Without this assertion, a future "always preserve" tweak
    // would silently break the clear-intent path.
    const existing = {
      fields: {
        slug: "explicit-clear",
        title: "Old",
        body: "old",
        status: "reviewed",
        tags: ["keep", "me"],
        created_at: "2026-02-02T00:00:00.000Z",
        updated_at: "2026-02-02T00:00:00.000Z",
      },
      key: { hash: "explicit-clear", range: null },
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
      slug: "explicit-clear",
      input: "---\ntype: design\ntitle: New\ntags: []\n---\nnew body",
    });
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.tags).toEqual([]);
  });

  test("first put without a tags: line creates with an empty tags list (no existing to preserve)", async () => {
    // On CREATE there is no existing record, so an absent `tags:` falls
    // all the way through to the final `[]` default — matches the
    // pre-fix observable for the create path so this fix is strictly a
    // preservation improvement, not a behavior change for new records.
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
      slug: "create-no-tags",
      input: "---\ntype: design\ntitle: Fresh\n---\nbody",
    });
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.tags).toEqual([]);
  });

  // Read-your-writes regression — task 920a3. After `createRecord` /
  // `updateRecord` resolves, putCmd must read the row back via
  // `verifyRecordVisible` (full `withReadRetry` budget) before reporting
  // "created"/"updated". Without this guard, a tight put→get loop (worst
  // case: MCP-agent stdio, same warm process, no cold-start delay) saw
  // "No record" for a row that did, in fact, just land — because
  // fold_db's `/api/mutation` is not RYW-consistent and a bare point-read
  // (`findBySlug`) is authoritative found-or-not, returning null with zero
  // retry. This is why the verify-after-write path wraps the point-read in the
  // full `withReadRetry` budget: the caller of a put→get is NOT expected to
  // re-run; they conclude the data is gone.
  describe("verify-after-write — read-your-writes regression (920a3)", () => {
    // No-op sleep so the test doesn't pay the real 250 ms backoff schedule.
    // The verify budget is what we're asserting on; the schedule is pinned
    // separately by computeBackoffMs tests.
    const noopSleep = (): Promise<void> => Promise.resolve();

    test("after createRecord, putCmd retries the verify-read until the row appears", async () => {
      // Drop the auto-splice from the shared `installMock` for this test:
      // we are simulating fold_db's visibility lag, where /api/query returns
      // empty for the first few attempts AFTER the mutation lands. We
      // count the verify-reads and surface the row only after some retries.
      let queryCallsAfterMutation = 0;
      let mutationFired = false;
      const visibleRow = {
        fields: {
          slug: "ryw-visible",
          title: "Visible at last",
          body: "the body",
          status: "active",
          tags: [],
          created_at: "2026-06-05T00:00:00.000Z",
          updated_at: "2026-06-05T00:00:00.000Z",
        },
        key: { hash: "ryw-visible", range: null },
      };
      const mutations: Array<Record<string, unknown>> = [];
      const realFetch2 = globalThis.fetch;
      try {
        globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
          const url = typeof input === "string" ? input : String(input);
          if (url.endsWith("/api/mutation")) {
            mutations.push(JSON.parse((init?.body as string) ?? "{}"));
            mutationFired = true;
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (url.endsWith("/api/query")) {
            // Pre-create existence check: row absent. Post-create
            // verify-reads: empty for 2 attempts (fold_db's visibility lag
            // window), then the row surfaces. With the verify path wired,
            // putCmd MUST keep reading until the row appears.
            if (mutationFired) {
              queryCallsAfterMutation++;
              if (queryCallsAfterMutation <= 2) {
                return new Response(
                  JSON.stringify({ ok: true, results: [] }),
                  { status: 200, headers: { "Content-Type": "application/json" } },
                );
              }
              return new Response(
                JSON.stringify({ ok: true, results: [visibleRow] }),
                { status: 200, headers: { "Content-Type": "application/json" } },
              );
            }
            return new Response(
              JSON.stringify({ ok: true, results: [] }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response("{}", { status: 404 });
        }) as unknown as typeof globalThis.fetch;
        const r = await putCmd({
          cfg,
          slug: "ryw-visible",
          input: "---\ntype: concept\ntitle: T\n---\nbody",
          verifyOptions: { sleep: noopSleep },
        });
        expect(r.action).toBe("created");
        expect(mutations[0]!.mutation_type).toBe("create");
        // 2 empty-page misses + 1 hit = at least 3 verify-reads. A bare
        // `findBySlug` (no retry) would have given up after 1.
        expect(queryCallsAfterMutation).toBeGreaterThanOrEqual(3);
      } finally {
        globalThis.fetch = realFetch2;
      }
    });

    test("verify-after-write uses the FULL retry budget, not the capped empty-page budget", async () => {
      // Wire the verify to spend EXACTLY 5 attempts (the documented full
      // `READ_RETRY_ATTEMPTS` budget — see record.ts). If putCmd routed the
      // verify through a bare `findBySlug` (no retry) instead, the
      // 4th-attempt success would never be observed.
      let queryCallsAfterMutation = 0;
      let mutationFired = false;
      const visibleRow = {
        fields: {
          slug: "ryw-budget",
          title: "T",
          body: "b",
          status: "active",
          tags: [],
          created_at: "2026-06-05T00:00:00.000Z",
          updated_at: "2026-06-05T00:00:00.000Z",
        },
        key: { hash: "ryw-budget", range: null },
      };
      const realFetch2 = globalThis.fetch;
      try {
        globalThis.fetch = (async (input: unknown): Promise<Response> => {
          const url = typeof input === "string" ? input : String(input);
          if (url.endsWith("/api/mutation")) {
            mutationFired = true;
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (url.endsWith("/api/query")) {
            if (mutationFired) {
              queryCallsAfterMutation++;
              const results = queryCallsAfterMutation >= 4 ? [visibleRow] : [];
              return new Response(
                JSON.stringify({ ok: true, results }),
                { status: 200, headers: { "Content-Type": "application/json" } },
              );
            }
            return new Response(
              JSON.stringify({ ok: true, results: [] }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response("{}", { status: 404 });
        }) as unknown as typeof globalThis.fetch;
        const r = await putCmd({
          cfg,
          slug: "ryw-budget",
          input: "---\ntype: concept\ntitle: T\n---\nbody",
          verifyOptions: { sleep: noopSleep },
        });
        expect(r.action).toBe("created");
        expect(queryCallsAfterMutation).toBeGreaterThanOrEqual(4);
      } finally {
        globalThis.fetch = realFetch2;
      }
    });

    test("putCmd throws put_not_visible when the verify-read never sees the row", async () => {
      // Mutation succeeds but the verify-reads ALL return empty — fold_db
      // is reporting the write as committed without ever making it
      // queryable. putCmd must refuse to silently report "created", since
      // the caller would then conclude the data is gone.
      let mutationFired = false;
      const realFetch2 = globalThis.fetch;
      try {
        globalThis.fetch = (async (input: unknown): Promise<Response> => {
          const url = typeof input === "string" ? input : String(input);
          if (url.endsWith("/api/mutation")) {
            mutationFired = true;
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (url.endsWith("/api/query")) {
            return new Response(
              JSON.stringify({ ok: true, results: [] }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response("{}", { status: 404 });
        }) as unknown as typeof globalThis.fetch;
        await expect(
          putCmd({
            cfg,
            slug: "ryw-never",
            input: "---\ntype: concept\ntitle: T\n---\nbody",
            verifyOptions: { sleep: noopSleep, maxAttempts: 3 },
          }),
        ).rejects.toMatchObject({ code: "put_not_visible" });
        expect(mutationFired).toBe(true);
      } finally {
        globalThis.fetch = realFetch2;
      }
    });

    test("update path also verifies — row visible AFTER update is the success condition", async () => {
      // The brief asks for verify-after-write on the create path "and ideally
      // updateRecord". Pin that: an update fires, then the verify-read sees
      // the freshly-updated row (with the new title). Without the verify, an
      // update→get loop could observe the OLD title or "No record" depending
      // on which side of the propagation window we land — same RYW gap, just
      // less load-bearing than the create case.
      let mutationFired = false;
      const existing = {
        fields: {
          slug: "ryw-update",
          title: "OLD title",
          body: "old",
          status: "active",
          tags: [],
          created_at: "2026-06-01T00:00:00.000Z",
          updated_at: "2026-06-01T00:00:00.000Z",
        },
        key: { hash: "ryw-update", range: null },
      };
      const updated = {
        fields: {
          ...existing.fields,
          title: "NEW title",
          body: "new",
          updated_at: "2026-06-05T00:00:00.000Z",
        },
        key: { hash: "ryw-update", range: null },
      };
      const mutations: Array<Record<string, unknown>> = [];
      const realFetch2 = globalThis.fetch;
      try {
        globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
          const url = typeof input === "string" ? input : String(input);
          if (url.endsWith("/api/mutation")) {
            mutations.push(JSON.parse((init?.body as string) ?? "{}"));
            mutationFired = true;
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (url.endsWith("/api/query")) {
            // Pre-update: row visible with the OLD fields (drives the
            // update branch). Post-update: row visible with NEW fields.
            const body = mutationFired
              ? { ok: true, results: [updated] }
              : { ok: true, results: [existing] };
            return new Response(JSON.stringify(body), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response("{}", { status: 404 });
        }) as unknown as typeof globalThis.fetch;
        const r = await putCmd({
          cfg,
          slug: "ryw-update",
          input: "---\ntype: concept\ntitle: NEW title\n---\nnew",
          verifyOptions: { sleep: noopSleep },
        });
        expect(r.action).toBe("updated");
        expect(mutations[0]!.mutation_type).toBe("update");
      } finally {
        globalThis.fetch = realFetch2;
      }
    });
  });

  test("genuine first put still creates after retry budget (record never existed)", async () => {
    let queryCalls = 0;
    const mutations: Array<Record<string, unknown>> = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        queryCalls++;
        // No record exists — every retry returns empty.
        return { status: 200, body: { ok: true, results: [] } };
      }
      if (url.endsWith("/api/mutation")) {
        mutations.push(JSON.parse((init?.body as string) ?? "{}"));
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    const r = await putCmd({
      cfg,
      slug: "never-existed",
      // Tiny backoff so the test doesn't sit through the full retry window.
      input: "---\ntype: concept\ntitle: Fresh\n---\nfresh body",
    });
    expect(r.action).toBe("created");
    expect(queryCalls).toBeGreaterThanOrEqual(1);
    expect(mutations[0]!.mutation_type).toBe("create");
  }, 30_000);
});

// CLI search-parity (#295, CLI half): after the record-list verify-read passes,
// `putCmd` confirms the record is in the NATIVE (vector) index that
// `fbrain search` reads — the same #295 mechanism the MCP path uses — so a
// human's first `fbrain search` right after their first create returns the
// record (or, on a genuine index lag past budget, the result carries an honest
// `indexPending: true`). The vector confirm is gated to LOCAL nodes, so these
// tests use a loopback cfg (the module-level `cfg` is deliberately non-loopback
// to keep the other put tests free of the confirm round-trip).
describe("putCmd vector-index confirmation — read-after-write search parity (#295 CLI)", () => {
  const localCfg = buildTestCfg({ userHash: "uh", nodeUrl: "http://127.0.0.1:9001" });
  const noopSleep = (): Promise<void> => Promise.resolve();
  const realFetchVec = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetchVec;
  });

  // A fetch stub that always reports the row as record-list-visible (so the
  // RYW verify passes) and lets the caller decide what the native-index probe
  // returns. `searchHits` is the slug list returned by /api/native-index/search.
  function installVectorMock(opts: {
    slug: string;
    type: RecordType;
    searchHits: () => string[];
    onSearch?: () => void;
  }): void {
    const row = {
      fields: {
        slug: opts.slug,
        title: "T",
        body: "b",
        status: RECORDS[opts.type].defaultStatus,
        tags: [],
        created_at: "2026-06-05T00:00:00.000Z",
        updated_at: "2026-06-05T00:00:00.000Z",
      },
      key: { hash: opts.slug, range: null },
    };
    globalThis.fetch = (async (input: unknown): Promise<Response> => {
      const url = typeof input === "string" ? input : String(input);
      if (url.endsWith("/api/mutation")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/native-index/search")) {
        opts.onSearch?.();
        const results = opts.searchHits().map((slug) => ({
          schema_name: "s",
          field: "body",
          key_value: { hash: slug, range: null },
          value: "b",
          metadata: { score: 1 },
        }));
        return new Response(JSON.stringify({ results }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/query")) {
        // Pre-create existence check + RYW verify both see the row. (The
        // existence check on the design schema returning the row would route
        // to an UPDATE; we key the create-path tests off a concept slug whose
        // page is empty until the verify-read — but for simplicity here the row
        // is always present, so action is "updated". The confirm runs on both
        // create and update, which is exactly what we're pinning.)
        return new Response(JSON.stringify({ ok: true, results: [row] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof globalThis.fetch;
  }

  test("calls verifyVectorIndexed and reports indexPending:false once the slug is in the vector index", async () => {
    let searchCalls = 0;
    installVectorMock({
      slug: "ric-visible",
      type: "concept",
      onSearch: () => {
        searchCalls++;
      },
      searchHits: () => ["ric-visible"], // in the index from the first probe
    });
    const r = await putCmd({
      cfg: localCfg,
      slug: "ric-visible",
      input: "---\ntype: concept\ntitle: T\n---\nb",
      verifyOptions: { sleep: noopSleep },
      vectorVerifyOptions: { sleep: noopSleep },
    });
    // The write path probed the native (vector) index at least once...
    expect(searchCalls).toBeGreaterThanOrEqual(1);
    // ...and saw the slug, so it's NOT pending.
    expect(r.indexPending).toBe(false);
  });

  test("a timed-out probe (slug never appears) yields indexPending:true without failing the write", async () => {
    let searchCalls = 0;
    installVectorMock({
      slug: "ric-lagging",
      type: "concept",
      onSearch: () => {
        searchCalls++;
      },
      searchHits: () => [], // native index never surfaces the slug
    });
    const r = await putCmd({
      cfg: localCfg,
      slug: "ric-lagging",
      input: "---\ntype: concept\ntitle: T\n---\nb",
      verifyOptions: { sleep: noopSleep },
      // Pin attempts so the budget is spent quickly; no-op sleep so no backoff.
      vectorVerifyOptions: { sleep: noopSleep, maxAttempts: 3 },
    });
    // The write SUCCEEDED (no throw) despite the index never confirming...
    expect(r.action).toBeDefined();
    // ...spent its whole bounded budget probing...
    expect(searchCalls).toBe(3);
    // ...and honestly reports the index as still catching up.
    expect(r.indexPending).toBe(true);
  });

  test("a FLICKERING index (slug hits once then drops) yields indexPending:true — a single transient hit is not enough", async () => {
    // The fold_db native index's post-mutation visibility flickers: the slug
    // surfaces on one probe and is MISSING on the next. The OLD first-hit
    // criterion would report `indexPending: false` off that single transient
    // hit — a false positive, the exact bug this card fixes. With the
    // consecutive-hit bar (here 2), one isolated hit followed by a miss must
    // NOT clear `indexPending`.
    let searchCalls = 0;
    // Hit pattern across probes: miss, HIT, miss, HIT, miss, HIT — never two
    // in a row, so the streak never reaches 2 within the budget.
    const pattern = [false, true, false, true, false, true];
    installVectorMock({
      slug: "ric-flicker",
      type: "concept",
      onSearch: () => {
        searchCalls++;
      },
      searchHits: () => (pattern[searchCalls - 1] ? ["ric-flicker"] : []),
    });
    const r = await putCmd({
      cfg: localCfg,
      slug: "ric-flicker",
      input: "---\ntype: concept\ntitle: T\n---\nb",
      verifyOptions: { sleep: noopSleep },
      // 6 attempts, no real backoff; default consecutiveHits (2).
      vectorVerifyOptions: { sleep: noopSleep, maxAttempts: 6 },
    });
    // The write SUCCEEDED despite the flicker...
    expect(r.action).toBeDefined();
    // ...spent its full budget chasing a stable streak it never got...
    expect(searchCalls).toBe(6);
    // ...and honestly reports the index as still catching up (NOT a false
    // positive off the transient single hits).
    expect(r.indexPending).toBe(true);
  });

  test("a flicker that then STABILIZES (two hits in a row) yields indexPending:false", async () => {
    // Once the index settles — the slug appears on two CONSECUTIVE probes — the
    // record is genuinely stably queryable, so `indexPending` clears honestly.
    let searchCalls = 0;
    // miss, HIT, miss, HIT, HIT → streak reaches 2 on probe 5.
    const pattern = [false, true, false, true, true];
    installVectorMock({
      slug: "ric-settles",
      type: "concept",
      onSearch: () => {
        searchCalls++;
      },
      searchHits: () => (pattern[searchCalls - 1] ? ["ric-settles"] : []),
    });
    const r = await putCmd({
      cfg: localCfg,
      slug: "ric-settles",
      input: "---\ntype: concept\ntitle: T\n---\nb",
      verifyOptions: { sleep: noopSleep },
      vectorVerifyOptions: { sleep: noopSleep, maxAttempts: 6 },
    });
    // Confirmed stable on the consecutive pair (probe 5), so it stops there...
    expect(searchCalls).toBe(5);
    // ...and reports the index as caught up.
    expect(r.indexPending).toBe(false);
  });

  test("indexPending is false (confirm skipped) on a NON-loopback node — the lag gate only fires locally", async () => {
    let searchCalls = 0;
    const remoteCfg = buildTestCfg({ userHash: "uh", nodeUrl: "http://10.0.0.1:9001" });
    installVectorMock({
      slug: "ric-remote",
      type: "concept",
      onSearch: () => {
        searchCalls++;
      },
      searchHits: () => [], // would be pending IF we probed
    });
    const r = await putCmd({
      cfg: remoteCfg,
      slug: "ric-remote",
      input: "---\ntype: concept\ntitle: T\n---\nb",
      verifyOptions: { sleep: noopSleep },
      vectorVerifyOptions: { sleep: noopSleep, maxAttempts: 3 },
    });
    // The gate skipped the native-index probe entirely (remote node)...
    expect(searchCalls).toBe(0);
    // ...so the result reports not-pending rather than nagging the user.
    expect(r.indexPending).toBe(false);
  });
});
