// `brain doctor` probe — the edge-set atom and the link page agree.
//
// There is no scan. This probe reads one page of each type and reports how
// many sources it read. A green line means those sources agree. It does not
// certify the whole graph.
//
// A dangling target is a note. A wiki link to a record that does not exist
// yet stays. Dangling targets do not fail the doctor.
//
// An edge that is on the edge set and not on the destination link page is a
// defect. The same is true the other way. That fails.

import type { NodeClient, Verbose } from "../../client.ts";
import type { Config } from "../../config.ts";
import { readPageChain } from "../../list-page.ts";
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
 * lint issues a handful of keyed reads per seed.
 */
export const DOCTOR_GRAPH_LINT_MAX_SLUGS = 25;

export type GraphLintProbeOptions = {
  maxSlugs?: number;
  /** Seam for tests: supply seeds directly instead of reading the list index. */
  seeds?: readonly string[];
};

/**
 * One page of each type. Null only when the list page schema is absent.
 * An empty page is an empty seed list.
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
  const perType: string[][] = [];
  for (const type of types) {
    let cards;
    try {
      cards = await readPageChain(node, cfg, type, 1);
    } catch {
      continue;
    }
    if (cards === null) return null;
    perType.push(cards.map((card) => card.slug).filter((slug) => slug.length > 0));
  }
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
  // Not a SKIP. A SKIP reads as "nothing to check here" and leaves the run
  // green, which is exactly how a primary brain sat for a phase with every
  // `put` parsing its links and writing no edge row. The schemas ship in the
  // standard `fbrain init` set, so their absence from config is a real defect
  // in this brain, and the whole graph surface — neighbors, path, adjacency
  // boost — silently answers nothing while it lasts.
  if (graphEdgesUnavailable(cfg)) {
    return {
      name,
      ok: false,
      tag: "FAIL",
      detail:
        "the edge-set schema is not in config, so a write stores no edge; " +
        "`graph neighbors`, `graph path`, and the adjacency boost read an empty graph",
      fix: "run `brain init` to register the edge-set schema",
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
        detail: `could not read the list page: ${errText(err)}`,
      };
    }
  }
  if (seeds === null) {
    return {
      name,
      ok: true,
      tag: "SKIP",
      detail: "the list page schema is not in config, so there is no seed set",
      fix: "run `brain init` to register the list page schema",
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
    // Same config defect as the pre-check above, observed one layer down.
    return {
      name,
      ok: false,
      tag: "FAIL",
      detail: "the edge-set schema is not in config, so no edge can be read or written",
      fix: "run `brain init` to register the edge-set schema",
    };
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
        `${scope}; ${mirror.length} edge(s) are on the edge set or the link page only ` +
        `(${summarize(mirror)})`,
      fix: "put the source record again so the edge set and the link page match",
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
  return { name, ok: true, detail: `${scope}; the edge set and the link page agree` };
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
