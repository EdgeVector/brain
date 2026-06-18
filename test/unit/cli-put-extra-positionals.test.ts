// Pins the two-part fix for `fbrain put`'s positional-arg handling.
//
// (1) Extra-positional guard. Before this guard, `fbrain put design
//     storage-decision --type concept` silently dropped the second
//     positional and created a concept slugged `design` — wrong-slug
//     data, no error. Mirror delete's extra-positional guard
//     (PR #N, cli-delete-extra-positionals): reject loudly before any
//     I/O so the silent-create cannot happen.
//
// (2) Type-as-positional hint on `missing_type`. `fbrain put design`
//     (single positional that IS a record type, no `--type`, no
//     frontmatter type) used to dead-end on the generic
//     "One of: design | task | …" hint and never noticed the user's
//     first arg already named a type. Mirror withTypeAsPositionalHint
//     (used by get/status/delete): convert the missing_type error
//     into a targeted nudge at `--type <T>` / `<type> new <slug>`.
//
// Spawn-based so we exercise the real argv → parseArgs → runPut path.
// The extra-positionals tests run with an empty HOME — the guard MUST
// fire before readConfig (just like delete's). The type-as-positional
// hint test writes a valid config so we actually reach putCmd's
// missing_type path.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONFIG_VERSION } from "../../src/config.ts";
import { TEST_HASHES } from "../util.ts";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(
  args: string[],
  opts: { home?: string; configPath?: string; stdin?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fakeHome = opts.home ?? mkdtempSync(join(tmpdir(), "fbrain-put-extra-"));
  const env: Record<string, string> = {
    ...process.env,
    HOME: fakeHome,
  };
  // FBRAIN_NO_STDIN short-circuits maybeReadStdin to empty — only set when
  // the test isn't piping anything (otherwise we'd discard the piped body).
  if (opts.stdin === undefined) env.FBRAIN_NO_STDIN = "1";
  if (opts.configPath) env.FBRAIN_CONFIG = opts.configPath;
  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
    env,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

function writeTestConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "fbrain-put-extra-cfg-"));
  const configPath = join(dir, "config.json");
  const cfg = {
    configVersion: CONFIG_VERSION,
    nodeUrl: "http://127.0.0.1:65535",
    schemaServiceUrl: "http://127.0.0.1:65535",
    userHash: "uh-test",
    schemaHashes: { ...TEST_HASHES },
    designSchemaHash: TEST_HASHES.design,
    taskSchemaHash: TEST_HASHES.task,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(cfg));
  return configPath;
}

describe("fbrain put extra-positional guard", () => {
  test("`put design storage-decision --type concept` exits 1 and creates nothing", async () => {
    // The headline case: two positionals + --type. Before the guard, this
    // silently created `concept design` (dropping storage-decision). The
    // guard must fire BEFORE readConfig — proven by the empty HOME, which
    // would otherwise produce a config-missing error and shadow the hint.
    const { code, stderr } = await runCli([
      "put",
      "design",
      "storage-decision",
      "--type",
      "concept",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("put takes one slug");
    expect(stderr).toContain("2");
    // Both surplus tokens are surfaced so the user sees exactly what got
    // rejected — same shape as delete's "got N: a, b" message.
    expect(stderr).toContain("design");
    expect(stderr).toContain("storage-decision");
    // First positional was a type — hint must point at BOTH `--type` and
    // the `<type> new` subcommand, with the user's intended slug threaded in.
    expect(stderr).toContain("fbrain put storage-decision --type design");
    expect(stderr).toContain("fbrain design new storage-decision");
    // Fires before readConfig — config-missing would otherwise shadow it.
    expect(stderr).not.toMatch(/config not found/i);
    // And the bare parseArgs message must not leak.
    expect(stderr).not.toContain("Unknown option");
  });

  test("`put a b c` (three plain positionals) reports all extras", async () => {
    // No type-name first positional, so the hint falls back to the
    // generic "slug is the only positional" form rather than the
    // type-aware nudge.
    const { code, stderr } = await runCli(["put", "a", "b", "c"]);
    expect(code).toBe(2);
    expect(stderr).toContain("put takes one slug");
    expect(stderr).toContain("3");
    expect(stderr).toContain("a, b, c");
    expect(stderr).toContain("--type <T>");
    // No type-positional hint — `a` is not a record type.
    expect(stderr).not.toContain("is a record type");
  });

  test("`put my-slug extra --type design` (extras after a flag) is still rejected", async () => {
    // The guard counts positionals after parseArgs has split flags off.
    // First positional is NOT a type, so the generic hint applies.
    const { code, stderr } = await runCli([
      "put",
      "my-slug",
      "extra",
      "--type",
      "design",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("put takes one slug");
    expect(stderr).toContain("my-slug");
    expect(stderr).toContain("extra");
  });

  test("`put my-slug` (single positional) does NOT trip the guard", async () => {
    // A valid single-slug invocation must still get past the guard; it
    // will then fall through to readConfig (empty HOME → config-missing).
    // That proves the guard let a one-positional invocation through.
    const { code, stderr } = await runCli(["put", "my-slug"]);
    expect(code).toBe(1);
    expect(stderr).not.toContain("put takes one slug");
    expect(stderr.toLowerCase()).toContain("config");
  });
});

describe("fbrain put type-as-positional hint", () => {
  test("`put design` (one type-name positional, no --type) nudges at --type / <type> new", async () => {
    // Single positional, valid record type, no --type, empty stdin → the
    // putCmd path raises `missing_type`. Before this fix, the user got
    // the generic "One of: design | task | …" hint and never noticed
    // their first arg already named a valid type.
    //
    // Needs a real config to reach putCmd — the missing_type error lives
    // there, after readConfig.
    const configPath = writeTestConfig();
    // A non-empty body is required to get past the `empty_stdin` guard
    // so that putCmd actually reaches type resolution.
    const { code, stderr } = await runCli(["put", "design"], {
      configPath,
      stdin: "the body\n",
    });
    expect(code).toBe(2);
    // The targeted hint must replace the generic types list.
    expect(stderr).toContain('"design" is a record type');
    expect(stderr).toContain("fbrain put <slug> --type design");
    expect(stderr).toContain("fbrain design new <slug>");
    // The original `missing_type` message still surfaces — only the hint
    // changes — so the user still understands the underlying problem.
    expect(stderr).toContain("requires a `type:`");
  });

  test("`put my-design` (non-type positional, no --type) keeps the generic hint", async () => {
    // Fall-through guard: the type-as-positional munging must NOT fire
    // when the positional isn't a record type. The user gets the original
    // "One of: …" hint, unchanged.
    const configPath = writeTestConfig();
    const { code, stderr } = await runCli(["put", "my-design"], {
      configPath,
      stdin: "the body\n",
    });
    expect(code).toBe(2);
    expect(stderr).toContain("requires a `type:`");
    // Untouched: the original generic hint, with no type-aware nudge.
    expect(stderr).not.toContain("is a record type");
    expect(stderr).not.toContain("fbrain design new");
  });
});
