// Output helpers shared by `list`, `search`, `ask`, and `raw`.
//
// `padEnd(28)` made columns drift the moment a slug like
// `agent-pr-events-2026-05-25-091310-pr-created-master` (54 chars)
// landed in the index — the status / score column then sat at a
// different offset on every row and the table was unreadable. The
// helper here sizes each column from the actual rows being printed.

export type Align = "left" | "right";

export type FormatTableOptions = {
  // Per-column alignment. Defaults to "left" for every column. Length
  // must match the cells-per-row width; any rows of a different width
  // are accepted but treated as if the missing columns were "".
  align?: readonly Align[];
  // Inter-column separator. Two spaces by default.
  gap?: string;
};

// Format a 2D grid into per-row strings with columns sized to the
// widest cell in each column. Right-aligned cells use padStart, which
// only adds leading whitespace inside the column slot, so the right
// edges still line up without trailing noise. Left-aligned cells use
// padEnd; any trailing whitespace that adds to the last column (or to
// rows whose last cell is empty / missing) is stripped from the joined
// line so no row carries a tail.
//
// Empty input returns an empty array; a row with fewer cells than the
// widest row is padded with "" on the right.
export function formatTable(
  rows: readonly (readonly string[])[],
  options: FormatTableOptions = {},
): string[] {
  if (rows.length === 0) return [];
  const gap = options.gap ?? "  ";
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  if (cols === 0) return rows.map(() => "");
  const widths = new Array<number>(cols).fill(0);
  for (const row of rows) {
    for (let c = 0; c < cols; c++) {
      const cell = row[c] ?? "";
      if (cell.length > widths[c]!) widths[c] = cell.length;
    }
  }
  // Drop columns that are entirely empty across every row. Without
  // this, an empty middle column still consumes a `gap` on each side
  // and the row ends up with a double-gap hole — e.g. ask's expansion
  // column is empty whenever LLM expansion didn't fire, and we don't
  // want "vec=2    title" with four spaces in place of two.
  const keptCols: number[] = [];
  for (let c = 0; c < cols; c++) if (widths[c]! > 0) keptCols.push(c);
  if (keptCols.length === 0) return rows.map(() => "");
  return rows.map((row) => {
    const parts: string[] = [];
    for (const c of keptCols) {
      const cell = row[c] ?? "";
      const align = options.align?.[c] ?? "left";
      // padStart adds LEADING whitespace inside the column slot, so
      // right-aligned columns never contribute trailing whitespace.
      // padEnd does, but trimEnd below collapses that uniformly — for
      // the last column's own padding and for ragged / sparse rows
      // whose last cell is "" or missing.
      parts.push(align === "right" ? cell.padStart(widths[c]!) : cell.padEnd(widths[c]!));
    }
    return parts.join(gap).trimEnd();
  });
}

// Uppercase the first character of `s`. Used to render record-type
// display names (e.g. `task` → `Task`) in `search` and `ask` output.
export function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Resolve the (print, printErr) sink pair from a command's options
// object, defaulting to console.log / console.error. The four commands
// that route advisory `note:` lines to stderr (ask, search, list, raw)
// all need the same defaults so `<cmd> q 2>/dev/null` stays parseable;
// keep it in one place so the defaults can't drift across commands.
export type PrintSinks = {
  print: (line: string) => void;
  printErr: (line: string) => void;
};

export function resolvePrintSinks(opts: {
  print?: (line: string) => void;
  printErr?: (line: string) => void;
}): PrintSinks {
  return {
    print: resolvePrintSink(opts),
    printErr: opts.printErr ?? ((line: string) => console.error(line)),
  };
}

// One-line, TTY-only column legend for the `search` / `ask` result tables.
//
// The leading number in both tables is an unlabeled relevance score whose
// SCALE differs by verb — `search` renders a max-normalized cosine (top hit
// is always `1.000`), `ask` renders a raw fused-RRF score (top hit ≈ 0.03).
// To a first-time human the bare `0.0328` reads like noise; this legend names
// the columns and flags that the two scores are NOT comparable. The MCP/agent
// surface already documents the same distinction (src/mcp/server.ts), so this
// closes the human-vs-agent gap on the CLI.
//
// Discipline (matches the weak-match advisory, which goes to stderr): the
// legend is additive HUMAN context, never part of the parsed rows. It is
// emitted ONLY when:
//   - stdout is an interactive TTY (`isTty()` — piped/redirected output and
//     agent consumers see byte-identical rows), and
//   - the caller is NOT in `--json` mode, and
//   - there is at least one result row (no legend above a no-match hint).
// The caller is responsible for those gates; this helper just formats + emits.
//
// `dimmed` wraps the text in ANSI dim (2m) so it reads as a subordinate
// caption under a real TTY. We never reach here off-TTY, so the escape codes
// can't leak into a pipe.
export function printColumnLegend(print: (line: string) => void, text: string): void {
  print(dimmed(`  columns: ${text}`));
}

// ANSI dim wrapper. Only used for the column legend, which is gated on a real
// TTY at the call site, so the escapes never reach a pipe or `--json` stream.
function dimmed(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}

// Resolve whether stdout should be treated as an interactive TTY for human
// affordances (the column legend). Mirrors the injectable-TTY pattern used by
// `init-consent` so tests can force the flag without a real terminal; defaults
// to `process.stdout.isTTY` (NOT stdin — the legend rides the stdout stream,
// so the redirect that must suppress it is `> file` / `| cmd`, which clears
// `stdout.isTTY`).
export function resolveStdoutIsTty(opts: { isTty?: () => boolean }): boolean {
  return (opts.isTty ?? (() => Boolean(process.stdout.isTTY)))();
}

// Resolve the `print` sink alone, for commands that only emit to stdout
// (get, status, link, delete, reindex, usage, migrate, doctor, init,
// init-consent). Same default as resolvePrintSinks().print so the two
// can't drift.
export function resolvePrintSink(opts: {
  print?: (line: string) => void;
}): (line: string) => void {
  return opts.print ?? ((line: string) => console.log(line));
}
