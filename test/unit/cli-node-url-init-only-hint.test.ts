// Pins the targeted hint for `fbrain <non-init> --node-url <URL>` and
// `--schema-service-url <URL>`.
//
// Both flags are intentionally accepted ONLY by `fbrain init` — the node and
// schema-service are pinned in ~/.fbrain/config.json at init time and every
// other command reads from config. Before this guard, a user who had run
// `fbrain init --node-url X` and reflexively reached for the same flag on
// `list` / `doctor` / etc. dead-ended on parseArgs's bare "Unknown option"
// with zero guidance toward config/init. Worse, on commands that take
// positionals (`get foo --node-url http://x`) parseArgs's message actively
// misled them with `-- "--node-url"` — which would create/lookup a record
// literally slugged `--node-url`.
//
// Same papercut shape as the `put --title` / `put --body` nudges (#149/#151,
// pinned in cli-put-title-flag-hint.test.ts / cli-put-body-flag-hint.test.ts):
// turn a raw parseArgs failure into a targeted FbrainError. The bare
// parseArgs message must NOT leak through.
//
// Spawn-based so we exercise the real argv → parseArgs → run* path with the
// shared parseCommandArgs helper in cli.ts. HOME points at an empty dir so
// readConfig() would throw a ConfigMissingError if it ran — the nudge MUST
// fire before readConfig, otherwise a brand-new uninit'd machine would see
// the config error and never reach the actionable hint.

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
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-node-url-hint-"));
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

describe("fbrain <non-init> --node-url / --schema-service-url → init-only nudge", () => {
  test("`fbrain list --node-url http://x` exits 1 with an init-only nudge", async () => {
    const { code, stderr } = await runCli(["list", "--node-url", "http://x"]);
    expect(code).toBe(2);
    // The bare parseArgs error must be replaced — not just appended to.
    expect(stderr).not.toContain("Unknown option");
    // Points at where the flag actually belongs.
    expect(stderr).toContain("fbrain init");
    expect(stderr).toContain("~/.fbrain/config.json");
    // Fires before readConfig — the empty-HOME would otherwise produce a
    // config-missing error and shadow the hint.
    expect(stderr).not.toMatch(/config not found/i);
  });

  test("`fbrain get foo --schema-service-url http://x` does NOT suggest the misleading `-- \"--node-url\"` workaround", async () => {
    // `get` takes positionals, so parseArgs's bare error volunteered the
    // `-- "--<flag>"` positional escape — which would create/lookup a record
    // literally slugged `--schema-service-url`. The nudge must REPLACE that
    // advice, not append to it.
    const { code, stderr } = await runCli([
      "get",
      "foo",
      "--schema-service-url",
      "http://x",
    ]);
    expect(code).toBe(2);
    expect(stderr).not.toContain("Unknown option");
    expect(stderr).not.toContain('-- "--');
    expect(stderr).toContain("fbrain init");
    expect(stderr).toContain("~/.fbrain/config.json");
  });

  test("`fbrain doctor --node-url http://x` (no-positionals command) also emits the nudge", async () => {
    const { code, stderr } = await runCli([
      "doctor",
      "--node-url",
      "http://x",
    ]);
    expect(code).toBe(2);
    expect(stderr).not.toContain("Unknown option");
    expect(stderr).toContain("fbrain init");
  });

  test("init still accepts --node-url and --schema-service-url unchanged", () => {
    // Don't spawn `fbrain init` itself — it makes network calls. Instead pin
    // the structural invariant: parseArgs against INIT_OPTIONS (the actual
    // option set runInitCmd uses) accepts both flags without throwing. If
    // someone accidentally removes either from INIT_OPTIONS, the nudge would
    // start firing on init too — which is the regression this test guards.
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
  });

  test("the existing `put --title` nudge still produces its frontmatter/H1 message (no regression)", async () => {
    // `put --title` was the first command routed through this papercut
    // pattern (#149). Routing put through the shared parseCommandArgs helper
    // must not regress that nudge — assert at least the title-specific
    // wording the original test pins is still present.
    const { code, stderr } = await runCli(["put", "foo", "--title", "X"]);
    expect(code).toBe(2);
    expect(stderr).not.toContain("Unknown option");
    expect(stderr).toContain("frontmatter");
    // No `--type` in args → falls back to the concrete `concept` example
    // (copy-pasteable; the literal `<type>` placeholder is never emitted).
    expect(stderr).toContain("fbrain concept new foo --title");
    // And critically, the put-title path must NOT have been swallowed by the
    // generic node-url helper (no node-url leak in the title message).
    expect(stderr).not.toContain("--node-url");
  });

  test("unrelated unknown options still surface parseArgs's bare message (no over-absorption)", async () => {
    // The nudge is keyed strictly on `--node-url` / `--schema-service-url`.
    // A truly unknown option like `--bogus` must fall through — otherwise
    // we'd be silently absorbing every typo and pointing users at init.
    const { code, stderr } = await runCli(["list", "--bogus"]);
    expect(code).toBe(2);
    expect(stderr).toContain("Unknown option '--bogus'");
    expect(stderr).not.toContain("fbrain init");
  });
});
