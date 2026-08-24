#!/usr/bin/env bun
// Graph-adjacency ranking eval for brain — phase 3 of the knowledge graph.
//
// WHAT THIS MEASURES
// `eval/graph/pairs.json` holds a small knowledge graph and 30+ labeled
// (query, expected record) pairs in two classes:
//
//   adjacency  the expected record answers a question ABOUT a topic while
//              using almost none of that topic's words. Text ranking finds
//              the neighbour, not the answer. These are the pairs the boost
//              exists to fix.
//   control    the expected record wins on its own text. The boost must not
//              move these.
//
// The harness runs every query TWICE against the same node — once with the
// boost off, once with it on — and reports P@1 / P@3 / P@5 / MRR for both,
// SPLIT BY CLASS. A lift on adjacency pairs paid for by a regression on
// control pairs is not a lift, and a single blended number hides exactly that
// trade, so the split is the headline and the overall figure is secondary.
//
// WHY THE DEFAULT DOES NOT CHANGE HERE
// `design-brain-knowledge-graph` decision 4 settled that the adjacency boost
// ships behind a flag and becomes the default only on measured P@5 lift. This
// script produces that measurement; it does not change any default, and
// running it must never be a prerequisite for `ask` to work.
//
// CI SAFETY
// Exits 0 when there is no config and when the node is unreachable, the same
// contract `scripts/eval-retrieval.ts` follows — CI has no node, and a
// missing node must read as "not measured", never as a failing gate.
//
// CLI:
//   bun scripts/eval-graph-boost.ts                 # seed, measure, teardown
//   bun scripts/eval-graph-boost.ts --no-seed       # measure an already-seeded corpus
//   bun scripts/eval-graph-boost.ts --keep          # skip teardown (debugging)
//   bun scripts/eval-graph-boost.ts --limit 10      # top-K considered (default 10)
//   bun scripts/eval-graph-boost.ts --weight 0.75   # boost weight  (default: module default)
//   bun scripts/eval-graph-boost.ts --seeds 5       # adjacency seeds (default: module default)
//   bun scripts/eval-graph-boost.ts --format json   # emit JSON only
//   bun scripts/eval-graph-boost.ts --out FILE      # write the JSON report to FILE

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { askCmd, type AskOptions } from "../src/commands/ask.ts";
import { putCmd } from "../src/commands/put.ts";
import { deleteRecord } from "../src/commands/delete.ts";
import { findBySlug, schemaHashFor } from "../src/record.ts";
import { newNodeClient } from "../src/client.ts";
import { tryReadConfig, type Config } from "../src/config.ts";
import { isRecordType, type RecordType } from "../src/schemas.ts";
import { graphEdgesUnavailable } from "../src/graph-traverse.ts";
import {
  ADJACENCY_DEFAULT_SEEDS,
  ADJACENCY_DEFAULT_WEIGHT,
} from "../src/retrieval/adjacency.ts";

type PairKind = "adjacency" | "control";

type FixtureRecord = {
  slug: string;
  type: string;
  title: string;
  body: string;
  tags?: string[];
};

type Pair = {
  query: string;
  expected_slug: string;
  expected_type: string;
  kind: PairKind;
  notes?: string;
};

type Fixture = {
  slug_prefix: string;
  records: FixtureRecord[];
  pairs: Pair[];
};

type Arm = "baseline" | "boosted";

type PairResult = {
  query: string;
  expected_slug: string;
  expected_type: RecordType;
  kind: PairKind;
  /** 1-based rank of the expected slug within top-K; null = not found. */
  rank: number | null;
  top_slugs: string[];
  /** Score the boost added to the expected record, when it was boosted. */
  boost_applied: number | null;
  error: string | null;
};

type Metrics = { "p@1": number; "p@3": number; "p@5": number; mrr: number; n: number };

type ArmReport = {
  arm: Arm;
  overall: Metrics;
  by_kind: Record<PairKind, Metrics>;
  results: PairResult[];
};

