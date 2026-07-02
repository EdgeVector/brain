// `fbrain doctor --usage` — team-adoption telemetry (G13).
//
// Iterates every record across the eight registered schemas via
// /api/query, derives a per-record userHash from the author public key,
// and counts records created in the last N days (default 7) — grouped
// by userHash and broken down by record type. Prints only the 8-char
// prefix of each userHash so the report is shareable without leaking
// identifiers.
//
// Also persists today's per-user counts to ~/.fbrain/usage.jsonl as
// one line per UTC date so we can plot adoption trends over time.
// Re-running on the same UTC day replaces that day's line in-place.
//
// Per G0 readiness-gate definition-of-shipped: "2+ daily users with
// userHash-distinguishable writes for 7 consecutive days" — this
// command is what makes that condition measurable.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  pubkeyToUserHash,
  type NodeClient,
  type QueryRow,
  type Verbose,
} from "../client.ts";
import { fbrainHomeBase, type Config } from "../config.ts";
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
  // Suppress disk I/O — useful for unit tests that don't want a
  // usage.jsonl file written into their tempdir.
  noPersist?: boolean;
};

export type UsagePerUser = {
  userHashPrefix: string;
  total: number;
  today: number;
  byType: Record<RecordType, number>;
};

export type UsageReport = {
  windowDays: number;
  totalWrites: number;
  users: UsagePerUser[];
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

  type Counts = { total: number; today: number; byType: Map<RecordType, number> };
  const perUser = new Map<string, Counts>();

  for (const entry of UNIQUE_SCHEMAS) {
    // Skip internal (non-RecordType) schemas like TagIndex — they carry no
    // user-authored records and aren't a usage-reportable type (`entry.types`
    // is empty for them).
    const type = entry.types[0];
    if (type === undefined) continue;
    const schemaHash = cfg.schemaHashes[entry.key];
    if (!schemaHash) {
      verbose?.(`usage: skipping ${entry.key} — no schemaHash in config`);
      continue;
    }
    const fields = fieldsFor(type);
    let rows: QueryRow[];
    try {
      const res = await node.queryAll({ schemaHash, fields });
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

      const pubkey = row.author_pub_key;
      if (typeof pubkey !== "string" || pubkey.length === 0) {
        verbose?.(`usage: skipping row with no author_pub_key (slug=${row.key.hash})`);
        continue;
      }
      const uh = pubkeyToUserHash(pubkey);

      let c = perUser.get(uh);
      if (!c) {
        c = { total: 0, today: 0, byType: new Map() };
        perUser.set(uh, c);
      }
      c.total++;
      if (ts >= todayStart) c.today++;
      c.byType.set(type, (c.byType.get(type) ?? 0) + 1);
    }
  }

  const users: UsagePerUser[] = Array.from(perUser.entries())
    .map(([uh, c]) => ({
      userHashPrefix: uh.slice(0, 8),
      total: c.total,
      today: c.today,
      byType: mapToRecord(c.byType),
    }))
    .sort((a, b) => b.total - a.total);

  const totalWrites = users.reduce((s, u) => s + u.total, 0);
  const report: UsageReport = { windowDays, totalWrites, users };

  print(`fbrain usage (last ${windowDays} days, by userHash):`);
  if (users.length === 0) {
    print("  (no records created in window)");
  } else {
    for (const u of users) {
      const types = Object.entries(u.byType)
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `${t}(${n})`)
        .join(" ");
      print(
        `  ${u.userHashPrefix}  ${u.total} writes  (${u.today} today)  types: ${types}`,
      );
    }
  }
  print(
    `total: ${totalWrites} write${totalWrites === 1 ? "" : "s"} across ${users.length} user${users.length === 1 ? "" : "s"}`,
  );

  if (!opts.noPersist) {
    persistDailySummary({
      now,
      users,
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
  by_user: Record<string, number>;
  total: number;
};

export function defaultUsagePath(): string {
  return join(fbrainHomeBase(), ".fbrain", "usage.jsonl");
}

function persistDailySummary(args: {
  now: Date;
  users: UsagePerUser[];
  path: string;
  verbose: Verbose | undefined;
}): void {
  const date = isoDate(args.now);
  const by_user: Record<string, number> = {};
  let total = 0;
  for (const u of args.users) {
    if (u.today === 0) continue;
    by_user[u.userHashPrefix] = u.today;
    total += u.today;
  }
  const line: DailySummaryLine = { date, by_user, total };

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
