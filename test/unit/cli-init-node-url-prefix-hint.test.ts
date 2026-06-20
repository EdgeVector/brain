// Pins the prefix-aware unknown-option nudge for `fbrain init`.
//
// `init` is the one command that legitimately accepts --node-url and
// --schema-service-url, so it deliberately does NOT route through the shared
// parseCommandArgs helper (which rejects those flags). But it still owes a
// friendly nudge: the new-dev path's literal first command is often
// `fbrain init --node <url>` — the obvious abbreviation of --node-url — and
// bare parseArgs dead- ended it with `error: Unknown option '--node'` and no
// recovery.
//
// The plain Levenshtein suggester (suggestOption) can't recover this:
//   node -> node-url: dist 4, threshold 2  ⇒ rejected (the CORRECT answer)
//   node -> name:     dist 2, threshold 2  ⇒ suggested (the WRONG answer)
// So the init suggester is prefix-aware: `--node` is a prefix of `--node-url`
// and `--schema-service` of `--schema-service-url`. See suggestInitOption.
//
// Spawn-based so we exercise the real argv → parseInitArgs path. HOME points
// at an empty dir, but the nudge fires at parse time — before any network /
// config access — so an invalid flag never reaches runInit. Valid-flag
// acceptance is pinned structurally (parseArgs against CLI_SPEC.init) so we
// don't make a real init network call.

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
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-init-prefix-hint-"));
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

describe("fbrain init → prefix-aware unknown-option nudge", () => {
  test("`fbrain init --node <url>` suggests --node-url and exits 2", async () => {
    const { code, stderr } = await runCli([
      "init",
      "--node",
      "http://127.0.0.1:9322",
    ]);
    expect(code).toBe(2);
    // The bare parseArgs error must be REPLACED, not just appended to.
    expect(stderr).not.toContain("Unknown option '--node'");
    expect(stderr).toContain("Unknown option `--node`. Did you mean `--node-url`?");
    // Levenshtein would have mis-suggested --name; prefix matching must win.
    expect(stderr).not.toContain("--name");
    // Actionable hint pointing at the right flag.
    expect(stderr).toContain("fbrain init --node-url");
  });

  test("`fbrain init --schema-service <url>` suggests --schema-service-url", async () => {
    const { code, stderr } = await runCli([
      "init",
      "--schema-service",
      "http://127.0.0.1:9322",
    ]);
    expect(code).toBe(2);
    expect(stderr).not.toContain("Unknown option '--schema-service'");
    expect(stderr).toContain(
      "Unknown option `--schema-service`. Did you mean `--schema-service-url`?",
    );
  });

  test("an unrelated `--wombat` falls back gracefully (no mis-suggestion, no raw parseArgs string)", async () => {
    const { code, stderr } = await runCli([
      "init",
      "--wombat",
      "http://x",
    ]);
    expect(code).toBe(2);
    // No flag is a prefix relation or within Levenshtein threshold → clean
    // no-suggestion error with the valid-options list, not Node's bare string.
    expect(stderr).toContain("Unknown option `--wombat`.");
    expect(stderr).not.toContain("Unknown option '--wombat'");
    expect(stderr).not.toContain("Did you mean");
    expect(stderr).toContain("Valid options:");
    expect(stderr).toContain("fbrain help init");
  });

  test("init still parses --node-url and --schema-service-url unchanged (no regression)", () => {
    // Don't spawn `fbrain init` — it makes network calls. Pin the structural
    // invariant instead: parseArgs against INIT_OPTIONS (what runInitCmd uses)
    // accepts both canonical flags without throwing, so the prefix nudge can
    // never fire on a correct invocation.
    const { values } = parseArgs({
      args: [
        "--node-url",
        "http://x",
        "--schema-service-url",
        "http://y",
        "--name",
        "test",
      ],
      strict: true,
      allowPositionals: false,
      options: CLI_SPEC.init,
    });
    expect(values["node-url"]).toBe("http://x");
    expect(values["schema-service-url"]).toBe("http://y");
    expect(values.name).toBe("test");
  });
});