type Delta = { "p@1": number; "p@3": number; "p@5": number; mrr: number };

type Report = {
  generated_at: string;
  node_url: string;
  k: number;
  weight: number;
  seeds: number;
  total_pairs: number;
  edges_available: boolean;
  arms: ArmReport[];
  delta: { overall: Delta; by_kind: Record<PairKind, Delta> };
  /** Pairs whose rank changed, so a reader can see WHICH queries moved. */
  moved: Array<{
    query: string;
    expected_slug: string;
    kind: PairKind;
    baseline_rank: number | null;
    boosted_rank: number | null;
  }>;
  seeded: string[];
  torn_down: boolean;
};

const EXIT_OK = 0;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function printHelp(): void {
  console.log(
    "bun scripts/eval-graph-boost.ts [--no-seed] [--keep] [--limit N] [--weight W] [--seeds N]\n" +
      "                               [--format json|table+json] [--out FILE]\n\n" +
      "Measure the graph adjacency boost against its labeled fixture: every query runs\n" +
      "with the boost off and on, and the report splits adjacency pairs from control\n" +
      "pairs. Exits 0 with no config and with an unreachable node — CI has no node, and\n" +
      "an unmeasured run is not a failing run.\n",
  );
}

function loadFixture(): Fixture {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "..", "eval", "graph", "pairs.json");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${path} is not a JSON object`);
  }
  const file = parsed as Fixture;
  if (!Array.isArray(file.records) || !Array.isArray(file.pairs)) {
    throw new Error(`${path} is malformed (needs "records" and "pairs" arrays)`);
  }
  if (typeof file.slug_prefix !== "string" || file.slug_prefix.length === 0) {
    throw new Error(`${path} missing "slug_prefix"`);
  }
  // The card's contract is a 30-50 query fixture. Fail loud rather than
  // report a confident-looking delta measured over a handful of queries.
  if (file.pairs.length < 30) {
    throw new Error(
      `${path} has only ${file.pairs.length} pairs; the graph eval requires >= 30.`,
    );
  }
  const bySlug = new Map(file.records.map((r) => [r.slug, r]));
  for (const [i, r] of file.records.entries()) {
    if (!r.slug?.startsWith(file.slug_prefix)) {
      throw new Error(`records[${i}].slug must start with "${file.slug_prefix}"`);
    }
    if (!isRecordType(r.type)) throw new Error(`records[${i}].type invalid: ${r.type}`);
  }
  for (const [i, p] of file.pairs.entries()) {
    if (typeof p.query !== "string" || p.query.length === 0) {
      throw new Error(`pairs[${i}].query must be a non-empty string`);
    }
    if (!bySlug.has(p.expected_slug)) {
      throw new Error(`pairs[${i}].expected_slug "${p.expected_slug}" is not in records`);
    }
    if (p.kind !== "adjacency" && p.kind !== "control") {
      throw new Error(`pairs[${i}].kind must be "adjacency" or "control" (got ${p.kind})`);
    }
    if (!isRecordType(p.expected_type)) {
      throw new Error(`pairs[${i}].expected_type invalid: ${p.expected_type}`);
    }
  }
  return file;
}

function frontmatterFor(rec: FixtureRecord): string {
  const tags = Array.isArray(rec.tags) ? rec.tags : [];
  return [
    "---",
    `type: ${rec.type}`,
    `title: ${JSON.stringify(rec.title)}`,
    `tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]`,
    "---",
    rec.body,
  ].join("\n");
}

/**
 * Liveness probe, routed the SAME way every other read is.
 *
 * A bare `fetch(cfg.nodeUrl + ...)` is wrong here: this brain reaches its node
 * over a unix domain socket, and the socket is attached by the node client,
 * not by the URL. Probing with plain fetch reports every socket-routed node as
 * unreachable, so the eval would skip on exactly the machines that can run it.
 */
async function nodeReachable(cfg: Config): Promise<boolean> {
  try {
    const node = newNodeClient({ baseUrl: cfg.nodeUrl, userHash: cfg.userHash });
    const identity = await node.autoIdentity();
    // Either answer means the node responded. `provisioned: false` is a node
    // that is up and simply has no identity yet.
    return identity !== undefined && identity !== null;
  } catch {
    return false;
  }
}

async function seedIfMissing(cfg: Config, rec: FixtureRecord): Promise<boolean> {
  const type = rec.type as RecordType;
  const node = newNodeClient({ baseUrl: cfg.nodeUrl, userHash: cfg.userHash });
  const existing = await findBySlug(node, type, schemaHashFor(type, cfg), rec.slug);
  if (existing) return false;
  // `putCmd` is what extracts the [[type::slug]] links into the edge planes,
  // so seeding through it is what makes this a GRAPH fixture rather than a
  // pile of unconnected records.
  await putCmd({ cfg, slug: rec.slug, input: frontmatterFor(rec), print: () => {} });
  return true;
}

async function runArm(
  cfg: Config,
  pair: Pair,
  limit: number,
  arm: Arm,
  tuning: { weight: number; seeds: number },
): Promise<PairResult> {
  const base: PairResult = {
    query: pair.query,
    expected_slug: pair.expected_slug,
    expected_type: pair.expected_type as RecordType,
    kind: pair.kind,
    rank: null,
    top_slugs: [],
    boost_applied: null,
    error: null,
  };
  const opts: AskOptions = {
    cfg,
    query: pair.query,
    limit,
    // Structured sink instead of scraping printed rows: the rendered list has
    // note lines and legends in it, and a regex over them is a silent
    // mis-measurement waiting to happen.
    print: () => {},
    printErr: () => {},
  };
  if (arm === "boosted") {
    opts.graphBoost = true;
    opts.graphBoostOptions = { weight: tuning.weight, seedCount: tuning.seeds };
  }
  let payloadSlugs: string[] = [];
  opts.onResult = (payload) => {
    payloadSlugs = payload.map((h) => h.slug);
  };
  try {
    const result = await askCmd(opts);
    const idx = payloadSlugs.indexOf(pair.expected_slug);
    const boost = result.graphBoost?.boosts.find((b) => b.slug === pair.expected_slug);
    return {
      ...base,
      rank: idx < 0 ? null : idx + 1,
      top_slugs: payloadSlugs,
      boost_applied: boost ? boost.total : null,
    };
  } catch (err) {
    return { ...base, error: errMsg(err) };
  }
}

function computeMetrics(results: readonly PairResult[], k: number): Metrics {
  const evaluated = results.filter((r) => r.error === null);
  const n = evaluated.length;
  if (n === 0) return { "p@1": 0, "p@3": 0, "p@5": 0, mrr: 0, n: 0 };
  let p1 = 0;
  let p3 = 0;
  let p5 = 0;
  let mrr = 0;
  for (const r of evaluated) {
    if (r.rank === null) continue;
    if (r.rank <= 1) p1++;
    if (r.rank <= 3) p3++;
    if (r.rank <= 5) p5++;
    if (r.rank <= k) mrr += 1 / r.rank;
  }
  return { "p@1": p1 / n, "p@3": p3 / n, "p@5": p5 / n, mrr: mrr / n, n };
}

function buildArmReport(arm: Arm, results: PairResult[], k: number): ArmReport {
  return {
    arm,
    overall: computeMetrics(results, k),
    by_kind: {
      adjacency: computeMetrics(results.filter((r) => r.kind === "adjacency"), k),
      control: computeMetrics(results.filter((r) => r.kind === "control"), k),
    },
    results,
  };
}

function deltaOf(before: Metrics, after: Metrics): Delta {
  return {
    "p@1": after["p@1"] - before["p@1"],
    "p@3": after["p@3"] - before["p@3"],
    "p@5": after["p@5"] - before["p@5"],
    mrr: after.mrr - before.mrr,
  };
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function fmtDeltaPct(v: number): string {
  const s = `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
  return s;
}

