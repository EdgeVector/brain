// `fbrain search <query> [-n N] [--exact] [--min-score F]` — semantic search
// over the native index, with fragment→record resolution.
//
// The node's /api/native-index/search returns one row per indexed fragment
// (e.g. a long body splits into multiple hits). We dedupe by
// (schema_display_name, key_value.hash), keep the highest-score fragment
// per record, resolve each unique hit to its full record via findBySlug,
// and silently skip stale hits (record deleted since indexing).

import {
  newNodeClient,
  type NativeIndexHit,
  type SearchOptions as ClientSearchOptions,
  type Verbose,
  recordTypeForHash,
} from "../client.ts";
import type { Config } from "../config.ts";
import { formatTable } from "../format.ts";
import {
  findBySlug,
  schemaHashFor,
  type FbrainRecord,
} from "../record.ts";
import type { RecordType } from "../schemas.ts";

export type SearchOptions = {
  cfg: Config;
  query: string;
  limit?: number;
  exact?: boolean;
  minScore?: number;
  // Restrict results to these record types. Undefined / empty = all 8 types.
  // Repeatable on the CLI via `--type T` (e.g. `--type design --type task`).
  types?: readonly RecordType[];
  verbose?: Verbose;
  print?: (line: string) => void;
};

export type ResolvedHit = {
  slug: string;
  schemaDisplayName: string;
  schemaHash: string;
  type: RecordType;
  score: number | null;
  matchType: string | null;
  record: FbrainRecord;
};

