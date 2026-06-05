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

  test("a line that is only a bullet character is treated as blank and skipped", () => {
    // Mirror of the quote-only skip above. The bullet-strip regex used to be
    // `^\s*[-*•]\s+` — the trailing `\s+` REQUIRED whitespace after the
    // bullet, so a line consisting of just `-` (or `*`, or `•`) didn't match
    // the bullet alternative, didn't match the number or quote alternatives
    // either, and survived `.trim()` as the single-character "expansion"
    // `"-"`. That bare-bullet line was then pushed into the expansions list,
    // and ask.ts's per-query loop dutifully ran a vector search for `"-"` —
    // a wasteful HTTP round-trip whose garbage hits then polluted the RRF
    // fused ranking.
    //
    // Realistic trigger: the LLM hits max_tokens mid-bullet and the final
    // line is a bare `-` (the content was truncated). Or the LLM emits an
    // empty list item as filler when it can't think of a 3rd phrasing:
    //   - first phrasing
    //   - second phrasing
    //   -
    // The third "phrasing" used to leak in as `-`. After the fix, the
    // bullet-strip regex also matches when the bullet is followed by
    // end-of-string, so the line strips to empty and the existing
    // empty-after-strip skip handles it — same shape of fix as PR #119's
    // quote-only-line skip.
    expect(parseExpansions("real phrasing\n-\nanother phrasing", 5)).toEqual([
      "real phrasing",
      "another phrasing",
    ]);
    expect(parseExpansions("real phrasing\n*\nanother phrasing", 5)).toEqual([
      "real phrasing",
      "another phrasing",
    ]);
    expect(parseExpansions("real phrasing\n•\nanother phrasing", 5)).toEqual([
      "real phrasing",
      "another phrasing",
    ]);
    // Whitespace + bare bullet (no trailing whitespace) — same shape, the
    // leading `\s*` still permits the indent.
    expect(parseExpansions("real phrasing\n   -\nanother phrasing", 5)).toEqual([
      "real phrasing",
      "another phrasing",
    ]);
    // Realistic max_tokens-truncation case: the 4th list entry collapses to
    // a bare bullet. Pre-fix, that bare `-` ate the 4th expansion slot with
    // garbage; post-fix, the slot stays empty and the caller's loop just
    // sees 3 real phrasings.
    expect(
      parseExpansions("- first\n- second\n- third\n-", 4),
    ).toEqual(["first", "second", "third"]);
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

  test("leading whitespace before a quoted phrasing is stripped along with the quotes", () => {
    // Regression: bullet-strip and number-strip allow a `\s*` prefix
    // (`^\s*[-*•]\s+`, `^\s*\d+[.)]\s+`), but the quote-strip regex used to be
    // anchored as `^["'\`]+` — no leading-whitespace allowance. So an indented
    // quoted line like `  "foo"` would survive bullet/number strip unchanged,
    // then the `^["'\`]+` alternation couldn't match because position 0 was a
    // space. Only the trailing quote got stripped. After the final .trim()
    // the result was `"foo` — a corrupted phrasing with a leftover leading
    // quote, which then flows into vector search (the raw query string is
    // sent to embeddings) and silently degrades recall.
    //
    // Realistic trigger: the system prompt says "no preamble, no quotes" but
    // models ignore it and produce things like:
    //   Here are 3 alternative phrasings:
    //     "first phrasing"
    //     "second phrasing"
    //     "third phrasing"
    // The first line drops out as preamble, but each indented quoted line
    // used to leak a leading `"`.
    const raw = '  "first phrasing"\n\t"second phrasing"\n   `backtick phrasing`';
    expect(parseExpansions(raw, 3)).toEqual([
      "first phrasing",
      "second phrasing",
      "backtick phrasing",
    ]);
  });

  test("a line that is only leading whitespace + quotes collapses and is skipped", () => {
    // Companion to the regression above: `   "  ` (whitespace, lone quote,
    // whitespace) used to survive as the single-character phrasing `"` —
    // the leading-quote alternation couldn't match (position 0 was a space),
    // so only the trailing whitespace got .trim()-ed off and a bare `"` was
    // pushed as an "expansion". With the fix the leading run of whitespace +
    // quotes collapses, the result is empty, and the line is skipped.
    const raw = 'real phrasing\n   "  \nanother phrasing';
    expect(parseExpansions(raw, 5)).toEqual([
      "real phrasing",
      "another phrasing",
    ]);
  });

  test("trailing whitespace after a closing quote is stripped along with the quote", () => {
    // Mirror of the leading-whitespace fix. The quote-strip regex was
    // `^\s*["'\`]+|["'\`]+$` — the leading half allows a `\s*` prefix, but
    // the trailing half had NO trailing-whitespace allowance. So a line like
    // `"foo"   ` (closing quote followed by spaces / tab) leaked a stray
    // trailing `"`: the leading half stripped the opening `"`, the trailing
    // half couldn't match because `$` was after the spaces, and the final
    // `.trim()` only removed the spaces — leaving `foo"`. That corrupted
    // phrasing then flows into vector search (raw query string sent to
    // embeddings) and silently degrades ask quality, same shape as the
    // pre-fix leading-whitespace regression.
    //
    // Realistic trigger: an LLM emits the bullet list with trailing spaces
    // on each line — common in mass-produced output:
    //   "first phrasing"   ␊
    //   "second phrasing"  ␊
    //   "third phrasing"\t␊
    const raw = '"first phrasing"   \n"second phrasing"  \n"third phrasing"\t';
    expect(parseExpansions(raw, 3)).toEqual([
      "first phrasing",
      "second phrasing",
      "third phrasing",
    ]);
  });

  test("leading + trailing whitespace both stripped around quoted phrasings", () => {
    // The combined symmetric case — leading whitespace + quote + content +
    // quote + trailing whitespace. Both halves of the quote-strip regex must
    // permit surrounding whitespace.
    const raw = '   "  padded phrasing  "   ';
    // Outer quotes + surrounding whitespace strip; the inner whitespace
    // inside the quoted content is preserved up to the final `.trim()`.
    expect(parseExpansions(raw, 1)).toEqual(["padded phrasing"]);
  });
});
