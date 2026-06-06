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
    print: opts.print ?? ((line: string) => console.log(line)),
    printErr: opts.printErr ?? ((line: string) => console.error(line)),
  };
}
