// Pins per-command `COMMAND_HELP` strings to the runXxx implementations
// in `src/cli.ts`.
//
// Without this gate, help text drifts away from what `parseArgs` actually
// accepts — see the original Phase-1 `delete` drift (help said
// `[--type design|task]` long after the impl accepted all 8 RECORD_TYPES).
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

import { describe, expect, test } from "bun:test";

import { CLI_SPEC, COMMAND_HELP, COMMANDS } from "../../src/cli.ts";
import { RECORD_TYPES } from "../../src/schemas.ts";

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
