// Unit tests for the deterministic body-snippet extractor used by
// `fbrain search` / `fbrain ask` result rows.

import { describe, expect, test } from "bun:test";

import { buildSnippet, SNIPPET_WINDOW } from "../../src/retrieval/snippet.ts";

describe("buildSnippet", () => {
  test("centers a window on the first matching query term, with ellipses", () => {
    const body =
      "Lots of preamble text that comes well before the answer. " +
      "Decision: we picked a 5-minute TTL for the cache. " +
      "And then a long tail of further unrelated discussion afterwards.";
    const snippet = buildSnippet(body, "TTL");
    // The matched term is present inline (the whole point — answer visible).
    expect(snippet).toContain("TTL");
    expect(snippet).toContain("5-minute");
    // Window-sized: roughly SNIPPET_WINDOW chars plus the ellipsis decoration.
    expect(snippet.length).toBeLessThanOrEqual(SNIPPET_WINDOW + 8);
    // Mid-body match → both ellipses.
    expect(snippet.startsWith("… ")).toBe(true);
    expect(snippet.endsWith(" …")).toBe(true);
  });

  test("matches the earliest of multiple query terms, case-insensitively", () => {
    const body = "alpha bravo charlie delta echo foxtrot golf";
    // "GOLF" appears last; "charlie" earlier — earliest match wins, and the
    // match is case-insensitive.
    const snippet = buildSnippet(body, "ZULU CHARLIE GOLF");
    expect(snippet.toLowerCase()).toContain("charlie");
  });

  test("falls back to the body head when no query term matches (pure-vector hit)", () => {
    const body =
      "This body shares no literal token with the query at all, " +
      "yet a vector hit can still surface it on pure semantic similarity.";
    const snippet = buildSnippet(body, "qwxz9931 blarghonk");
    // Head of the body, no leading ellipsis.
    expect(snippet.startsWith("This body shares")).toBe(true);
    expect(snippet.startsWith("… ")).toBe(false);
  });

  test("returns the whole body verbatim when it is shorter than the window", () => {
    expect(buildSnippet("blueberry octopus", "blueberry")).toBe("blueberry octopus");
  });

  test("collapses whitespace and newlines to single spaces", () => {
    const body = "first    line\n\n\tsecond   line\nthird";
    const snippet = buildSnippet(body, "second");
    expect(snippet).not.toContain("\n");
    expect(snippet).not.toContain("\t");
    expect(snippet).not.toContain("  ");
    expect(snippet).toContain("second line");
  });

  test("strips a leading H1 so the snippet isn't just the title repeated", () => {
    const body = "# Caching layer decision\n\nWe picked a 5-minute TTL.";
    const snippet = buildSnippet(body, "TTL");
    expect(snippet).not.toContain("Caching layer decision");
    expect(snippet).toContain("5-minute TTL");
  });

  test("keeps a leading H2/H3 (only a single-# H1 is stripped)", () => {
    const body = "## Subheading kept\n\nbody about widgets";
    const snippet = buildSnippet(body, "widgets");
    expect(snippet).toContain("Subheading kept");
  });

  test("empty / whitespace-only body yields an empty string", () => {
    expect(buildSnippet("", "anything")).toBe("");
    expect(buildSnippet("   \n\t  ", "anything")).toBe("");
    // A body that is ONLY an H1 collapses to empty after the strip.
    expect(buildSnippet("# Just a title\n", "title")).toBe("");
  });
});
