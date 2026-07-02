// Unit tests for `fbrain get` — focused on the dangling-design annotation
// and the reverse-direction child-tasks listing for designs.
//
// A task's design_slug is validated on write (`task new --design` / `link`),
// so a reference that no longer resolves to a live design means the design
// was deleted out from under the task. `get` surfaces that by tagging the
// `design:` line with "(deleted)" instead of printing a live-looking pointer.
//
// For the reverse direction — `fbrain get <design>` — the record's child
// tasks render on a `tasks:` line so the parent ↔ child link is visible both
// ways from the CLI.

import { afterEach, describe, expect, test } from "bun:test";

import { getRecord } from "../../src/commands/get.ts";
import { EMPTY_PAGE_RETRY_ATTEMPTS } from "../../src/record.ts";
import { FbrainError } from "../../src/client.ts";
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

describe("getRecord — bodyLimit", () => {
  test("truncates the human body when bodyLimit is set", async () => {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.task) {
        return queryResp([
          asRow("long", taskFields("long", { body: "abcdefghijklmnopqrstuvwxyz" })),
        ]);
      }
      return queryResp([]);
    }) as unknown as typeof fetch;

    const lines: string[] = [];
    await getRecord({
      cfg,
      slug: "long",
      type: "task",
      bodyLimit: 10,
      print: (l) => lines.push(l),
    });

    const out = lines.join("\n");
    expect(out).toContain("---\nabcdefghij");
    expect(out).not.toContain("abcdefghijk");
  });

  test("truncates the --json body from the same capped record view", async () => {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.reference) {
        return queryResp([
          asRow("note", {
            slug: "note",
            title: "Note",
            body: "0123456789abcdef",
            status: "draft",
            tags: [],
            created_at: "2026-05-01T00:00:00Z",
            updated_at: "2026-05-01T00:00:00Z",
          }),
        ]);
      }
      return queryResp([]);
    }) as unknown as typeof fetch;

    const lines: string[] = [];
    await getRecord({
      cfg,
      slug: "note",
      type: "reference",
      json: true,
      bodyLimit: 6,
      print: (l) => lines.push(l),
    });

    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!) as { body: string };
    expect(payload.body).toBe("012345");
  });

  test("omitting bodyLimit keeps the full body unchanged", async () => {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.task) {
        return queryResp([asRow("full", taskFields("full", { body: "full body" }))]);
      }
      return queryResp([]);
    }) as unknown as typeof fetch;

    const lines: string[] = [];
    await getRecord({
      cfg,
      slug: "full",
      type: "task",
      print: (l) => lines.push(l),
    });

    expect(lines.join("\n")).toContain("---\nfull body");
  });
});

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

  test("a task with no design reference prints '(none)' and only sees design during backlinks scan", async () => {
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
    expect(designProbes).toBe(1);
  });
});

