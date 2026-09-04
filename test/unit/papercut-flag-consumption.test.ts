// The `papercut` subcommands parse ONE shared option table, so a flag meant
// for another subcommand parses cleanly and then falls on the floor. Measured
// on the live primary, 2026-09-04:
//
//   brain papercut list --status open --severity p0
//     -> 2144 rows: 108 p0, 397 p1, 1141 p2, 498 p3
//
// The flag was accepted, ignored, and — worse — named as valid by the strict
// parser's own unknown-option hint, which is where the operator had just been
// sent by a rejected `--limit`. `--kind`, `--repo` and `--tag` were dropped the
// same way. This is the third instance of one shape in this reader: the
// `<component>` positional was parsed and dropped until 2026-08-17, and the
// row projection dropped the closure columns until the same day.
//
// So these guards are structural, not per-flag. They assert that the set of
// flags a subcommand is declared to consume covers what it is actually handed,
// and that nothing in the shared table is consumed by nobody.
import { describe, expect, test } from "bun:test";
import {
  PAPERCUT_FLAGS_BY_SUBCOMMAND,
  PAPERCUT_OPTIONS,
  PAPERCUT_SUBCOMMANDS,
  assertPapercutFlagsConsumed,
} from "../../src/cli.ts";
import { PAPERCUT_LIST_FILTERS } from "../../src/commands/papercut.ts";


const OPTION_NAMES = Object.keys(PAPERCUT_OPTIONS);

describe("papercut shared flag table", () => {
  test("every subcommand declares what it consumes", () => {
    expect(Object.keys(PAPERCUT_FLAGS_BY_SUBCOMMAND).sort()).toEqual(
      [...PAPERCUT_SUBCOMMANDS].sort(),
    );
  });

  test("no subcommand claims a flag the parser does not define", () => {
    for (const [sub, flags] of Object.entries(PAPERCUT_FLAGS_BY_SUBCOMMAND)) {
      for (const f of flags) {
        expect(`${sub}:${f}`).toBe(
          `${sub}:${OPTION_NAMES.includes(f) ? f : "NOT-IN-PAPERCUT_OPTIONS"}`,
        );
      }
    }
  });

  // A flag nobody consumes is refused by all four subcommands, which is the
  // safe direction — but it is also dead weight in the parser, and finding it
  // here is cheaper than finding it from a refusal in production.
  test("no flag in the shared table is consumed by nobody", () => {
    const consumed = new Set(
      Object.values(PAPERCUT_FLAGS_BY_SUBCOMMAND).flat(),
    );
    expect(OPTION_NAMES.filter((f) => !consumed.has(f))).toEqual([]);
  });

  // The guard that would have caught the original defect: `list` applies the
  // filter table, so it must be declared to consume every filter in it.
  // `component` is the positional, not a flag.
  test("list consumes every row filter it applies", () => {
    const asFlags = PAPERCUT_LIST_FILTERS.filter(
      (f) => f !== "component" && f !== "status",
    ).map((f) => (f === "tags" ? "tag" : f));
    for (const f of asFlags) {
      expect(`list:${f}`).toBe(
        `list:${PAPERCUT_FLAGS_BY_SUBCOMMAND.list?.includes(f) ? f : "NOT-CONSUMED"}`,
      );
    }
  });
});

describe("assertPapercutFlagsConsumed", () => {
  test("passes a flag the subcommand consumes", () => {
    expect(() =>
      assertPapercutFlagsConsumed("list", { severity: "p0", status: "open" }),
    ).not.toThrow();
    expect(() =>
      assertPapercutFlagsConsumed("file", { title: "t", symptom: "s" }),
    ).not.toThrow();
  });

  // Refusing is the whole point: `census` counts by component and status, so
  // `--severity p0` there cannot narrow anything, and answering with the full
  // census is indistinguishable from answering the question asked.
  test("refuses a flag the subcommand would silently ignore", () => {
    expect(() =>
      assertPapercutFlagsConsumed("census", { severity: "p0" }),
    ).toThrow(/does not use --severity/);
    expect(() =>
      assertPapercutFlagsConsumed("close", { component: "brain" }),
    ).toThrow(/does not use --component/);
    // and it names them all at once rather than one per run
    expect(() =>
      assertPapercutFlagsConsumed("list", { title: "t", symptom: "s" }),
    ).toThrow(/--title, --symptom/);
  });

  test("an absent flag is not a stray flag", () => {
    const values: Record<string, unknown> = {};
    for (const f of OPTION_NAMES) values[f] = undefined;
    for (const sub of PAPERCUT_SUBCOMMANDS) {
      expect(() => assertPapercutFlagsConsumed(sub, values)).not.toThrow();
    }
  });

  // `--json` carries `default: false`, so parseArgs sets it on EVERY papercut
  // invocation whether or not the operator typed it. A consumption check that
  // only tested for `undefined` would have refused every call in the fleet;
  // this is the case that has to pass for all four subcommands.
  test("a flag with a parser default does not read as stray", () => {
    for (const sub of PAPERCUT_SUBCOMMANDS) {
      expect(() =>
        assertPapercutFlagsConsumed(sub, { json: false }),
      ).not.toThrow();
      expect(() =>
        assertPapercutFlagsConsumed(sub, { json: true }),
      ).not.toThrow();
    }
  });
});
