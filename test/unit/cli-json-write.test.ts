// `--json` machine-readable mode now works uniformly across the WRITE verbs
// (`<type> new`, `put`, `link`, `delete`) — not just the read verbs.
//
// Before this change the read/query verbs (get/list/search/ask/status/doctor)
// accepted `--json` and printed a parseable object/array on stdout, but the
// mutation verbs rejected it as a hard "Unknown option" (exit 2). An agent or
// script that uniformly appends `--json` to every fbrain call dead-ended on
// create/link/delete. This pins the fix: the flag parses, and the per-verb
// help documents the emitted success object.
//
// Same papercut shape (and same test shape) as the `--yes` / `-y` no-op on
// delete (cli-delete-yes-flag.test.ts): declare the option in the spec so
// parseArgs accepts it; the handler emits a structured success object on
// stdout and routes the human line to stderr. The full success-path output
// shapes are exercised by the brief's live-node VERIFY run; here we pin that
// the flag is RECOGNIZED (no usage error) at every layer, plus help docs.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { CLI_SPEC, main } from "../../src/cli.ts";
import { writeConfig } from "../../src/config.ts";
import { buildTestCfg } from "../util.ts";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-json-write-"));
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

describe("--json is a recognized flag on every write verb", () => {
  // Belt-and-braces: parseArgs at the CLI_SPEC layer accepts `--json` — pins
  // the option set itself, not just the spawn behavior. Covers the create
  // verbs (design/task share their specs with the other 6 record types),
  // put, link, and delete.
  for (const cmd of ["design", "task", "put", "link", "delete"] as const) {
    test(`CLI_SPEC.${cmd} accepts --json`, () => {
      const { values } = parseArgs({
        args: ["--json"],
        strict: true,
        allowPositionals: true,
        options: CLI_SPEC[cmd],
      });
      expect((values as { json?: boolean }).json).toBe(true);
    });
  }

  // Spawn-based: exercise the real argv → parseArgs → runXxx path. HOME is an
  // empty dir, so with `--json` accepted, control falls through to readConfig()
  // and trips ConfigMissingError — the SAME failure the plain verb produces on
  // an uninit'd machine. That proves parseArgs got past `--json` (no usage
  // error). Per #285, a failing `--json` command also emits a `{error,hint}`
  // JSON body on stdout, so we additionally pin that stdout stays parseable.
  const failCases: Array<{ name: string; args: string[] }> = [
    { name: "design new d1 --json", args: ["design", "new", "d1", "--json"] },
    { name: "task new t1 --json", args: ["task", "new", "t1", "--json"] },
    { name: "put p1 --type concept --json", args: ["put", "p1", "--type", "concept", "--json"] },
    { name: "link t1 d1 --json", args: ["link", "t1", "d1", "--json"] },
    { name: "delete x1 --json", args: ["delete", "x1", "--json"] },
  ];
  for (const { name, args } of failCases) {
    test(`\`fbrain ${name}\` parses without 'Unknown option'`, async () => {
      const { stdout, stderr } = await runCli(args);
      // The flag is accepted — no parseArgs usage error.
      expect(stderr).not.toContain("Unknown option");
      // Control reached readConfig(); empty HOME → config-missing failure.
      // Under --json, #285 routes that to a parseable {error,...} on stdout
      // (human error/hint lines stay on stderr). Pin stdout-is-JSON so the
      // agent contract — "stdout is always parseable under --json" — holds on
      // the failure path too.
      const trimmed = stdout.trim();
      expect(trimmed.length).toBeGreaterThan(0);
      const parsed = JSON.parse(trimmed);
      expect(parsed).toHaveProperty("error");
    });
  }
});

describe("write-verb help documents --json + the emitted object", () => {
  const helpCases: Array<{ cmd: string; shape: RegExp }> = [
    { cmd: "design", shape: /\{ok, type, slug\}/ },
    { cmd: "task", shape: /\{ok, type, slug\}/ },
    { cmd: "put", shape: /\{ok, slug, created\}/ },
    { cmd: "link", shape: /\{ok, from_type, from_slug, to_type, to_slug\}/ },
    { cmd: "delete", shape: /\{ok, slug, deleted\}/ },
  ];
  for (const { cmd, shape } of helpCases) {
    test(`\`fbrain help ${cmd}\` lists --json and its success object`, async () => {
      const { code, stdout } = await runCli(["help", cmd]);
      expect(code).toBe(0);
      expect(stdout).toContain("--json");
      expect(stdout).toMatch(shape);
    });
  }
});

describe("filter delete --json partial failure", () => {
  test("emits one batch payload on stdout when a per-record failure makes the command exit non-zero", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fbrain-json-delete-batch-"));
    const configPath = join(dir, "config.json");
    const cfg = buildTestCfg({ nodeUrl: "http://node.test" });
    writeConfig(cfg, configPath);

    const rows = new Map<string, Record<string, unknown>>();
    for (const slug of ["json-a", "json-b", "json-c"]) {
      rows.set(slug, {
        slug,
        title: slug,
        body: "B",
        status: "draft",
        tags: [],
        created_at: "2026-05-01T00:00:00Z",
        updated_at: "2026-05-01T00:00:00Z",
      });
    }

    const stdout: string[] = [];
    const stderr: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    const originalFetch = globalThis.fetch;
    const originalConfig = process.env.FBRAIN_CONFIG;
    console.log = ((line?: unknown) => stdout.push(String(line ?? ""))) as typeof console.log;
    console.error = ((line?: unknown) => stderr.push(String(line ?? ""))) as typeof console.error;
    process.env.FBRAIN_CONFIG = configPath;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/api/query")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        const keyHash = body.filter?.HashKey;
        if (keyHash === "json-b") {
          return new Response(JSON.stringify({ error: "injected 503" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        const results = [...rows.entries()].map(([hash, fields]) => ({
          fields,
          key: { hash, range: null },
        }));
        return new Response(JSON.stringify({ ok: true, results }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/mutation")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.mutation_type === "update") {
          rows.set(body.key_value.hash, body.fields_and_values);
        }
        return new Response(JSON.stringify({ ok: true, success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const code = await main([
        "delete",
        "--status",
        "draft",
        "--type",
        "design",
        "--yes",
        "--json",
      ]);
      expect(code).toBe(1);
      expect(stdout).toHaveLength(1);
      const payload = JSON.parse(stdout[0]!);
      expect(payload.ok).toBe(false);
      expect(payload.deleted.map((d: { slug: string }) => d.slug)).toEqual([
        "json-a",
        "json-c",
      ]);
      expect(payload.failed).toEqual([
        {
          type: "design",
          slug: "json-b",
          error: expect.stringContaining("node_http_503"),
        },
      ]);
      expect(stderr.join("\n")).toContain("failed design json-b");
      expect(stderr.join("\n")).not.toContain("error: Bulk delete");
    } finally {
      console.log = originalLog;
      console.error = originalError;
      globalThis.fetch = originalFetch;
      if (originalConfig === undefined) delete process.env.FBRAIN_CONFIG;
      else process.env.FBRAIN_CONFIG = originalConfig;
    }
  });
});