// `fbrain get <design>` now mirrors `fbrain get <task>`: the latter has shown
// the parent `design:` line since Phase 1, so the design must symmetrically
// show its children. Without this, a developer who organizes work as a design
// with tasks underneath cannot see that structure back from the CLI — the only
// recourse was `fbrain get <each-task>` one slug at a time.
describe("getRecord — design's child tasks listing", () => {
  test("design with child tasks renders them on a `tasks:` line, newest first", async () => {
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
          // A task under a DIFFERENT design must not leak into this design's
          // children — the filter is on `design_slug`, not "any task".
          asRow(
            "unrelated",
            taskFields("unrelated", {
              design_slug: "other-design",
              status: "open",
              updated_at: "2026-05-04T00:00:00Z",
            }),
          ),
        ]);
      }
      return queryResp([]);
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    await getRecord({ cfg, slug: "auth", type: "design", print: (l) => lines.push(l) });
    const out = lines.join("\n");
    // login-ui has the newer updated_at, so it sorts first.
    expect(out).toContain("tasks:      login-ui (open), wire-oauth (in_progress)");
    expect(out).not.toContain("unrelated");
  });

  test("childless design renders '(none)' and does NOT burn the full read-retry budget", async () => {
    // Cost-discipline regression: on a fresh node, every type's page is
    // legitimately empty until its first record lands. If the reverse-direction
    // probe used the full 5× read-retry budget, `fbrain get <design>` on a
    // fresh-node design would block ~1.1 s of pure backoff just to confirm
    // "no children" — re-introducing the first-write-of-a-type latency cliff
    // that the forward fast-miss helper already fixed. Pin the cap.
    let taskQueries = 0;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.design) {
        return queryResp([asRow("solo", designFields("solo"))]);
      }
      if (body.schema_name === TEST_HASHES.task) {
        taskQueries++;
        // Empty page (fresh-node task schema) — the only branch that retries.
        return queryResp([]);
      }
      return queryResp([]);
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    await getRecord({ cfg, slug: "solo", type: "design", print: (l) => lines.push(l) });
    expect(lines.join("\n")).toContain("tasks:      (none)");
    // Worst-case ride-out is EMPTY_PAGE_RETRY_ATTEMPTS task queries, plus the
    // one full-corpus backlinks scan added by the backlinks API — never
    // the 5× READ_RETRY_ATTEMPTS budget. Asserting equality (not <=) pins the
    // contract: the cap is the cap.
    expect(taskQueries).toBe(EMPTY_PAGE_RETRY_ATTEMPTS + 1);
  }, 30_000);

  test("design with populated task page but no matching children renders '(none)' on ONE query", async () => {
    // Populated-page authoritative-miss: if the task schema has rows but none
    // match this design's slug, that is authoritative "no children" — no
    // retry, no burn. Mirrors the forward fast-miss contract.
    let taskQueries = 0;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.design) {
        return queryResp([asRow("standalone", designFields("standalone"))]);
      }
      if (body.schema_name === TEST_HASHES.task) {
        taskQueries++;
        return queryResp([
          asRow("other", taskFields("other", { design_slug: "different-design" })),
        ]);
      }
      return queryResp([]);
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    await getRecord({ cfg, slug: "standalone", type: "design", print: (l) => lines.push(l) });
    expect(lines.join("\n")).toContain("tasks:      (none)");
    expect(taskQueries).toBe(2);
  });

  test("non-design records do NOT issue a task-children probe beyond backlinks", async () => {
    // The reverse-direction probe is gated on `found.type === "design"`. A
    // task's `fbrain get` resolves with ONE task query (the type-narrowed
    // sweep) plus ONE backlinks scan. If the gate ever regresses, a third
    // task query (the children probe of the task itself) would land.
    let taskQueries = 0;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.task) {
        taskQueries++;
        return queryResp([
          asRow("loner", taskFields("loner", { design_slug: "" })),
        ]);
      }
      return queryResp([]);
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    await getRecord({ cfg, slug: "loner", type: "task", print: (l) => lines.push(l) });
    expect(lines.join("\n")).toContain("[task] loner");
    expect(taskQueries).toBe(2);
  });

  test("linked_from includes explicit design links and body wiki references", async () => {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.design) {
        return queryResp([asRow("auth", designFields("auth"))]);
      }
      if (body.schema_name === TEST_HASHES.task) {
        return queryResp([
          asRow("wire-oauth", taskFields("wire-oauth", { design_slug: "auth" })),
          asRow(
            "note-auth",
            taskFields("note-auth", { body: "See [[auth]] for the decision." }),
          ),
        ]);
      }
      return queryResp([]);
    }) as unknown as typeof fetch;

    let captured: unknown;
    const lines: string[] = [];
    await getRecord({
      cfg,
      slug: "auth",
      type: "design",
      print: (l) => lines.push(l),
      onResult: (json) => {
        captured = json;
      },
    });
    expect(lines.join("\n")).toContain("linked_from: task note-auth (body), task wire-oauth (explicit)");
    expect(captured).toMatchObject({
      linked_from: [
        { type: "task", slug: "note-auth", via: ["body"] },
        { type: "task", slug: "wire-oauth", via: ["explicit"] },
      ],
    });
  });
});

