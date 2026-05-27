// Unit tests for the shared table formatter used by list / search / ask.
//
// The motivating dogfood was hard-coded `padEnd(28)` in three commands:
// any slug longer than 28 chars (and we have several — the longest
// real-world one is 54 chars, `agent-pr-events-2026-05-25-…-master`)
// blew past the column and the status/score column landed at a
// different offset on every row. The replacement sizes columns from
// the actual rows being printed.

import { describe, expect, test } from "bun:test";

import { formatTable } from "../../src/format.ts";

describe("formatTable", () => {
  test("empty rows → empty output", () => {
    expect(formatTable([])).toEqual([]);
  });

  test("sizes each column to the widest cell in that column", () => {
    const out = formatTable([
      ["a", "short", "x"],
      ["alpha", "longer-cell", "y"],
      ["abc", "mid", "zzzzzzz"],
    ]);
    // Column widths: 5 (alpha), 11 (longer-cell), last-col not padded.
    expect(out[0]).toBe("a      short        x");
    expect(out[1]).toBe("alpha  longer-cell  y");
    expect(out[2]).toBe("abc    mid          zzzzzzz");
    // Every non-last cell pads to the same column width — assert by
    // pulling the second column out at the same offset.
    const col1Start = "alpha  ".length;
    for (const line of out) {
      expect(line.slice(col1Start, col1Start + "longer-cell".length).trimEnd().length)
        .toBeGreaterThan(0);
    }
  });

  test("never pads the right-most column (no trailing whitespace)", () => {
    const out = formatTable([
      ["a", "title"],
      ["bbb", "T"],
    ]);
    for (const line of out) expect(line).toBe(line.trimEnd());
  });

  test("right-aligns columns flagged via options.align", () => {
    const out = formatTable(
      [
        ["a", "0.42", "X"],
        ["aaa", "10.5", "Y"],
      ],
      { align: ["left", "right", "left"] },
    );
    // The second column right-pads (padStart) so the decimal lines up.
    expect(out[0]).toBe("a    0.42  X");
    expect(out[1]).toBe("aaa  10.5  Y");
  });

  test("ragged rows: missing cells treated as empty without crashing", () => {
    const out = formatTable([
      ["a", "b", "c"],
      ["aa", "bb"], // shorter — c-column missing
    ]);
    // Row 0 keeps its three columns; row 1's missing trailing cell
    // doesn't blow up. Column widths still come from the widest row.
    expect(out[0]).toBe("a   b   c");
    expect(out[1]!.startsWith("aa  bb")).toBe(true);
  });

  test("drops columns that are entirely empty across every row", () => {
    // The motivating case: `fbrain ask` includes an expansion column
    // whose cell is "" whenever LLM expansion didn't fire. Without
    // pruning, adjacent gaps double up and the row reads
    // "... vec=2    title" (4 spaces) instead of "vec=2  title".
    const out = formatTable([
      ["slug-a", "0.42", "design", "bm25=1", "vec=2", "", "Title A"],
      ["slug-bb", "0.30", "task", "bm25=3", "vec=4", "", "Title B"],
    ]);
    // The empty 6th column vanishes; the gap between vec=N and the
    // title is exactly one separator (two spaces).
    expect(out[0]).toContain("vec=2  Title A");
    expect(out[0]).not.toContain("vec=2   ");
    expect(out[1]).toContain("vec=4  Title B");
  });

  test("dynamic width handles the worst real-world slug length", () => {
    // The 54-char slug from the dogfood repro — the previous
    // `padEnd(28)` would have made every following column drift.
    const long = "agent-pr-events-2026-05-25-091310-pr-created-master";
    const out = formatTable([
      ["agent", long, "active", "Title One"],
      ["design", "short-slug", "draft", "Title Two"],
    ]);
    // Both rows share the column-2 (status) offset → status starts at
    // the same character index on both lines.
    const statusIdx0 = out[0]!.indexOf("active");
    const statusIdx1 = out[1]!.indexOf("draft");
    expect(statusIdx0).toBe(statusIdx1);
  });
});
