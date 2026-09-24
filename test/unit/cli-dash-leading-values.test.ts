// papercut-brain-free-text-flag-value-starting-with-dash-rejected-20260923:
// `papercut close --evidence "--help now prints ..."` was refused by strict
// parseArgs, so a batch of closes lost a row.

import { describe, expect, test } from "bun:test";
import { joinDashLeadingValues, PAPERCUT_OPTIONS } from "../../src/cli.ts";

const opts = PAPERCUT_OPTIONS as unknown as Record<string, { type?: string }>;

describe("joinDashLeadingValues", () => {
  test("a free-text value that starts with -- is joined to its flag", () => {
    expect(
      joinDashLeadingValues(["x", "--evidence", "--help now prints the contract", "--status", "fixed"], opts),
    ).toEqual(["x", "--evidence=--help now prints the contract", "--status", "fixed"]);
  });

  test("a non-flag-shaped dash value is joined (e.g. a negative number)", () => {
    expect(joinDashLeadingValues(["--title", "-5 rows"], opts)).toEqual(["--title=-5 rows"]);
    expect(joinDashLeadingValues(["--title", "-5"], opts)).toEqual(["--title=-5"]);
  });

  test("a real flag after a string option is left alone (forgotten value keeps its error)", () => {
    expect(joinDashLeadingValues(["--title", "--json"], opts)).toEqual(["--title", "--json"]);
  });

  test("boolean options and tokens after -- are untouched", () => {
    expect(joinDashLeadingValues(["--json", "--x y"], opts)).toEqual(["--json", "--x y"]);
    expect(joinDashLeadingValues(["--", "--evidence", "--a b"], opts)).toEqual(["--", "--evidence", "--a b"]);
  });

  test("an already-joined flag is untouched", () => {
    expect(joinDashLeadingValues(["--evidence=--a b"], opts)).toEqual(["--evidence=--a b"]);
  });
});
