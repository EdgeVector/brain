// `brain doctor --usage` — adoption telemetry (G13).
//
// Iterates every record across the registered schemas via /api/query and
// counts records created in the last N days (default 7), broken down by
// record type.
//
// Also persists today's count to ~/.brain/usage.jsonl as one line per UTC
// date so we can plot adoption trends over time. Re-running on the same UTC
// day replaces that day's line in-place.
//
// A LastDB record carries one metadata block and names no writer (record
// model decision D7), so the report has no per-user split.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { type NodeClient, type QueryRow, type Verbose } from "../client.ts";
import { brainDataDir, type Config } from "../config.ts";
import { resolvePrintSink } from "../format.ts";
import { fieldsFor, stringField } from "../record.ts";
import {
  UNIQUE_SCHEMAS,
  type RecordType,
} from "../schemas.ts";

export type UsageOptions = {
  windowDays?: number;
  now?: Date;
  usagePath?: string;
  print?: (line: string) => void;
  verbose?: Verbose;
  // Suppress disk I/O so a caller can read the report without writing a
  // usage.jsonl file.
  noPersist?: boolean;
};

export type UsageReport = {
  windowDays: number;
  /** Records created in the window. */
  totalWrites: number;
  /** Records created today (UTC). */
  todayWrites: number;
  byType: Record<RecordType, number>;
};

export async function runUsageReport(
  node: NodeClient,
  cfg: Config,
  opts: UsageOptions = {},
): Promise<UsageReport> {
  const print = resolvePrintSink(opts);
  const verbose = opts.verbose;
  const windowDays = opts.windowDays ?? 7;
  const now = opts.now ?? new Date();
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  const todayStart = utcMidnight(now).getTime();

  const byType = new Map<RecordType, number>();
  let total = 0;
  let today = 0;

  for (const entry of UNIQUE_SCHEMAS) {
    if (entry.types.length === 0) continue;
    const schemaHash = cfg.schemaHashes[entry.key];
    if (!schemaHash) {
      verbose?.(`usage: skipping ${entry.key} — no schemaHash in config`);
      continue;
    }
    const type = entry.types[0]!;
    const fields = fieldsFor(type);
    let rows: QueryRow[];
    try {
      // Admin diagnostics only — not a product hot path.
      const res = await node.queryAll({ schemaHash, fields, allowFullScan: true });
      rows = res.results;
    } catch (err) {
      verbose?.(
        `usage: queryAll(${entry.key}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
    verbose?.(`usage: ${entry.key} → ${rows.length} rows`);

    for (const row of rows) {
      const createdAt = stringField(row.fields, "created_at");
      if (!createdAt) continue;
      const ts = Date.parse(createdAt);
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      total++;
      if (ts >= todayStart) today++;
      byType.set(type, (byType.get(type) ?? 0) + 1);
    }
  }

  const report: UsageReport = {
    windowDays,
    totalWrites: total,
    todayWrites: today,
    byType: mapToRecord(byType),
  };

  print(`brain usage (last ${windowDays} days):`);
  if (total === 0) {
    print("  (no records created in window)");
  } else {
    const types = Object.entries(report.byType)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t}(${n})`)
      .join(" ");
    print(`  ${total} writes  (${today} today)  types: ${types}`);
  }
  print(`total: ${total} write${total === 1 ? "" : "s"}`);

  if (!opts.noPersist) {
    persistDailySummary({
      now,
      today,
      path: opts.usagePath ?? defaultUsagePath(),
      verbose,
    });
  }

  return report;
}

// Type for the on-disk daily summary line. Each line records `today`
// counts (NOT the 7-day window) so a stream of daily lines can be
// plotted as a time series.
export type DailySummaryLine = {
  date: string;
  total: number;
};

export function defaultUsagePath(): string {
  return join(brainDataDir(), "usage.jsonl");
}

function persistDailySummary(args: {
  now: Date;
  today: number;
  path: string;
  verbose: Verbose | undefined;
}): void {
  const date = isoDate(args.now);
  const line: DailySummaryLine = { date, total: args.today };

  mkdirSync(dirname(args.path), { recursive: true });
  const existing = existsSync(args.path) ? readFileSync(args.path, "utf8") : "";
  const lines = existing.length > 0 ? existing.split("\n").filter((l) => l.length > 0) : [];

  const next: string[] = [];
  let replaced = false;
  for (const l of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(l);
    } catch {
      // Preserve unrecognised lines verbatim so we don't drop a teammate's
      // hand-edits or a future-schema entry.
      next.push(l);
      continue;
    }
    if (parsed && typeof parsed === "object" && (parsed as DailySummaryLine).date === date) {
      next.push(JSON.stringify(line));
      replaced = true;
    } else {
      next.push(l);
    }
  }
  if (!replaced) next.push(JSON.stringify(line));

  writeFileSync(args.path, next.join("\n") + "\n", "utf8");
  args.verbose?.(`usage: ${replaced ? "updated" : "appended"} ${date} summary at ${args.path}`);
}

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function mapToRecord(m: Map<RecordType, number>): Record<RecordType, number> {
  const out = {} as Record<RecordType, number>;
  for (const [k, v] of m) out[k] = v;
  return out;
}
