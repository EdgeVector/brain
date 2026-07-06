// Unit tests for the shared `<type> new` creator behind every
// `fbrain <type> new` verb. design / task have their own focused tests
// (test/unit/design.test.ts, task.test.ts) that pin the slug-already-
// exists hedge against /api/query truncation. This file pins:
//
//   1. recordNew() with `type` set to each of the 6 Phase 6 types writes
//      a create mutation against the correct schema hash and with the
//      correct default status.
//   2. recordNew rejects `--design` on non-task types (`design_flag_unsupported`)
//      before any I/O — the option set is shared with task at the parse
//      layer so the runtime rejects misuse loudly instead of silently
//      ignoring the parent-link.
//   3. The dispatcher recognises each new verb and dispatches with the
//      type bound correctly (spawn-based sanity check — exercises argv →
//      parseArgs → runRecordNew without standing up a node).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordNew } from "../../src/commands/new.ts";
import { RECORDS, type RecordType } from "../../src/schemas.ts";
import { tagIndexSlug } from "../../src/tag-index.ts";
import { TEST_HASHES, buildTestCfg } from "../util.ts";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

const cfg = buildTestCfg({ userHash: "uh" });

// No-op sleep so the post-write vector-index confirmation (which probes a
// native-index URL these mocks 404) doesn't pay real backoff. These tests
// assert create-dispatch / collision-note behavior, not search-parity (pinned
// in its own describe block below).
const VEC = { vectorVerifyOptions: { sleep: () => Promise.resolve() } } as const;

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

// The 6 types REPRO calls out as missing a `<type> new` verb pre-fix:
// concept, preference, reference, agent, project, spike. design + task
// already had per-type tests; this file pins parity for the other six.
const PHASE_6_TYPES: readonly RecordType[] = [
  "concept",
  "preference",
  "reference",
  "agent",
  "project",
  "spike",
];

describe("recordNew dispatches against the correct schema for each type", () => {
  for (const type of PHASE_6_TYPES) {
    test(`type=${type} writes a create against ${type}'s schema hash with the type's default status`, async () => {
      const mutations: Array<Record<string, unknown>> = [];
      installMock((url, init) => {
        if (url.endsWith("/api/query")) {
          return { status: 200, body: { ok: true, results: [] } };
        }
        if (url.endsWith("/api/mutation")) {
          mutations.push(JSON.parse((init?.body as string) ?? "{}"));
          return { status: 200, body: { ok: true } };
        }
        return { status: 404 };
      });
      await recordNew({
        cfg,
        type,
        slug: `${type}-slug`,
        title: `${type} title`,
        body: `${type} body`,
        tags: ["t1"],
        ...VEC,
      });
      expect(mutations).toHaveLength(2);
      expect(mutations[0]!.mutation_type).toBe("create");
      expect(mutations[0]!.schema).toBe(TEST_HASHES[type]);
      const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
      expect(fields.slug).toBe(`${type}-slug`);
      expect(fields.title).toBe(`${type} title`);
      expect(fields.body).toBe(`${type} body`);
      expect(fields.tags).toEqual(["t1"]);
      expect(fields.status).toBe(RECORDS[type].defaultStatus);
      const indexFields = mutations[1]!.fields_and_values as Record<string, unknown>;
      expect(indexFields.slug).toBe(tagIndexSlug("t1"));
      expect(indexFields.members).toEqual([`${type}:${type}-slug`]);
      // None of the Phase 6 types carry a design_slug field.
      expect(fields).not.toHaveProperty("design_slug");
    });
  }
});

