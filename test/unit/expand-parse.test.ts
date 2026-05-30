// Unit tests for src/retrieval/expand.ts parseExpansions.
//
// parseExpansions is explicitly exported "for tests" (see expand.ts) and
// strips the surface noise LLMs add to bullet-list answers — leading
// "1.", "-", quotes, blank lines — before the cleaned phrasings flow into
// BM25 + vector retrieval. A silent regression here would degrade ask
// quality without any error surfacing, since the call site already
// tolerates `expansions.length < count`. These tests pin the contract.

import { describe, expect, test } from "bun:test";

import { parseExpansions } from "../../src/retrieval/expand.ts";

describe("parseExpansions", () => {
  test("plain newline-separated lines pass through in order", () => {
    const raw = "first alt phrasing\nsecond alt phrasing\nthird alt phrasing";
    expect(parseExpansions(raw, 3)).toEqual([
      "first alt phrasing",
      "second alt phrasing",
      "third alt phrasing",
    ]);
  });

  test("strips leading '1.' and '2)' numbering, with or without leading whitespace", () => {
    const raw = "1. numbered with dot\n2) numbered with paren\n  3. indented numbered";
    expect(parseExpansions(raw, 3)).toEqual([
      "numbered with dot",
      "numbered with paren",
      "indented numbered",
    ]);
  });

  test("strips leading '-', '*', and '•' bullets", () => {
    const raw = "- dash bullet\n* star bullet\n• unicode bullet";
    expect(parseExpansions(raw, 3)).toEqual([
      "dash bullet",
      "star bullet",
      "unicode bullet",
    ]);
  });

  test("strips leading and trailing quote characters (\", ', `)", () => {
    const raw = '"double quoted"\n\'single quoted\'\n`backtick quoted`';
    expect(parseExpansions(raw, 3)).toEqual([
      "double quoted",
      "single quoted",
      "backtick quoted",
    ]);
  });

  test("blank and whitespace-only lines are skipped", () => {
    const raw = "first\n\n   \nsecond\n\t\nthird";
    expect(parseExpansions(raw, 5)).toEqual(["first", "second", "third"]);
  });

  test("output is capped at `count` even when more lines are present", () => {
    const raw = "alpha\nbeta\ngamma\ndelta\nepsilon";
    expect(parseExpansions(raw, 3)).toEqual(["alpha", "beta", "gamma"]);
  });

  test("CRLF line endings are handled the same as LF", () => {
    const raw = "first\r\nsecond\r\nthird";
    expect(parseExpansions(raw, 3)).toEqual(["first", "second", "third"]);
  });

  test("numbering + quotes combine: '1. \"foo\"' → 'foo'", () => {
    const raw = '1. "first wrapped"\n2) \'second wrapped\'\n- "bulleted and quoted"';
    expect(parseExpansions(raw, 3)).toEqual([
      "first wrapped",
      "second wrapped",
      "bulleted and quoted",
    ]);
  });

  test("empty input returns []", () => {
    expect(parseExpansions("", 3)).toEqual([]);
  });

  test("a line that is only quotes is treated as blank and skipped", () => {
    // The quote-strip + trim collapses '""' to '' — the loop must skip it
    // rather than emit an empty string into the expansions list. Otherwise
    // BM25 would tokenize "" and contribute a no-op ranker, but the ask.ts
    // caller would treat it as a legitimate phrasing.
    const raw = 'real phrasing\n""\nanother phrasing';
    expect(parseExpansions(raw, 5)).toEqual([
      "real phrasing",
      "another phrasing",
    ]);
  });

  test("trailing whitespace inside a line is trimmed", () => {
    const raw = "  padded phrasing   \n\tindented with tab\t";
    expect(parseExpansions(raw, 2)).toEqual([
      "padded phrasing",
      "indented with tab",
    ]);
  });

  test("internal quotes are preserved — only the outer leading/trailing runs are stripped", () => {
    // Input contains a literal " on each end and one pair around "inner".
    // Contract: strip the leading run and the trailing run; leave internal
    // quotes untouched so multi-word phrasings with embedded quoting reach
    // BM25 / vector retrieval intact.
    const raw = '"outer with "inner" survives"';
    expect(parseExpansions(raw, 1)).toEqual(['outer with "inner" survives']);
  });

  test("runs of identical outer quotes collapse to nothing (greedy match)", () => {
    // The regex strips a *run* of quote characters, not just one — '"""foo"""'
    // becomes 'foo'. Important because some models double-quote for emphasis.
    const raw = '"""triple quoted"""';
    expect(parseExpansions(raw, 1)).toEqual(["triple quoted"]);
  });
});
