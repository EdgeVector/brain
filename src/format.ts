// Output formatting helpers shared by `list`, `search`, and `ask`.
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
// widest cell in each column. The right-most column is never padded —
// trailing whitespace on a terminal row is just visual noise.
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
  const lastKept = keptCols[keptCols.length - 1]!;
  return rows.map((row) => {
    const parts: string[] = [];
    for (const c of keptCols) {
      const cell = row[c] ?? "";
      if (c === lastKept) {
        parts.push(cell);
      } else {
        const align = options.align?.[c] ?? "left";
        parts.push(align === "right" ? cell.padStart(widths[c]!) : cell.padEnd(widths[c]!));
      }
    }
    return parts.join(gap);
  });
}
