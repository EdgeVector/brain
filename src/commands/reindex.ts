// `fbrain reindex [--type T] [--dry-run] [--verbose]` — refresh embeddings
// for every live fbrain record.
//
// Related to the H2a finding in docs/phase-7-search-latency-spike.md:
// `fbrain delete` is soft (tombstone tag) and does NOT purge the
// corresponding entries from fold_db's `EmbeddingIndex`. Over time, the
// native-index top-50 fills with stale embeddings + entries from other
// schemas, drowning out fresh records. This command iterates every live
// record and re-issues an update mutation, which re-runs fold_db's
// `index_record`. IMPORTANT: fold_db's index is append-only — re-issuing
// the update does NOT replace the prior embedding in place; it APPENDS a
// fresh embedding and the previous entry persists as stale. So reindex
// only guarantees each live record's CURRENT embedding is present; it does
// NOT de-duplicate the index and it does NOT reduce pollution (it actually
// adds one stale entry per record re-put). The true purge of stale and
// tombstoned embeddings is upstream fold_db work, deferred (G3e
// tombstone-purge / G3d schema-scoped search) and not available at the
// fbrain layer. See `fbrain doctor --freshness` pollution-probe.
//
// Iterates all 8 types by default; --type narrows. Tombstoned records
// (those carrying TOMBSTONE_TAG) are skipped, NOT reindexed.
//
// Per Step 6 of the G3c task: pollution-ratio reporting is deferred to
// G3a (`fbrain doctor freshness`). This command reports the count of
// records reindexed.

import { type Verbose } from "../client.ts";
import { newWriteClientFromCfg } from "../write-context.ts";
import type { Config } from "../config.ts";
import { resolvePrintSink } from "../format.ts";
import {
  isTombstoned,
  listRecords,
  nowIso,
  schemaHashFor,
  type FbrainRecord,
} from "../record.ts";
import { RECORDS, RECORD_TYPES, type RecordType } from "../schemas.ts";
import { rebuildTagIndex, tagIndexAvailable, type TagIndexRebuildResult } from "../tag-index.ts";

export type ReindexOptions = {
  cfg: Config;
  type?: RecordType;
  dryRun?: boolean;
  // Repair-only mode: skip the embedding refresh and only fix records whose
  // stored `title` is the literal text of a YAML block-scalar indicator
  // (`>`, `>-`, `>+`, `|`, `|-`, `|+`). These were created by a pre-fix
  // import path that pasted the indicator into the title slot instead of
  // folding the scalar body — see #7852b. Title is repaired to the first
  // H1 of the body, or the slug as last resort (the original folded text
  // is unrecoverable). Idempotent: a second run finds nothing to fix.
  repairTitles?: boolean;
  // Tag-index rebuild mode (`fbrain reindex --tags`): skip the embedding refresh
  // and instead rebuild the tag SECONDARY INDEX from a full corpus scan — the
  // authoritative repair for a stale/incomplete tag index (e.g. after records
  // were written by a build that predated the index, or a best-effort index
  // update was dropped). Overwrites every tag's index record from the live
  // corpus. No-op (with a note) when the TagIndex schema isn't in config.
  tags?: boolean;
  verbose?: Verbose;
  print?: (line: string) => void;
};

export type ReindexResult = {
  scanned: number;
  reindexed: number;
  skippedTombstone: number;
  // Populated only when `repairTitles` is set. Each entry: { type, slug,
  // previousTitle, newTitle, source: "h1" | "slug" }.
  repaired?: Array<{
    type: RecordType;
    slug: string;
    previousTitle: string;
    newTitle: string;
    source: "h1" | "slug";
  }>;
  byType: Partial<Record<RecordType, { reindexed: number; skippedTombstone: number }>>;
  // Populated only when `tags` is set — the tag-index rebuild summary.
  tagIndex?: TagIndexRebuildResult;
};

// Literal text the corrupted import wrote into the title slot. Matches the
// set of YAML block-scalar indicators the parser now folds correctly.
const BLOCK_SCALAR_INDICATORS = new Set([">", ">-", ">+", "|", "|-", "|+"]);

function isCorruptBlockScalarTitle(title: string): boolean {
  return BLOCK_SCALAR_INDICATORS.has(title.trim());
}

