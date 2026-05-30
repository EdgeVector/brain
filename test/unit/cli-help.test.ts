// Pins per-command `COMMAND_HELP` strings to the runXxx implementations
// in `src/cli.ts`, and pins the top-level `TOP_HELP` Commands block to
// the `COMMANDS` list.
//
// Without this gate, help text drifts away from what `parseArgs` actually
// accepts — see the original Phase-1 `delete` drift (help said
// `[--type design|task]` long after the impl accepted all 8 RECORD_TYPES),
// and the 2026-05-25 dogfood that caught `TOP_HELP`'s `put` line still
// claiming "upsert a Design or Task" long after `put` accepted all 8 types.
//
// What we pin:
//   1. `COMMAND_HELP` keys exactly match the `COMMANDS` list (no command
//      ships without a help block; no help block points to a phantom
//      command).
//   2. For each command, every `--<flag>` token in the help body
//      corresponds to a real option in `CLI_SPEC[cmd]`. The globals
//      `--verbose`, `--help`, and `-h` are stripped by `main()` before
//      dispatch and intentionally ignored.
//   3. The `delete` help mentions every entry of `RECORD_TYPES`
//      (regression pin for the design|task→all-8 drift).
//   4. `TOP_HELP`'s `Commands:` block lists exactly the commands in
//      `COMMANDS` — catches stale entries AND missing entries when a
//      new command is added.
//   5. `TOP_HELP`'s `put` row does not claim `put` is design/task-only
//      (regression pin for the 2026-05-25 drift).

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { CLI_SPEC, COMMAND_HELP, COMMANDS, TOP_HELP } from "../../src/cli.ts";
import { RECORD_TYPES } from "../../src/schemas.ts";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, FBRAIN_NO_STDIN: "1" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

const GLOBAL_FLAGS = new Set(["--verbose", "--help"]);

// Pull `--flag` tokens from declarative help — synopsis lines (start with
// `fbrain `) and indented option-list lines (start with whitespace + `--`).
// Body prose (column-0 sentences like "no --force flag") is intentionally
// ignored — those reference flags that don't belong to the current command
// and would otherwise produce false positives.
function extractFlagTokens(text: string): string[] {
  const declarative = text
    .split("\n")
    .filter((l) => l.trim().startsWith("fbrain ") || /^\s+--/.test(l))
    .join("\n");
  const matches = declarative.match(/--[a-z][a-z0-9-]*/g) ?? [];
  return matches.filter((f) => !GLOBAL_FLAGS.has(f));
}

describe("COMMAND_HELP <-> CLI_SPEC alignment", () => {
  test("COMMAND_HELP keys match COMMANDS exactly", () => {
    expect(new Set(Object.keys(COMMAND_HELP))).toEqual(new Set(COMMANDS));
  });

  for (const cmd of COMMANDS) {
    test(`every --flag in COMMAND_HELP.${cmd} is a real CLI_SPEC option`, () => {
      const help = COMMAND_HELP[cmd];
      const known = new Set(
        Object.keys(CLI_SPEC[cmd] as Record<string, unknown>).map((k) => `--${k}`),
      );
      const documented = new Set(extractFlagTokens(help));
      const orphans = [...documented].filter((f) => !known.has(f));
      expect(orphans).toEqual([]);
    });
  }

  test("delete help lists every RECORD_TYPES entry (regression pin)", () => {
    const help = COMMAND_HELP.delete;
    for (const type of RECORD_TYPES) {
      expect(help).toContain(type);
    }
  });
});

// Pull the first whitespace-delimited token from each line in `TOP_HELP`'s
// `Commands:` block. Two-word entries like `design new` and `help <cmd>`
// reduce to their first token — that's the canonical name in `COMMANDS`.
function extractTopHelpCommandNames(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === "Commands:");
  if (start < 0) throw new Error("TOP_HELP missing 'Commands:' header");
  const names: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") break;
    const m = line.match(/^\s{2,}(\S+)/);
    if (m?.[1]) names.push(m[1]);
  }
  return names;
}

describe("TOP_HELP <-> COMMANDS alignment", () => {
  test("TOP_HELP Commands block lists exactly the commands in COMMANDS", () => {
    const documented = extractTopHelpCommandNames(TOP_HELP);
    expect(new Set(documented)).toEqual(new Set(COMMANDS));
  });

  test("TOP_HELP put row does not claim put is design/task-only (regression pin)", () => {
    const putLine = TOP_HELP.split("\n").find((l) => /^\s{2,}put\s/.test(l));
    expect(putLine).toBeDefined();
    expect(putLine).not.toMatch(/Design or Task/);
  });
});

// `TOP_HELP` lists the two compound commands as `design new` and `task new`,
// so users copy-pasting those exact names into `fbrain help` should land on
// the right per-command usage — whether they quote the two-word name
// ("help \"design new\"") or pass it as two tokens ("help design new").
describe("`fbrain help` accepts the two-word names from TOP_HELP", () => {
  test('help "design new" matches help design (exit 0, same usage)', async () => {
    const [baseline, quoted] = await Promise.all([runCli(["help", "design"]), runCli(["help", "design new"])]);
    expect(baseline.code).toBe(0);
    expect(quoted.code).toBe(0);
    expect(quoted.stdout).toBe(baseline.stdout);
    expect(quoted.stderr).toBe("");
  });

  test('help "task new" matches help task (exit 0, same usage)', async () => {
    const [baseline, quoted] = await Promise.all([runCli(["help", "task"]), runCli(["help", "task new"])]);
    expect(baseline.code).toBe(0);
    expect(quoted.code).toBe(0);
    expect(quoted.stdout).toBe(baseline.stdout);
    expect(quoted.stderr).toBe("");
  });

  test("help design new (two unquoted tokens) matches help design", async () => {
    const [baseline, split] = await Promise.all([runCli(["help", "design"]), runCli(["help", "design", "new"])]);
    expect(baseline.code).toBe(0);
    expect(split.code).toBe(0);
    expect(split.stdout).toBe(baseline.stdout);
  });

  test("help bogus still errors (exit 1)", async () => {
    const { code, stderr } = await runCli(["help", "bogus"]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/Unknown command: bogus/);
  });
});
