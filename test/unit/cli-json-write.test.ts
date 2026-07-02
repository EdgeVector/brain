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

import { CLI_SPEC } from "../../src/cli.ts";

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