// Pick a repaired title. Mirrors put.ts's resolveTitle fallback chain
// (first H1, else slug) since the original folded text is lost.
export function pickRepairedTitle(
  body: string,
  slug: string,
): { title: string; source: "h1" | "slug" } {
  for (const line of body.split("\n")) {
    if (line.trim().length === 0) continue;
    const m = line.match(/^#\s+(.+)$/);
    if (m) return { title: m[1]!.trim(), source: "h1" };
    break;
  }
  return { title: slug, source: "slug" };
}

export async function reindexCmd(opts: ReindexOptions): Promise<ReindexResult> {
  const print = resolvePrintSink(opts);
  // --dry-run issues no writes, so it never invokes the capability provider
  // and never triggers consent; a real reindex acquires on its first update.
  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);

  // Tag-index rebuild is a self-contained mode: it rebuilds the tag SECONDARY
  // INDEX from a corpus scan and returns, without touching embeddings or titles.
  if (opts.tags) {
    const result: ReindexResult = {
      scanned: 0,
      reindexed: 0,
      skippedTombstone: 0,
      byType: {},
    };
    if (!tagIndexAvailable(opts.cfg)) {
      print(
        "tag index not available in this config (re-run `fbrain init` to register the TagIndex schema) — nothing to rebuild",
      );
      result.tagIndex = { tagsIndexed: 0, membersIndexed: 0 };
      return result;
    }
    if (opts.dryRun) {
      print("dry-run: --tags would rebuild the tag secondary index from a full corpus scan");
      result.tagIndex = { tagsIndexed: 0, membersIndexed: 0 };
      return result;
    }
    const rebuilt = await rebuildTagIndex(node, opts.cfg, {
      listRecords: (type, schemaHash) => listRecords(node, type, schemaHash),
      schemaHashFor: (type) => schemaHashFor(type, opts.cfg),
    });
    result.tagIndex = rebuilt;
    print(
      `rebuilt tag index: ${rebuilt.tagsIndexed} tag(s), ${rebuilt.membersIndexed} membership(s)`,
    );
    return result;
  }

  const types: readonly RecordType[] = opts.type ? [opts.type] : RECORD_TYPES;
  const result: ReindexResult = {
    scanned: 0,
    reindexed: 0,
    skippedTombstone: 0,
    byType: {},
  };
  if (opts.repairTitles) result.repaired = [];

  for (const type of types) {
    const schemaHash = schemaHashFor(type, opts.cfg);
    const records = await listRecords(node, type, schemaHash);
    const counts = { reindexed: 0, skippedTombstone: 0 };
    result.byType[type] = counts;

    for (const record of records) {
      result.scanned++;
      if (isTombstoned(record)) {
        result.skippedTombstone++;
        counts.skippedTombstone++;
        opts.verbose?.(`skipped-tombstone ${type}/${record.slug}`);
        continue;
      }

      if (opts.repairTitles) {
        if (!isCorruptBlockScalarTitle(record.title)) {
          opts.verbose?.(`ok ${type}/${record.slug}`);
          continue;
        }
        const { title: newTitle, source } = pickRepairedTitle(record.body, record.slug);
        const entry = {
          type,
          slug: record.slug,
          previousTitle: record.title,
          newTitle,
          source,
        };
        result.repaired!.push(entry);
        if (opts.dryRun) {
          opts.verbose?.(`would-repair ${type}/${record.slug} → "${newTitle}" (from ${source})`);
          continue;
        }
        const fields = buildReindexFields(type, { ...record, title: newTitle }, nowIso());
        await node.updateRecord({ schemaHash, fields, keyHash: record.slug });
        opts.verbose?.(`repaired ${type}/${record.slug} → "${newTitle}" (from ${source})`);
        continue;
      }

      if (opts.dryRun) {
        result.reindexed++;
        counts.reindexed++;
        opts.verbose?.(`kept ${type}/${record.slug}`);
        continue;
      }

      const fields = buildReindexFields(type, record, nowIso());
      await node.updateRecord({ schemaHash, fields, keyHash: record.slug });
      result.reindexed++;
      counts.reindexed++;
      opts.verbose?.(`reindexed ${type}/${record.slug}`);
    }
  }

  if (opts.repairTitles) {
    const repaired = result.repaired ?? [];
    const prefix = opts.dryRun ? "dry-run: would repair" : "repaired";
    const typeScope = opts.type ? ` (type=${opts.type})` : "";
    print(`${prefix} ${repaired.length} title(s)${typeScope}`);
    for (const r of repaired) {
      print(`  ${r.type}/${r.slug}: ${JSON.stringify(r.previousTitle)} → ${JSON.stringify(r.newTitle)} (from ${r.source})`);
    }
    return result;
  }

  const prefix = opts.dryRun ? "dry-run: would reindex" : "reindexed";
  const typeScope = opts.type ? ` (type=${opts.type})` : "";
  print(
    `${prefix} ${result.reindexed} record(s)${typeScope}, skipped ${result.skippedTombstone} tombstoned`,
  );
  // Pollution-ratio reporting is deferred to G3a — see
  // docs/phase-7-search-latency-spike.md G3a row.

  return result;
}

// Build the field payload for a re-issued update mutation. Mirrors
// put.ts's buildFields but takes a FbrainRecord directly: preserves every
// user-meaningful field (slug, title, body, status, tags, created_at,
// design_slug) and only refreshes updated_at. The point is to
// re-trigger fold_db's `index_record` without changing semantics.
export function buildReindexFields(
  type: RecordType,
  record: FbrainRecord,
  now: string,
): Record<string, unknown> {
  const entry = RECORDS[type];
  const fields: Record<string, unknown> = {
    slug: record.slug,
    title: record.title,
    body: record.body,
    status: record.status,
    tags: record.tags,
    created_at: record.created_at,
    updated_at: now,
  };
  if (entry.hasDesignSlug) {
    fields.design_slug = record.design_slug ?? "";
  }
  return fields;
}
