// Deterministic body-snippet extraction for `fbrain search` / `fbrain ask`
// result rows. Pure retrieval-UX: given the (already-hydrated) record body
// and the user's query, return a short matching window so the answer is
// visible inline under each hit — no second `fbrain get`, and NO LLM (this
// is plain substring extraction, distinct from the deliberately-dropped LLM
// query expansion).
//
// Algorithm:
//   1. Normalize the body: drop a leading `# H1` line (so the snippet isn't
//      just the title echoed back), collapse all whitespace/newlines to
//      single spaces, trim.
//   2. Find the first case-insensitive occurrence of any query TERM (a term
//      is a whitespace-split, non-empty token of the query). The earliest
//      match across all terms wins.
//   3. Emit a ~SNIPPET_WINDOW-char window centered on that match, prefixing
//      `… ` when it doesn't start at the body head and suffixing ` …` when
//      it doesn't reach the body tail.
//   4. No term matches (e.g. a pure-vector hit whose body shares no literal
//      token with the query): fall back to the first ~SNIPPET_WINDOW chars,
//      suffixed with ` …` when truncated.
//   5. An empty/whitespace-only body yields an empty string.

// Target snippet width in characters (the matched term sits roughly centered
// within this window). Kept modest so a result row + its snippet line stay
// scannable in a terminal.
export const SNIPPET_WINDOW = 120;

// Collapse all runs of whitespace (incl. newlines/tabs) to a single space and
// strip a leading markdown H1 line so the snippet carries body prose, not the
// title repeated. Only a leading `# ...` (ATX H1) is stripped — deeper headings
// (`##`, `###`) and mid-body `#` lines are left alone.
function normalizeBody(body: string): string {
  // Strip a leading H1 line: optional leading blank lines, then `# heading`.
  // `#(?!#)` excludes `##`/`###` (deeper headings are kept); the `[ \t]+`
  // requires the ATX space so a bare `#foo` isn't mistaken for a heading.
  const text = body.replace(/^\s*#(?!#)[ \t]+[^\n]*\n?/, "");
  return text.replace(/\s+/g, " ").trim();
}

// Earliest case-insensitive index at which any query term occurs in `hay`
// (lowercased), or -1. Returns the matched term length too so the window can
// center on the whole match. Terms are whitespace-split, non-empty tokens.
function firstTermMatch(
  hayLower: string,
  query: string,
): { index: number; length: number } | null {
  const terms = query
    .split(/\s+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  let best: { index: number; length: number } | null = null;
  for (const term of terms) {
    const idx = hayLower.indexOf(term);
    if (idx === -1) continue;
    if (best === null || idx < best.index) {
      best = { index: idx, length: term.length };
    }
  }
  return best;
}

// Build a matching snippet for a single hit. `body` is the fully-hydrated
// record body (already in hand client-side — no extra fetch). `query` is the
// user's raw search/ask query string.
export function buildSnippet(
  body: string,
  query: string,
  window: number = SNIPPET_WINDOW,
): string {
  const text = normalizeBody(body);
  if (text.length === 0) return "";

  const match = firstTermMatch(text.toLowerCase(), query);

  if (match === null) {
    // Pure-vector / no-literal-overlap hit: show the head of the body.
    if (text.length <= window) return text;
    return text.slice(0, window).trimEnd() + " …";
  }

  // Center the window on the matched term.
  const matchCenter = match.index + Math.floor(match.length / 2);
  let start = matchCenter - Math.floor(window / 2);
  if (start < 0) start = 0;
  let end = start + window;
  if (end > text.length) {
    end = text.length;
    start = Math.max(0, end - window);
  }

  let snippet = text.slice(start, end).trim();
  if (start > 0) snippet = "… " + snippet;
  if (end < text.length) snippet = snippet + " …";
  return snippet;
}
