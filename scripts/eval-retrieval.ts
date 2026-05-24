#!/usr/bin/env bun
// Retrieval eval harness for fbrain — Phase 7 G3b.
//
// Reads eval/retrieval/pairs.json (20+ hand-labeled (query, expected_slug,
// expected_type) triples), for each pair issues `searchCmd` programmatically
// against the live node, finds the rank of the expected slug in the top-K
// (default K=10), and reports precision@1 / @3 / @5 plus mean reciprocal rank.
//
// CI invokes this non-blocking — see .github/workflows/ci.yml. The script
// exits 0 even when the node is unreachable (CI has no node) and even when
// the metrics are bad. Once we have a 7-day baseline we'll start gating on a
// floor — for now it's instrumentation, not a gate. (TODO: gate on baseline)
//
// CLI:
//   bun scripts/eval-retrieval.ts                  # seed missing, run, soft-delete seeded
//   bun scripts/eval-retrieval.ts --no-seed        # run against live corpus (no put/delete)
//   bun scripts/eval-retrieval.ts --keep           # skip teardown (debugging)
//   bun scripts/eval-retrieval.ts --limit 5        # top-K considered (default 10)
//   bun scripts/eval-retrieval.ts --format json    # emit JSON only
//   bun scripts/eval-retrieval.ts --out FILE       # write JSON report to FILE
//
// The runner is robust to a missing config — it prints a skip line and
// returns 0 so CI keeps moving. Same for an unreachable node.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { searchCmd } from "../src/commands/search.ts";
import { askCmd } from "../src/commands/ask.ts";
import { putCmd } from "../src/commands/put.ts";
import { deleteRecord } from "../src/commands/delete.ts";
import { findBySlug, schemaHashFor } from "../src/record.ts";
import { newNodeClient, FbrainError } from "../src/client.ts";
import { tryReadConfig, type Config } from "../src/config.ts";
import { isRecordType, type RecordType } from "../src/schemas.ts";

type SeedBlock = {
  title: string;
  body: string;
  tags?: string[];
};

type Pair = {
  query: string;
  expected_slug: string;
  expected_type: string;
  seed?: SeedBlock;
  notes?: string;
};

type PairsFile = {
  slug_prefix: string;
  pairs: Pair[];
};

type Mode = "search" | "ask-no-llm" | "ask";

type PairResult = {
  query: string;
  expected_slug: string;
  expected_type: RecordType;
  rank: number | null; // 1-based; null = expected not in top-K
  top_k_slugs: string[];
  seeded: boolean;
  error: string | null;
};

type ModeReport = {
  mode: Mode;
  metrics: {
    "p@1": number;
    "p@3": number;
    "p@5": number;
    mrr: number;
  };
  results: PairResult[];
};

type Report = {
  // Bump on every shape change. v2 adds `modes` (multi-mode comparison)
  // while keeping the legacy single-mode top-level fields populated from
  // the first mode (typically `search`) so older readers don't break.
  schema_version: 2;
  generated_at: string;
  node_url: string;
  total_pairs: number;
  evaluated: number;
  skipped: number;
  errors: number;
  k: number;
  // Legacy / convenience: same as modes[0].metrics + .results.
  metrics: ModeReport["metrics"];
  results: PairResult[];
  modes: ModeReport[];
};

