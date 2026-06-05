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
import { TEST_HASHES, buildTestCfg } from "../util.ts";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

const cfg = buildTestCfg({ userHash: "uh" });

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
      });
      expect(mutations).toHaveLength(1);
      expect(mutations[0]!.mutation_type).toBe("create");
      expect(mutations[0]!.schema).toBe(TEST_HASHES[type]);
      const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
      expect(fields.slug).toBe(`${type}-slug`);
      expect(fields.title).toBe(`${type} title`);
      expect(fields.body).toBe(`${type} body`);
      expect(fields.tags).toEqual(["t1"]);
      expect(fields.status).toBe(RECORDS[type].defaultStatus);
      // None of the Phase 6 types carry a design_slug field.
      expect(fields).not.toHaveProperty("design_slug");
    });
  }
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
    expect(code).toBe(1);
    // Type-specific synopsis line lands in stderr, proving the dispatcher
    // routed to runRecordNew("concept", …) and used COMMAND_HELP.concept.
    expect(stderr).toContain("fbrain concept new");
  });

  test("`fbrain spike nwe x` suggests `spike new` via the per-type subcommand error", async () => {
    const { code, stderr } = await runCli(["spike", "nwe", "x"]);
    expect(code).toBe(1);
    expect(stderr).toContain("Unknown spike subcommand: nwe");
    expect(stderr).toContain("spike new");
  });
});