// Ambiguous-slug contract. Before this fix, `fbrain get <slug>` on a slug that
// existed under multiple types printed EVERY matching record's full body to
// stdout AND THEN errored — contradictory output that broke `r=$(fbrain get
// foo)` scripts (two record bodies on stdout, exit 1). Now `get` defers to the
// same single clean `ambiguous_slug` throw `status` and `delete` already emit:
// nothing on stdout, the error on stderr, exit 1.
describe("getRecord — ambiguous slug", () => {
  test("ambiguous slug throws ambiguous_slug AND writes nothing via print", async () => {
    // Same slug under TWO schemas (task + concept) — the dogfood evidence
    // case. Pre-fix: print fired twice with full record bodies before the
    // throw. Post-fix: print MUST NOT fire — stdout stays empty.
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.task) {
        return queryResp([asRow("t1", taskFields("t1", { title: "first task" }))]);
      }
      if (body.schema_name === TEST_HASHES.concept) {
        return queryResp([
          asRow("t1", {
            slug: "t1",
            title: "T",
            body: "",
            status: "draft",
            tags: [],
            created_at: "2026-05-01T00:00:00Z",
            updated_at: "2026-05-01T00:00:00Z",
          }),
        ]);
      }
      return queryResp([]);
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    let err: unknown;
    try {
      await getRecord({ cfg, slug: "t1", print: (l) => lines.push(l) });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FbrainError);
    expect((err as FbrainError).code).toBe("ambiguous_slug");
    expect((err as FbrainError).message).toContain(
      'Slug "t1" exists in multiple schemas',
    );
    // The bug: stdout (here, print) emitted both record bodies before the
    // throw. The fix's whole point — assert zero writes.
    expect(lines).toEqual([]);
  }, 30_000);

  test("--type disambiguates: prints the one matching record, no throw", async () => {
    // No regression on the documented escape hatch. `fbrain get t1 --type task`
    // must still resolve cleanly and print exactly the task record.
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.task) {
        return queryResp([asRow("t1", taskFields("t1", { title: "first task" }))]);
      }
      return queryResp([]);
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    await getRecord({ cfg, slug: "t1", type: "task", print: (l) => lines.push(l) });
    const out = lines.join("\n");
    expect(out).toContain("[task] t1");
    expect(out).toContain("title:      first task");
  });

  test("unique slug across all schemas: prints the one record, no throw", async () => {
    // No regression on the common path: a slug present in exactly one schema
    // resolves cleanly under untyped `get`.
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.task) {
        return queryResp([asRow("unique", taskFields("unique"))]);
      }
      return queryResp([]);
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    await getRecord({ cfg, slug: "unique", print: (l) => lines.push(l) });
    expect(lines.join("\n")).toContain("[task] unique");
  });
});

// Key-normalization parity with `put` (and the matching fixes already on
// `delete` / `link` / `status`). `put`'s slug resolver silently trims, so a
// record created via `fbrain put " foo "` lands under slug "foo". Pre-fix,
// `fbrain get " foo "` then failed with `No <type>: foo` because the lookup
// compared the untrimmed input against the trimmed stored slug — leaving
// the row unreadable from the CLI on the same input that created it.
describe("getRecord — slug whitespace trim (parity with put/delete/link/status)", () => {
  test("`get \" foo \"` resolves the row stored under \"foo\"", async () => {
    // The row sits under slug "foo" (how put would have written it after
    // trimming " foo "). The fix is the trim at the call site — without it,
    // findBySlug compares " foo " strictly against the stored "foo" and
    // misses. Pin via a typed lookup so the assertion isolates the trim
    // behavior from the untyped cross-schema sweep.
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.task) {
        return queryResp([asRow("foo", taskFields("foo", { title: "trimmed" }))]);
      }
      return queryResp([]);
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    // Note the surrounding whitespace — what a shell autocomplete or
    // copy-paste might leave on the slug. `put " foo "` stored slug "foo".
    await getRecord({
      cfg,
      slug: "  foo  ",
      type: "task",
      print: (l) => lines.push(l),
    });
    const out = lines.join("\n");
    expect(out).toContain("[task] foo");
    expect(out).toContain("title:      trimmed");
  });

  test("untyped sweep also trims (resolver finds the right row across types)", async () => {
    // Same parity: `put " bar "` (no --type, e.g. from frontmatter) stores
    // under "bar"; `get " bar "` (no --type) must trim before the cross-type
    // sweep so the resolver locates the stored row.
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.task) {
        return queryResp([asRow("bar", taskFields("bar"))]);
      }
      return queryResp([]);
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    await getRecord({ cfg, slug: "  bar  ", print: (l) => lines.push(l) });
    expect(lines.join("\n")).toContain("[task] bar");
  });

  test("not-found message uses the trimmed slug (consistent display)", async () => {
    // When the row genuinely doesn't exist, the error should echo the
    // trimmed form — matches what delete / status / link print, so a user
    // copying the error string back into another command doesn't carry the
    // padding forward.
    globalThis.fetch = (async (_input: unknown, _init?: RequestInit) => {
      return queryResp([]);
    }) as unknown as typeof fetch;
    let err: unknown;
    try {
      await getRecord({
        cfg,
        slug: "  missing  ",
        type: "task",
        print: () => {},
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FbrainError);
    expect((err as FbrainError).code).toBe("not_found");
    expect((err as FbrainError).message).toBe("No task: missing");
  }, 30_000);
});