// The cross-type slug-collision NOTE: creating a record whose slug already
// exists under a DIFFERENT type prints a non-fatal stderr note that names
// `--type`, but never blocks the create and never fires for a unique slug or a
// same-type duplicate. Drive recordNew directly, capturing console.error.
describe("recordNew warns on cross-type slug collision", () => {
  let captured: string[] = [];
  const realErr = console.error;

  afterEach(() => {
    console.error = realErr;
    captured = [];
  });

  function captureStderr(): void {
    console.error = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
  }

  // Mock that reports the given slug as already present under `holderType`
  // (and only that type), so the cross-type probe sees exactly one collision.
  function installCollisionMock(holderHash: string, slug: string): {
    mutations: Array<Record<string, unknown>>;
  } {
    const mutations: Array<Record<string, unknown>> = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        const body = JSON.parse((init?.body as string) ?? "{}") as {
          schema_name?: string;
        };
        if (body.schema_name === holderHash) {
          return {
            status: 200,
            body: {
              ok: true,
              results: [
                { key: { hash: "h", range: "r" }, fields: { slug, tags: [] } },
              ],
            },
          };
        }
        return { status: 200, body: { ok: true, results: [] } };
      }
      if (url.endsWith("/api/mutation")) {
        mutations.push(JSON.parse((init?.body as string) ?? "{}"));
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    return { mutations };
  }

  test("creating a design whose slug exists as a task emits the --type note and still creates", async () => {
    captureStderr();
    // `wire-login` already exists as a task; now create the design.
    const { mutations } = installCollisionMock(TEST_HASHES.task, "wire-login");
    await recordNew({
      cfg,
      type: "design",
      slug: "wire-login",
      title: "dup slug across type",
      body: "",
      tags: [],
      ...VEC,
    });
    // The create still happened (non-blocking warning).
    expect(mutations).toHaveLength(1);
    expect(mutations[0]!.mutation_type).toBe("create");
    expect(mutations[0]!.schema).toBe(TEST_HASHES.design);
    // The note fired, names the colliding type AND the --type recovery flag.
    const note = captured.find((l) => l.startsWith("note:"));
    expect(note).toBeDefined();
    expect(note).toContain('slug "wire-login"');
    expect(note).toContain("task");
    expect(note).toContain("--type design");
  });

  test("creating a unique slug emits NO note (no false positives)", async () => {
    captureStderr();
    // Every type's page is empty ⇒ no collision.
    installMock((url) => {
      if (url.endsWith("/api/query")) return { status: 200, body: { ok: true, results: [] } };
      if (url.endsWith("/api/mutation")) return { status: 200, body: { ok: true } };
      return { status: 404 };
    });
    await recordNew({
      cfg,
      type: "design",
      slug: "totally-unique-slug",
      title: "fresh",
      body: "",
      tags: [],
      ...VEC,
    });
    expect(captured.find((l) => l.startsWith("note:"))).toBeUndefined();
  });

  test("a same-type duplicate still errors slug_already_exists and emits no cross-type note", async () => {
    captureStderr();
    // The SAME type (design) already holds the slug ⇒ the same-type guard
    // throws BEFORE the cross-type probe runs, so no note.
    installCollisionMock(TEST_HASHES.design, "wire-login");
    await expect(
      recordNew({ cfg, type: "design", slug: "wire-login", title: "x", body: "", tags: [] }),
    ).rejects.toMatchObject({ code: "slug_already_exists" });
    expect(captured.find((l) => l.startsWith("note:"))).toBeUndefined();
  });

  test("a probe failure never blocks the create (best-effort)", async () => {
    captureStderr();
    // Every /api/query 500s. The same-type guard resolves via findBySlug
    // (returns null on a non-throwing miss); the cross-type probe swallows the
    // error. The create must still succeed.
    let mutationSeen = false;
    installMock((url) => {
      if (url.endsWith("/api/query")) return { status: 200, body: { ok: true, results: [] } };
      if (url.endsWith("/api/mutation")) {
        mutationSeen = true;
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    await recordNew({ cfg, type: "design", slug: "x", title: "x", body: "", tags: [], ...VEC });
    expect(mutationSeen).toBe(true);
    expect(captured.find((l) => l.startsWith("note:"))).toBeUndefined();
  });
});

describe("recordNew rejects --design on non-task types", () => {
  for (const type of PHASE_6_TYPES) {
    test(`type=${type} + designSlug throws design_flag_unsupported before any I/O`, async () => {
      let calls = 0;
      installMock(() => {
        calls++;
        return { status: 500 };
      });
      await expect(
        recordNew({
          cfg,
          type,
          slug: "x",
          title: "x",
          body: "",
          tags: [],
          designSlug: "some-design",
        }),
      ).rejects.toMatchObject({ code: "design_flag_unsupported" });
      expect(calls).toBe(0);
    });
  }
});

// Spawn-based check that each new verb is wired through the CLI to the
// recordNew dispatch. HOME points at an empty dir so readConfig() throws
// `config missing` — that's the signal that argv parsing got past the
// "Unknown command" gate (the pre-fix dead-end), reached the dispatcher,
// and only stopped when it tried to read the (missing) config. Without
// the new wiring the same invocation would exit with "Unknown command:
// <type>" instead.
describe("`fbrain <type> new <slug>` is recognised for every record type", () => {
  async function runCli(
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-cli-new-"));
    const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env, FBRAIN_NO_STDIN: "1", HOME: fakeHome },
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, stdout, stderr };
  }

  for (const type of PHASE_6_TYPES) {
    test(`\`fbrain ${type} new x\` is not an Unknown command (reaches dispatch)`, async () => {
      const { code, stderr } = await runCli([type, "new", "x"]);
      // We expect exit 1 (config missing on an empty HOME) — what we're
      // pinning is the negative: NOT the pre-fix "Unknown command: <type>"
      // dead-end and NOT a parseArgs flag-rejection.
      expect(code).toBe(1);
      expect(stderr).not.toMatch(/Unknown command:/);
      expect(stderr).not.toMatch(new RegExp(`Unknown ${type} subcommand`));
      // Reached readConfig — proves dispatch wired the verb through.
      expect(stderr.toLowerCase()).toContain("config");
    });
  }

  test("`fbrain concept new` (no slug) prints the type-specific help, not generic", async () => {
    const { code, stderr } = await runCli(["concept", "new"]);
    expect(code).toBe(2);
    // Type-specific synopsis line lands in stderr, proving the dispatcher
    // routed to runRecordNew("concept", …) and used COMMAND_HELP.concept.
    expect(stderr).toContain("fbrain concept new");
  });

  test("`fbrain spike nwe x` suggests `spike new` via the per-type subcommand error", async () => {
    const { code, stderr } = await runCli(["spike", "nwe", "x"]);
    expect(code).toBe(2);
    expect(stderr).toContain("Unknown spike subcommand: nwe");
    expect(stderr).toContain("spike new");
  });
});
