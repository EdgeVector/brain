// `fbrain doctor` probe — structural integrity of the typed graph-edge planes.
//
// WHAT THIS CHECK CAN HONESTLY SAY. There is no scan, so this probe cannot
// enumerate "every record that has edges" and therefore cannot certify the
// whole graph. It seeds from a BOUNDED slice of the keyed type-list index and
// reports exactly how many sources it read. A green line here means "the
// sources I sampled are internally consistent", and the detail string says so
// with a number — it never implies corpus-wide cleanliness.
//
// WHY DANGLING IS A WARN AND MIRROR DRIFT IS A FAIL. A dangling target is
// often intentional in this product: `src/commands/backlinks.ts` documents
// that a `[[slug]]` to a record that does not exist yet is a note-to-self, and
// the wiki-link extractor deliberately preserves it. So dangling targets are
// reported, but they do not fail the doctor.
//
// Mirror drift is different in kind. Phase 1 dual-writes each edge into the
// out-plane and the in-plane; if one row exists without its twin, then the two
// planes disagree and a traversal's answer depends on which direction it
// walked. That is a correctness defect in the substrate, and it fails.

import type { NodeClient, Verbose } from "../../client.ts";
import type { Config } from "../../config.ts";
import { readTypeListIndex } from "../../record-list-index.ts";
import { RECORD_TYPES, type RecordType } from "../../schemas.ts";
import {
  graphEdgesUnavailable,
  lintGraphEdges,
  type GraphLintFinding,
} from "../../graph-traverse.ts";
import type { CheckResult } from "../doctor.ts";

/**
 * Cap on seed slugs the doctor probe will lint.
 *
 * Deliberately small: `doctor` is run interactively and must stay cheap. The
 * lint issues a handful of keyed reads per seed, so this bounds the probe to a
 * few hundred reads in the worst case. `brain reindex --graph-edges` is the
 * place to lint a wider slice.
 */
export const DOCTOR_GRAPH_LINT_MAX_SLUGS = 25;

export type GraphLintProbeOptions = {
  maxSlugs?: number;
  /** Seam for tests: supply seeds directly instead of reading the list index. */
  seeds?: readonly string[];
};

/**
 * Collect a bounded seed set from the keyed type-list index.
 *
 * Returns null when no type partition carries the completeness marker — the
 * index is not trustworthy then, and seeding from an unmarked partition would
 * make the probe's coverage number a fiction.
 */
export async function collectGraphLintSeeds(
  node: NodeClient,
  cfg: Config,
  maxSlugs: number,
): Promise<string[] | null> {
  const types: RecordType[] = RECORD_TYPES.filter(
    (t) => (cfg.schemaHashes as Record<string, string | undefined>)[t] !== undefined,
  );
  const seeds: string[] = [];
  let anyMarked = false;
  // Round-robin across types rather than draining one: a lint that only ever
  // sampled `design` would report green while another type's plane rotted.
  const perType: string[][] = [];
  for (const type of types) {
    let records;
    try {
      records = await readTypeListIndex(node, cfg, type);
    } catch {
      continue;
    }
    if (records === null) continue;
    anyMarked = true;
    perType.push(records.map((r) => r.slug).filter((s): s is string => typeof s === "string"));
  }
  if (!anyMarked) return null;
  for (let i = 0; seeds.length < maxSlugs; i += 1) {
    let progressed = false;
    for (const slugs of perType) {
      const slug = slugs[i];
      if (slug === undefined) continue;
      progressed = true;
      seeds.push(slug);
      if (seeds.length >= maxSlugs) break;
    }
    if (!progressed) break;
  }
  return seeds;
}

export async function runGraphEdgeLintProbe(
  node: NodeClient,
  cfg: Config,
  verbose?: Verbose,
  opts: GraphLintProbeOptions = {},
): Promise<CheckResult> {
  const name = "graph-edge-lint";
  if (graphEdgesUnavailable(cfg)) {
    return {
      name,
      ok: true,
      tag: "SKIP",
      detail: "graph-edge schemas are not in config",
      fix: "run `fbrain init` to register them, then `fbrain reindex --graph-edges`",
    };
  }
  const maxSlugs = opts.maxSlugs ?? DOCTOR_GRAPH_LINT_MAX_SLUGS;
  let seeds: readonly string[] | null;
  if (opts.seeds) {
    seeds = opts.seeds;
  } else {
    try {
      seeds = await collectGraphLintSeeds(node, cfg, maxSlugs);
    } catch (err) {
      return {
        name,
        ok: true,
        tag: "SKIP",
        detail: `could not read the type-list index: ${errText(err)}`,
      };
    }
  }
  if (seeds === null) {
    return {
      name,
      ok: true,
      tag: "SKIP",
      detail: "no type-list partition carries the completeness marker, so there is no trustworthy seed set",
      fix: "run `fbrain reindex --list-index` to rebuild it",
    };
  }
  if (seeds.length === 0) {
    return { name, ok: true, tag: "PASS", detail: "no records to lint" };
  }

  let result;
  try {
    result = await lintGraphEdges(node, cfg, { slugs: seeds, maxSlugs });
  } catch (err) {
    return { name, ok: true, tag: "SKIP", detail: `lint could not run: ${errText(err)}` };
  }
  if (result === null) {
    return { name, ok: true, tag: "SKIP", detail: "graph-edge schemas are not in config" };
  }

  verbose?.(
    `graph-edge-lint: sampled ${result.checked} source(s), ${result.edges} edge(s), ` +
      `${result.findings.length} finding(s)`,
  );

  const mirror = result.findings.filter(
    (f) => f.code === "mirror-missing" || f.code === "mirror-orphan",
  );
  const dangling = result.findings.filter((f) => f.code === "dangling-target");
  const self = result.findings.filter((f) => f.code === "self-edge");
  // Say what was sampled, always. A bare "0 issues" would read as a
  // corpus-wide guarantee this probe cannot make.
  const scope = `sampled ${result.checked} source(s), ${result.edges} edge(s)`;

  if (mirror.length > 0) {
    return {
      name,
      ok: false,
      detail:
        `${scope}; ${mirror.length} edge(s) exist on only one plane ` +
        `(${summarize(mirror)}) — a traversal's answer depends on which direction it walks`,
      fix: "run `fbrain reindex --graph-edges` to rewrite both planes from record bodies",
    };
  }
  const notes: string[] = [];
  if (dangling.length > 0) notes.push(`${dangling.length} dangling target(s) (${summarize(dangling)})`);
  if (self.length > 0) notes.push(`${self.length} self-edge(s) (${summarize(self)})`);
  if (notes.length > 0) {
    return {
      name,
      ok: true,
      tag: "WARN",
      detail: `${scope}; ${notes.join("; ")}`,
      fix: "dangling wiki-links are intentional notes-to-self in fbrain bodies; fix only if a slug was renamed",
    };
  }
  return { name, ok: true, detail: `${scope}; both edge planes agree` };
}

/** First few findings, so the detail line is actionable without being a dump. */
function summarize(findings: readonly GraphLintFinding[], limit = 3): string {
  const shown = findings.slice(0, limit).map((f) => `${f.src} -[${f.type}]-> ${f.dst}`);
  const rest = findings.length - shown.length;
  return rest > 0 ? `${shown.join(", ")}, +${rest} more` : shown.join(", ");
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