type Args = {
  noSeed: boolean;
  keep: boolean;
  limit: number;
  format: "table+json" | "json";
  out: string | null;
  modes: Mode[];
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    noSeed: false,
    keep: false,
    limit: 10,
    format: "table+json",
    out: null,
    // Default: compare vector-only `search` against `ask --no-llm`.
    // `ask` (with LLM) is opt-in via --modes to avoid spending tokens on
    // every CI run; once a key is wired into CI we'll default-include it.
    modes: ["search", "ask-no-llm"],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--no-seed") args.noSeed = true;
    else if (a === "--keep") args.keep = true;
    else if (a === "--limit") {
      const v = argv[++i];
      if (!v) throw new Error("--limit requires a value");
      const n = Number(v);
      if (!Number.isFinite(n) || n < 1) throw new Error(`--limit must be >= 1, got ${v}`);
      args.limit = Math.floor(n);
    } else if (a === "--format") {
      const v = argv[++i];
      if (v !== "json" && v !== "table+json") {
        throw new Error(`--format must be one of: json | table+json (got ${v})`);
      }
      args.format = v;
    } else if (a === "--out") {
      const v = argv[++i];
      if (!v) throw new Error("--out requires a path");
      args.out = v;
    } else if (a === "--modes") {
      const v = argv[++i];
      if (!v) throw new Error("--modes requires a comma-separated list");
      const parsed: Mode[] = [];
      for (const m of v.split(",").map((s) => s.trim()).filter((s) => s.length > 0)) {
        if (m !== "search" && m !== "ask-no-llm" && m !== "ask") {
          throw new Error(`--modes value "${m}" not one of: search | ask-no-llm | ask`);
        }
        if (!parsed.includes(m)) parsed.push(m);
      }
      if (parsed.length === 0) throw new Error("--modes must list at least one mode");
      args.modes = parsed;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown arg: ${a}`);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(
    "bun scripts/eval-retrieval.ts [--no-seed] [--keep] [--limit N] [--modes M[,M...]] [--format json|table+json] [--out FILE]\n\n" +
      "Run the retrieval eval harness against the live fbrain node. Seeds missing\n" +
      "records by default; cleans up after unless --keep is passed. Exits 0 even on\n" +
      "low scores — gating is a future TODO once we have a baseline.\n\n" +
      "Modes (default: search,ask-no-llm):\n" +
      "  search       vector-only `fbrain search`\n" +
      "  ask-no-llm   `fbrain ask --no-llm` (BM25 + vector + RRF)\n" +
      "  ask          `fbrain ask` (adds LLM query expansion — costs Anthropic tokens)\n",
  );
}

function loadPairs(): PairsFile {
  // Resolve relative to this file so the script works regardless of cwd.
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "..", "eval", "retrieval", "pairs.json");
  const raw = readFileSync(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("pairs" in parsed) ||
    !Array.isArray((parsed as PairsFile).pairs)
  ) {
    throw new Error(`pairs.json at ${path} is malformed (missing "pairs" array)`);
  }
  const file = parsed as PairsFile;
  if (typeof file.slug_prefix !== "string" || file.slug_prefix.length === 0) {
    throw new Error(`pairs.json missing "slug_prefix"`);
  }
  if (file.pairs.length < 20) {
    throw new Error(
      `pairs.json has only ${file.pairs.length} pairs; eval harness requires >= 20.`,
    );
  }
  // Validate every pair has the fields we depend on so a bad edit fails loud.
  for (const [i, p] of file.pairs.entries()) {
    if (typeof p.query !== "string" || p.query.length === 0) {
      throw new Error(`pair[${i}].query must be a non-empty string`);
    }
    if (typeof p.expected_slug !== "string" || !p.expected_slug.startsWith(file.slug_prefix)) {
      throw new Error(
        `pair[${i}].expected_slug must start with "${file.slug_prefix}" (got ${p.expected_slug})`,
      );
    }
    if (typeof p.expected_type !== "string" || !isRecordType(p.expected_type)) {
      throw new Error(`pair[${i}].expected_type is not a valid RecordType: ${p.expected_type}`);
    }
  }
  return file;
}

function readCfgOrSkip(): Config | null {
  try {
    const cfg = tryReadConfig();
    if (cfg === null) {
      console.log("eval-retrieval: no fbrain config (run `fbrain init`); skipping.");
      return null;
    }
    return cfg;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`eval-retrieval: config unreadable (${msg}); skipping.`);
    return null;
  }
}

async function nodeReachable(cfg: Config): Promise<boolean> {
  try {
    const res = await fetch(`${cfg.nodeUrl}/api/system/auto-identity`, {
      signal: AbortSignal.timeout(3000),
    });
    // 200 (provisioned) or 503 (not provisioned) both indicate the node is up.
    return res.status === 200 || res.status === 503;
  } catch {
    return false;
  }
}

function frontmatterFor(pair: Pair): string {
  const seed = pair.seed;
  if (!seed) throw new Error(`pair "${pair.expected_slug}" missing seed block`);
  const tags = Array.isArray(seed.tags) ? seed.tags : [];
  const tagsInline = `[${tags.map((t) => JSON.stringify(t)).join(", ")}]`;
  return [
    "---",
    `type: ${pair.expected_type}`,
    `title: ${JSON.stringify(seed.title)}`,
    `tags: ${tagsInline}`,
    "---",
    seed.body,
  ].join("\n");
}

async function seedIfMissing(
  cfg: Config,
  pair: Pair,
): Promise<{ seeded: boolean; error: string | null }> {
  const type = pair.expected_type as RecordType;
  const node = newNodeClient({ baseUrl: cfg.nodeUrl, userHash: cfg.userHash });
  try {
    const hash = schemaHashFor(type, cfg);
    const existing = await findBySlug(node, type, hash, pair.expected_slug);
    if (existing) return { seeded: false, error: null };
    if (!pair.seed) {
      return {
        seeded: false,
        error: `seed block missing for "${pair.expected_slug}" and record does not exist; use --no-seed or add a seed block.`,
      };
    }
    await putCmd({
      cfg,
      slug: pair.expected_slug,
      input: frontmatterFor(pair),
      print: () => {},
    });
    return { seeded: true, error: null };
  } catch (err) {
    return { seeded: false, error: errMsg(err) };
  }
}

async function teardown(cfg: Config, slug: string, type: RecordType): Promise<void> {
  try {
    await deleteRecord({ cfg, slug, type, print: () => {} });
  } catch (err) {
    // Soft-delete errors during teardown are non-fatal — log and move on.
    console.warn(`teardown: failed to delete ${type}/${slug}: ${errMsg(err)}`);
  }
}

async function rankForPair(
  cfg: Config,
  pair: Pair,
  limit: number,
  mode: Mode,
): Promise<{ rank: number | null; topSlugs: string[]; error: string | null }> {
  const lines: string[] = [];
  try {
    if (mode === "search") {
      await searchCmd({
        cfg,
        query: pair.query,
        limit,
        print: (l) => lines.push(l),
      });
    } else {
      // ask / ask-no-llm: same command, different flag.
      const aOpts: Parameters<typeof askCmd>[0] = {
        cfg,
        query: pair.query,
        limit,
        print: (l) => lines.push(l),
      };
      if (mode === "ask-no-llm") aOpts.noLlm = true;
      await askCmd(aOpts);
    }
  } catch (err) {
    return { rank: null, topSlugs: [], error: errMsg(err) };
  }
  if (lines.length === 1 && lines[0] === "no matches") {
    return { rank: null, topSlugs: [], error: null };
  }
  const slugs = lines
    .map((line) => line.trimStart().split(/\s+/)[0] ?? "")
    // Drop the "note:" auto-fallback line emitted by ask when the API key
    // is missing, and the "expansions:" header from --explain. Both start
    // with non-slug tokens, so any line whose first token doesn't look like
    // a slug is ignored.
    .filter((s) => /^[a-z0-9][a-z0-9-_]*$/.test(s));
  const idx = slugs.indexOf(pair.expected_slug);
  return { rank: idx < 0 ? null : idx + 1, topSlugs: slugs, error: null };
}

function computeMetrics(results: PairResult[], k: number): Report["metrics"] {
  const evaluated = results.filter((r) => r.error === null);
  const n = evaluated.length;
  if (n === 0) return { "p@1": 0, "p@3": 0, "p@5": 0, mrr: 0 };
  let p1 = 0;
  let p3 = 0;
  let p5 = 0;
  let mrrSum = 0;
  for (const r of evaluated) {
    if (r.rank !== null) {
      if (r.rank <= 1) p1++;
      if (r.rank <= 3) p3++;
      if (r.rank <= 5) p5++;
      if (r.rank <= k) mrrSum += 1 / r.rank;
    }
  }
  return {
    "p@1": p1 / n,
    "p@3": p3 / n,
    "p@5": p5 / n,
    mrr: mrrSum / n,
  };
}

function fmtPct(v: number): string {
  return (v * 100).toFixed(1) + "%";
}

function printTable(report: Report): void {
  console.log("");
  console.log(`fbrain retrieval eval — ${report.generated_at}`);
  console.log(`node: ${report.node_url}`);
  console.log(
    `pairs: ${report.total_pairs}  evaluated: ${report.evaluated}  errors: ${report.errors}  k: ${report.k}`,
  );
  console.log("");
  console.log("metrics:");
  console.log(`  mode             P@1     P@3     P@5     MRR`);
  for (const m of report.modes) {
    console.log(
      `  ${m.mode.padEnd(15)} ${fmtPct(m.metrics["p@1"]).padStart(6)}  ${fmtPct(m.metrics["p@3"]).padStart(6)}  ${fmtPct(m.metrics["p@5"]).padStart(6)}  ${m.metrics.mrr.toFixed(3).padStart(6)}`,
    );
  }
  console.log("");
  for (const m of report.modes) {
    console.log(`per-pair (${m.mode}):`);
    console.log(
      "  rank  type        slug                                          query",
    );
    for (const r of m.results) {
      const rank = r.error
        ? "ERR"
        : r.rank === null
          ? "—"
          : String(r.rank);
      console.log(
        `  ${rank.padStart(4)}  ${r.expected_type.padEnd(10)}  ${r.expected_slug.padEnd(44)}  ${truncate(r.query, 60)}`,
      );
      if (r.error) console.log(`        error: ${r.error}`);
    }
    console.log("");
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function errMsg(err: unknown): string {
  if (err instanceof FbrainError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`eval-retrieval: ${errMsg(err)}`);
    printHelp();
    return 2;
  }

  const file = loadPairs();
  const cfg = readCfgOrSkip();
  if (cfg === null) return 0;
  if (!(await nodeReachable(cfg))) {
    console.log(`eval-retrieval: node unreachable at ${cfg.nodeUrl}; skipping.`);
    return 0;
  }

  // Seeding is mode-independent — do it once. Then run each mode's queries
  // against the same corpus.
  const seededSlugs: Array<{ slug: string; type: RecordType }> = [];
  const seedErrorByPair = new Map<string, string>();

  if (!args.noSeed) {
    for (const pair of file.pairs) {
      const type = pair.expected_type as RecordType;
      const r = await seedIfMissing(cfg, pair);
      if (r.seeded) seededSlugs.push({ slug: pair.expected_slug, type });
      if (r.error !== null) seedErrorByPair.set(pair.expected_slug, r.error);
    }
  }

  const modeReports: ModeReport[] = [];
  for (const mode of args.modes) {
    const results: PairResult[] = [];
    for (const pair of file.pairs) {
      const type = pair.expected_type as RecordType;
      const seeded = seededSlugs.some((s) => s.slug === pair.expected_slug);
      const seedError = seedErrorByPair.get(pair.expected_slug) ?? null;
      if (seedError !== null) {
        results.push({
          query: pair.query,
          expected_slug: pair.expected_slug,
          expected_type: type,
          rank: null,
          top_k_slugs: [],
          seeded,
          error: seedError,
        });
        continue;
      }
      const r = await rankForPair(cfg, pair, args.limit, mode);
      results.push({
        query: pair.query,
        expected_slug: pair.expected_slug,
        expected_type: type,
        rank: r.rank,
        top_k_slugs: r.topSlugs,
        seeded,
        error: r.error,
      });
    }
    modeReports.push({
      mode,
      metrics: computeMetrics(results, args.limit),
      results,
    });
  }

  // Cleanup seeded records (default) unless --keep.
  if (!args.keep) {
    for (const s of seededSlugs) await teardown(cfg, s.slug, s.type);
  }

  // Legacy single-mode top-level fields come from the first mode.
  const primary = modeReports[0]!;
  const errors = primary.results.filter((r) => r.error !== null).length;
  const report: Report = {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    node_url: cfg.nodeUrl,
    total_pairs: file.pairs.length,
    evaluated: primary.results.length - errors,
    skipped: 0,
    errors,
    k: args.limit,
    metrics: primary.metrics,
    results: primary.results,
    modes: modeReports,
  };

  if (args.format === "table+json") printTable(report);
  console.log(JSON.stringify(report, null, 2));
  if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2) + "\n", "utf8");

  // Always exit 0 — non-blocking by design. Future gating goes here.
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`eval-retrieval: unexpected error: ${errMsg(err)}`);
    // Still exit 0 — CI is non-blocking until baseline gating lands.
    process.exit(0);
  });