export async function searchCmd(opts: SearchOptions): Promise<void> {
  const print = opts.print ?? ((line: string) => console.log(line));
  const node = newNodeClient({
    baseUrl: opts.cfg.nodeUrl,
    userHash: opts.cfg.userHash,
    verbose: opts.verbose,
  });

  const clientOpts: ClientSearchOptions = {};
  if (opts.exact) clientOpts.exact = true;
  if (typeof opts.minScore === "number") clientOpts.minScore = opts.minScore;
  // Scope the server-side search to fbrain's registered schemas so the
  // top-50 cosine cut isn't burned on unrelated schemas hosted by the
  // same daemon (Persona / User Accounts / Contacts / CalendarEvent / …).
  // See docs/phase-7-search-latency-spike.md (H2b). Requires fold_db
  // PR #264; older daemons ignore the param so this is safe unconditionally.
  //
  // Dedupe: several record types share the unified MEMO hash (concept,
  // preference, reference, agent, project, spike all map to the same
  // schema), so Object.values() returns repeats. The server collapses
  // duplicates too, but deduping here keeps the URL compact and the
  // verbose count meaningful ("N unique schemas" vs N record types).
  //
  // When `--type T` is set, restrict to the hashes for those types only.
  // For Phase 6 types (concept | preference | reference | agent | project |
  // spike) that share the unified MEMO hash, the server filter alone can't
  // tell e.g. concept from preference — it'll return any record on that
  // hash. The post-filter on resolved hits (below) finishes the job.
  const typeFilter = opts.types && opts.types.length > 0 ? new Set(opts.types) : null;
  const fbrainSchemas = Array.from(
    new Set(
      Object.entries(opts.cfg.schemaHashes)
        .filter(([t]) => (typeFilter ? typeFilter.has(t as RecordType) : true))
        .map(([, h]) => h)
        .filter((h): h is string => typeof h === "string" && h.length > 0),
    ),
  );
  if (fbrainSchemas.length > 0) {
    clientOpts.schemas = fbrainSchemas;
    opts.verbose?.(
      `scope: native-index search restricted to ${fbrainSchemas.length} fbrain schema hash(es)` +
        (typeFilter ? ` (types: ${[...typeFilter].join(",")})` : ""),
    );
  }

  const hits = await node.search(opts.query, clientOpts);
  opts.verbose?.(`search returned ${hits.length} fragment hit(s)`);

  const unique = dedupeHits(hits, opts.verbose);
  opts.verbose?.(`dedupe collapsed to ${unique.length} unique record(s)`);

  const resolved: ResolvedHit[] = [];
  for (const hit of unique) {
    const slug = hit.key_value.hash;
    if (!slug) {
      opts.verbose?.(`skip: hit has no key_value.hash`);
      continue;
    }
    const type = recordTypeForHash(hit.schema_name, opts.cfg.schemaHashes);
    if (!type) {
      // schema_name didn't match any registered type — likely a superseded
      // schema hash that hasn't been pruned, or a system schema. Skip silently.
      opts.verbose?.(
        `skip: schema_name "${hit.schema_name}" matches no registered fbrain type`,
      );
      continue;
    }
    // Filter by --type. For Design/Task this is purely belt-and-braces (the
    // schemas filter on the wire already excluded them); for the shared
    // MEMO schema it's load-bearing — the server filter keeps every Phase 6
    // record and only the resolved type tells concept apart from preference.
    if (typeFilter && !typeFilter.has(type)) {
      opts.verbose?.(`skip: ${type}/${slug} not in --type filter`);
      continue;
    }
    const schemaHash = schemaHashFor(type, opts.cfg);
    const record = await findBySlug(node, type, schemaHash, slug);
    if (!record) {
      // Stale hit — record deleted since the index was written.
      opts.verbose?.(`skip stale: ${type}/${slug} not found in current store`);
      continue;
    }
    // Display the user-facing record type, capitalized.
    const displayName = capitalize(type);
    const score = typeof hit.metadata?.score === "number" ? hit.metadata.score : null;
    const matchType = typeof hit.metadata?.match_type === "string" ? hit.metadata.match_type : null;
    opts.verbose?.(
      `kept: ${type}/${slug} score=${score ?? "—"} schema=${hit.schema_display_name ?? hit.schema_name}`,
    );
    resolved.push({
      slug,
      schemaDisplayName: displayName,
      schemaHash: hit.schema_name,
      type,
      score,
      matchType,
      record,
    });
  }

  resolved.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

  const trimmed = opts.limit && opts.limit > 0 ? resolved.slice(0, opts.limit) : resolved;

  if (trimmed.length === 0) {
    print("no matches");
    print(
      "hint:  fresh writes may take a moment to land in the vector index — try `fbrain ask <query> --no-llm` (BM25 fallback) or `fbrain reindex` (see docs/phase-7-search-latency-spike.md)",
    );
    return;
  }

  const lines = formatTable(
    trimmed.map((hit) => [
      hit.slug,
      hit.score === null ? "—" : hit.score.toFixed(3),
      hit.schemaDisplayName,
      hit.record.title,
    ]),
    { align: ["left", "right", "left", "left"] },
  );
  for (const line of lines) print(line);
}

function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Exported for unit tests.
export function dedupeHits(
  hits: NativeIndexHit[],
  verbose?: Verbose,
): NativeIndexHit[] {
  const best = new Map<string, NativeIndexHit>();
  for (const hit of hits) {
    const slug = hit.key_value.hash;
    if (!slug) continue;
    const displayName =
      typeof hit.schema_display_name === "string" && hit.schema_display_name.length > 0
        ? hit.schema_display_name
        : hit.schema_name;
    const key = `${displayName}::${slug}`;
    const score = typeof hit.metadata?.score === "number" ? hit.metadata.score : -1;
    const prior = best.get(key);
    const priorScore = typeof prior?.metadata?.score === "number" ? prior.metadata.score : -1;
    if (!prior || score > priorScore) {
      if (prior) verbose?.(`dedupe: ${key} (score ${priorScore} → ${score})`);
      best.set(key, hit);
    } else {
      verbose?.(`dedupe: drop fragment of ${key} (score ${score} ≤ ${priorScore})`);
    }
  }
  return Array.from(best.values());
}