function fmtDelta(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(3)}`;
}

function printTable(report: Report): void {
  const [baseline, boosted] = report.arms;
  console.log("");
  console.log(`brain graph adjacency eval — ${report.generated_at}`);
  console.log(`node: ${report.node_url}`);
  console.log(
    `pairs: ${report.total_pairs}  k: ${report.k}  weight: ${report.weight}  seeds: ${report.seeds}`,
  );
  if (!report.edges_available) {
    console.log("WARNING: the edge schemas are not configured on this node — the boosted arm");
    console.log("         could not read any adjacency, so a zero delta means UNMEASURED.");
  }
  console.log("");
  const rows: Array<[string, Metrics, Metrics]> = [
    ["overall", baseline!.overall, boosted!.overall],
    ["adjacency", baseline!.by_kind.adjacency, boosted!.by_kind.adjacency],
    ["control", baseline!.by_kind.control, boosted!.by_kind.control],
  ];
  console.log("  class        n     arm        P@1     P@3     P@5     MRR");
  for (const [label, before, after] of rows) {
    console.log(
      `  ${label.padEnd(11)} ${String(before.n).padStart(3)}   baseline  ` +
        `${fmtPct(before["p@1"]).padStart(6)}  ${fmtPct(before["p@3"]).padStart(6)}  ` +
        `${fmtPct(before["p@5"]).padStart(6)}  ${before.mrr.toFixed(3).padStart(6)}`,
    );
    console.log(
      `  ${"".padEnd(11)} ${"".padStart(3)}   boosted   ` +
        `${fmtPct(after["p@1"]).padStart(6)}  ${fmtPct(after["p@3"]).padStart(6)}  ` +
        `${fmtPct(after["p@5"]).padStart(6)}  ${after.mrr.toFixed(3).padStart(6)}`,
    );
    const d = deltaOf(before, after);
    console.log(
      `  ${"".padEnd(11)} ${"".padStart(3)}   delta     ` +
        `${fmtDeltaPct(d["p@1"]).padStart(6)}  ${fmtDeltaPct(d["p@3"]).padStart(6)}  ` +
        `${fmtDeltaPct(d["p@5"]).padStart(6)}  ${fmtDelta(d.mrr).padStart(6)}`,
    );
    console.log("");
  }
  if (report.moved.length === 0) {
    console.log("no query changed rank.");
  } else {
    console.log("queries whose rank changed:");
    console.log("  class       base -> boost  slug");
    for (const m of report.moved) {
      const b = m.baseline_rank === null ? "—" : String(m.baseline_rank);
      const a = m.boosted_rank === null ? "—" : String(m.boosted_rank);
      console.log(`  ${m.kind.padEnd(10)}  ${b.padStart(4)} -> ${a.padStart(5)}  ${m.expected_slug}`);
    }
  }
  console.log("");
  console.log(
    "The default stays OFF until adjacency P@5 rises and control P@5 does not fall " +
      "(design-brain-knowledge-graph, decision 4).",
  );
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return EXIT_OK;
  }
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const noSeed = argv.includes("--no-seed");
  const keep = argv.includes("--keep");
  const limitRaw = flag("--limit");
  const limit = limitRaw === undefined ? 10 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1) {
    console.error(`--limit must be a positive integer (got "${limitRaw}")`);
    return 2;
  }
  const weightRaw = flag("--weight");
  const weight = weightRaw === undefined ? ADJACENCY_DEFAULT_WEIGHT : Number(weightRaw);
  if (!Number.isFinite(weight) || weight < 0) {
    console.error(`--weight must be a finite number >= 0 (got "${weightRaw}")`);
    return 2;
  }
  const seedsRaw = flag("--seeds");
  const seeds = seedsRaw === undefined ? ADJACENCY_DEFAULT_SEEDS : Number(seedsRaw);
  if (!Number.isInteger(seeds) || seeds < 1) {
    console.error(`--seeds must be a positive integer (got "${seedsRaw}")`);
    return 2;
  }
  const format = flag("--format") ?? "table+json";
  const outPath = flag("--out");

  const fixture = loadFixture();

  let cfg: Config | null = null;
  try {
    cfg = tryReadConfig();
  } catch (err) {
    console.log(`eval-graph-boost: config unreadable (${errMsg(err)}); skipping.`);
    return EXIT_OK;
  }
  if (cfg === null) {
    console.log("eval-graph-boost: no brain config (run `brain init`); skipping.");
    return EXIT_OK;
  }
  if (!(await nodeReachable(cfg))) {
    console.log(`eval-graph-boost: node at ${cfg.nodeUrl} unreachable; skipping.`);
    return EXIT_OK;
  }
  const edgesAvailable = !graphEdgesUnavailable(cfg);
  if (!edgesAvailable) {
    // Still run: the baseline arm is meaningful on its own, and a report that
    // says "edges absent" is far more useful than a silent zero delta.
    console.log(
      "eval-graph-boost: WARNING — edge schemas absent from this config; the boosted arm " +
        "cannot read adjacency.",
    );
  }

  const seeded: string[] = [];
  if (!noSeed) {
    for (const rec of fixture.records) {
      try {
        if (await seedIfMissing(cfg, rec)) seeded.push(rec.slug);
      } catch (err) {
        console.error(`seed failed for ${rec.slug}: ${errMsg(err)}`);
        return 1;
      }
    }
    if (seeded.length > 0) console.log(`seeded ${seeded.length} record(s).`);
  }

  const baselineResults: PairResult[] = [];
  const boostedResults: PairResult[] = [];
  try {
    for (const pair of fixture.pairs) {
      baselineResults.push(await runArm(cfg, pair, limit, "baseline", { weight, seeds }));
      boostedResults.push(await runArm(cfg, pair, limit, "boosted", { weight, seeds }));
    }
  } finally {
    if (seeded.length > 0 && !keep) {
      for (const rec of fixture.records) {
        if (!seeded.includes(rec.slug)) continue;
        try {
          await deleteRecord({
            cfg,
            slug: rec.slug,
            type: rec.type as RecordType,
            print: () => {},
          });
        } catch (err) {
          console.warn(`teardown: failed to delete ${rec.type}/${rec.slug}: ${errMsg(err)}`);
        }
      }
    }
  }

  const baseline = buildArmReport("baseline", baselineResults, limit);
  const boosted = buildArmReport("boosted", boostedResults, limit);
  const moved: Report["moved"] = [];
  for (let i = 0; i < baselineResults.length; i++) {
    const b = baselineResults[i]!;
    const a = boostedResults[i]!;
    if (b.rank !== a.rank) {
      moved.push({
        query: b.query,
        expected_slug: b.expected_slug,
        kind: b.kind,
        baseline_rank: b.rank,
        boosted_rank: a.rank,
      });
    }
  }
  const report: Report = {
    generated_at: new Date().toISOString(),
    node_url: cfg.nodeUrl,
    k: limit,
    weight,
    seeds,
    total_pairs: fixture.pairs.length,
    edges_available: edgesAvailable,
    arms: [baseline, boosted],
    delta: {
      overall: deltaOf(baseline.overall, boosted.overall),
      by_kind: {
        adjacency: deltaOf(baseline.by_kind.adjacency, boosted.by_kind.adjacency),
        control: deltaOf(baseline.by_kind.control, boosted.by_kind.control),
      },
    },
    moved,
    seeded,
    torn_down: seeded.length > 0 && !keep,
  };

  if (format !== "json") printTable(report);
  const json = JSON.stringify(report, null, 2);
  if (outPath) {
    writeFileSync(outPath, `${json}\n`);
    if (format !== "json") console.log(`report written to ${outPath}`);
  } else if (format === "json") {
    console.log(json);
  }
  return EXIT_OK;
}

process.exit(await main(process.argv.slice(2)));
