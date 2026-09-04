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
// Iterates all record types by default; --type narrows. Tombstoned records
// (those carrying TOMBSTONE_TAG) are skipped, NOT reindexed.
//
// Per Step 6 of the G3c task: pollution-ratio reporting is deferred to
// G3a (`fbrain doctor freshness`). This command reports the count of
// records reindexed.

import { newReadClientFromCfg, type Verbose } from "../client.ts";
import {
  rebuildBacklinkIndex,
  type BacklinkIndexRebuildResult,
} from "../backlink-index.ts";
import { newWriteClientFromCfg } from "../write-context.ts";
import type { Config } from "../config.ts";
import { resolvePrintSink } from "../format.ts";
import {
  isTombstoned,
  listRecords,
  listRecordsAdminScan,
  missingSchemaHashReadNote,
  nowIso,
  schemaHashFor,
  updateFieldsFrom,
  type FbrainRecord,
} from "../record.ts";
import {
  censusTypeListIndex,
  writeTypeListIndex,
  type TypeListIndexCensus,
} from "../record-list-index.ts";
import {
  censusChildTaskIndex,
  writeChildTaskIndex,
  type ChildTaskIndexCensus,
} from "../child-task-index.ts";
import {
  censusPapercutStatusIndex,
  writePapercutStatusIndex,
  type PapercutStatusIndexCensus,
} from "../papercut-status-index.ts";
import { loadOrBuildBm25Index } from "../retrieval/bm25.ts";
import { RECORD_TYPES, type RecordType } from "../schemas.ts";
import {
  rebuildTagIndex,
  tagIndexAvailable,
  type TagIndexRebuildResult,
} from "../tag-index.ts";
import { graphEdgeHashes, reconcileGraphEdges } from "../graph-edge.ts";

export const GRAPH_EDGE_BACKFILL_CAVEAT =
  "WARNING: source enumeration uses Brain's keyed list index, which is known to under-report; " +
  "this is a bounded repair, not proof of complete corpus coverage.";

export type ReindexOptions = {
  cfg: Config;
  type?: RecordType;
  dryRun?: boolean;
  tags?: boolean;
  backlinks?: boolean;
  // Offline pre-warm for the client-side BM25 search cache `ask`/`search`
  // read on every call (see ../retrieval/bm25.ts). This is the explicit,
  // off-the-request-path counterpart to the inline rebuild `ask` does on a
  // cold/stale cache — running this after a bulk edit means the next `ask`
  // hits warm instead of paying for (and now visibly noting) a live rebuild.
  bm25?: boolean;
  /**
   * Rebuild the RecordListEntry keyed list partition from an admin SOT scan
   * of each product schema. Repairs persistent under-report when dual-write
   * patches failed while the completeness marker stayed set (list/search miss
   * rows that `brain get` still resolves). Standalone mode.
   */
  listIndex?: boolean;
  /**
   * Rebuild the ChildTaskIndex keyed (design_slug x task slug) partition
   * from an admin SOT scan of the task schema. Repairs the same class of gap
   * `--list-index` repairs, one layer up: a dual-write patch that failed
   * mid-write, or a historical backfill after the schema was first
   * registered. Standalone mode.
   */
  childTaskIndex?: boolean;
  /** Rebuild the status x slug papercut ledger index from papercut SOT. */
  papercutStatusIndex?: boolean;
  graphEdges?: boolean;
  graphMaxRecords?: number;
  verbose?: Verbose;
  print?: (line: string) => void;
};

export type ReindexResult = {
  scanned: number;
  reindexed: number;
  skippedTombstone: number;
  byType: Partial<
    Record<RecordType, { reindexed: number; skippedTombstone: number }>
  >;
  tagIndex?: TagIndexRebuildResult;
  backlinkIndex?: BacklinkIndexRebuildResult;
  /** Per-type census after `--list-index` (dry-run or repair). */
  listIndexCensus?: TypeListIndexCensus[];
  /** Census after `--child-task-index` (dry-run or repair). */
  childTaskIndexCensus?: ChildTaskIndexCensus;
  /** Census after `--papercut-status-index` (dry-run or repair). */
  papercutStatusIndexCensus?: PapercutStatusIndexCensus;
  graphEdgeRecords?: number;
};

export async function reindexCmd(opts: ReindexOptions): Promise<ReindexResult> {
  const print = resolvePrintSink(opts);

  if (opts.bm25) {
    const result: ReindexResult = {
      scanned: 0,
      reindexed: 0,
      skippedTombstone: 0,
      byType: {},
    };
    if (opts.dryRun) {
      print(
        "dry-run: --bm25 would rebuild the client-side BM25 search cache (read by `ask`/`search`) from a full corpus scan",
      );
      return result;
    }
    // Read-only: no mutation, so no capability/consent flow — same client
    // `ask`/`search` already use for this cache.
    const node = newReadClientFromCfg(opts.cfg, opts.verbose);
    const loaded = await loadOrBuildBm25Index(node, opts.cfg, RECORD_TYPES, {
      verbose: opts.verbose,
      seedListIndex: false,
      forceRebuild: true,
    });
    result.scanned = loaded.corpusSize;
    result.reindexed = loaded.corpusSize;
    print(
      loaded.cacheHit
        ? `bm25 cache already warm (${loaded.corpusSize} record(s)) — nothing to rebuild`
        : `rebuilt bm25 cache (${loaded.corpusSize} record(s)) — the next \`ask\`/\`search\` call hits it warm`,
    );
    return result;
  }

  // --dry-run issues no writes, so it never invokes the capability provider
  // and never triggers consent; a real reindex acquires on its first update.
  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);

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
      print(
        "dry-run: --tags would rebuild the tag secondary index from a full corpus scan",
      );
      result.tagIndex = { tagsIndexed: 0, membersIndexed: 0 };
      return result;
    }
    const rebuilt = await rebuildTagIndex(node, opts.cfg, {
      // SOT, not the product path. This is an admin repair — its own dry-run
      // text says "from a full corpus scan" — and reading through `listRecords`
      // would both depend on the very index this command exists to repair and
      // push a full scan onto a path that must never issue one.
      listRecords: (type, schemaHash) =>
        listRecordsAdminScan(node, type, schemaHash),
      schemaHashFor: (type) => schemaHashFor(type, opts.cfg),
      onSkipUnavailableType: (type) =>
        print(
          missingSchemaHashReadNote(
            [type],
            "rebuilding the tag index from the rest",
          ),
        ),
    });
    result.tagIndex = rebuilt;
    print(
      `rebuilt tag index: ${rebuilt.tagsIndexed} tag(s), ${rebuilt.membersIndexed} membership(s)`,
    );
    return result;
  }

  if (opts.backlinks) {
    const result: ReindexResult = {
      scanned: 0,
      reindexed: 0,
      skippedTombstone: 0,
      byType: {},
    };
    if (!tagIndexAvailable(opts.cfg)) {
      print(
        "backlink index not available in this config (run `fbrain init` to register the internal index schema) — nothing to rebuild",
      );
      result.backlinkIndex = { targetsIndexed: 0, membersIndexed: 0 };
      return result;
    }
    if (opts.dryRun) {
      print(
        "dry-run: --backlinks would rebuild the backlink secondary index from a full corpus scan",
      );
      result.backlinkIndex = { targetsIndexed: 0, membersIndexed: 0 };
      return result;
    }
    const rebuilt = await rebuildBacklinkIndex(node, opts.cfg, {
      // SOT, not the product path — same reasoning as the tag rebuild above.
      listRecords: (type, schemaHash) =>
        listRecordsAdminScan(node, type, schemaHash),
      schemaHashFor: (type) => schemaHashFor(type, opts.cfg),
      onSkipUnavailableType: (type) =>
        print(
          missingSchemaHashReadNote(
            [type],
            "rebuilding the backlink index from the rest",
          ),
        ),
    });
    result.backlinkIndex = rebuilt;
    print(
      `rebuilt backlink index: ${rebuilt.targetsIndexed} target(s), ${rebuilt.membersIndexed} membership(s)`,
    );
    return result;
  }

  if (opts.listIndex) {
    return rebuildListIndex(opts, node, print);
  }

  if (opts.childTaskIndex) {
    return rebuildChildTaskIndex(opts, node, print);
  }

  if (opts.papercutStatusIndex) {
    return rebuildPapercutStatusIndex(opts, node, print);
  }

  if (opts.graphEdges) {
    const result: ReindexResult = {
      scanned: 0,
      reindexed: 0,
      skippedTombstone: 0,
      byType: {},
      graphEdgeRecords: 0,
    };
    const max = opts.graphMaxRecords ?? 100;
    if (!graphEdgeHashes(opts.cfg)) {
      print("graph edge schemas are unavailable (run `fbrain init`); nothing to rebuild");
      return result;
    }
    outer: for (const type of opts.type ? [opts.type] : RECORD_TYPES) {
      const records = await listRecords(node, type, opts.cfg);
      for (const record of records) {
        if (result.scanned >= max) break outer;
        result.scanned++;
        if (isTombstoned(record)) {
          result.skippedTombstone++;
          continue;
        }
        if (!opts.dryRun) {
          await reconcileGraphEdges({
            node,
            cfg: opts.cfg,
            sourceSlug: record.slug,
            body: record.body,
            preserveExistingFrontmatter: true,
          });
        }
        result.reindexed++;
      }
    }
    result.graphEdgeRecords = result.reindexed;
    const prefix = opts.dryRun ? "dry-run: would rebuild" : "rebuilt";
    print(
      `${prefix} graph edges for ${result.reindexed} record(s) (bounded max=${max}). ` +
        GRAPH_EDGE_BACKFILL_CAVEAT,
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

  for (const type of types) {
    const schemaHash = schemaHashFor(type, opts.cfg);
    const records = await listRecordsAdminScan(node, type, schemaHash, {
      includeTombstones: true,
    });
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
  return updateFieldsFrom(record, type, {
    updated_at: now,
  });
}

/**
 * Rebuild RecordListEntry partitions from admin SOT scans.
 *
 * Dry-run: census only (listed set vs SOT) — no writes.
 * Live: writeTypeListIndex per type (upsert every live row + stamp migrated),
 * then re-census so the operator sees complete=true.
 */
async function rebuildListIndex(
  opts: ReindexOptions,
  node: ReturnType<typeof newWriteClientFromCfg>["node"],
  print: (line: string) => void,
): Promise<ReindexResult> {
  const types: readonly RecordType[] = opts.type ? [opts.type] : RECORD_TYPES;
  const result: ReindexResult = {
    scanned: 0,
    reindexed: 0,
    skippedTombstone: 0,
    byType: {},
    listIndexCensus: [],
  };

  for (const type of types) {
    let schemaHash: string;
    try {
      schemaHash = schemaHashFor(type, opts.cfg);
    } catch {
      print(
        missingSchemaHashReadNote(
          [type],
          "skipping list-index rebuild for that type",
        ),
      );
      continue;
    }
    // Admin full scan is the SOT for this repair — never seed via product
    // listRecords (that would re-read the incomplete partition we're fixing).
    const sot = await listRecordsAdminScan(node, type, schemaHash);
    result.scanned += sot.length;
    result.byType[type] = { reindexed: sot.length, skippedTombstone: 0 };

    const before = await censusTypeListIndex(
      node,
      opts.cfg,
      type,
      sot.map((r) => r.slug),
    );
    if (before) {
      result.listIndexCensus!.push(before);
      const gap =
        before.missingFromIndex.length > 0 || before.extraInIndex.length > 0
          ? ` missing=${before.missingFromIndex.length} extra=${before.extraInIndex.length}`
          : " complete";
      print(
        `list-index ${type}: indexed=${before.indexed} sot=${before.sot} migrated=${before.migrated}${gap}`,
      );
      if (
        before.missingFromIndex.length > 0 &&
        before.missingFromIndex.length <= 12
      ) {
        print(`  missing: ${before.missingFromIndex.join(", ")}`);
      } else if (before.missingFromIndex.length > 12) {
        print(
          `  missing (first 12): ${before.missingFromIndex.slice(0, 12).join(", ")} …`,
        );
      }
    } else {
      print(`list-index ${type}: entry schema unavailable — cannot census`);
    }

    if (opts.dryRun) {
      result.reindexed += sot.length;
      continue;
    }

    await writeTypeListIndex(node, opts.cfg, type, sot);
    result.reindexed += sot.length;
    const after = await censusTypeListIndex(
      node,
      opts.cfg,
      type,
      sot.map((r) => r.slug),
    );
    if (after) {
      // Replace the pre-repair census with the post-repair truth for this type.
      const censuses = result.listIndexCensus!;
      const idx = censuses.findIndex((c) => c.type === type);
      if (idx >= 0) censuses[idx] = after;
      else censuses.push(after);
      print(
        `list-index ${type}: rebuilt — indexed=${after.indexed} sot=${after.sot} complete=${after.complete}`,
      );
    }
  }

  const prefix = opts.dryRun
    ? "dry-run: would rebuild list-index for"
    : "rebuilt list-index for";
  const typeScope = opts.type ? ` type=${opts.type}` : "";
  const incomplete = (result.listIndexCensus ?? []).filter(
    (c) => !c.complete,
  ).length;
  print(
    `${prefix} ${result.reindexed} live record(s)${typeScope}` +
      (opts.dryRun && incomplete > 0
        ? ` — ${incomplete} type(s) incomplete vs SOT`
        : opts.dryRun
          ? " — all censused types complete"
          : ""),
  );
  return result;
}

/**
 * Rebuild the ChildTaskIndex (design_slug x task slug) partition from an
 * admin SOT scan of the task schema.
 *
 * Dry-run: census only (indexed set vs SOT `design_slug task_slug` pairs) —
 * no writes. Live: `writeChildTaskIndex` (upsert every live child-task row +
 * drop stale rows + stamp the global completeness marker), then re-census so
 * the operator sees `complete=true`.
 */
async function rebuildChildTaskIndex(
  opts: ReindexOptions,
  node: ReturnType<typeof newWriteClientFromCfg>["node"],
  print: (line: string) => void,
): Promise<ReindexResult> {
  const result: ReindexResult = {
    scanned: 0,
    reindexed: 0,
    skippedTombstone: 0,
    byType: {},
  };

  let schemaHash: string;
  try {
    schemaHash = schemaHashFor("task", opts.cfg);
  } catch {
    print(
      missingSchemaHashReadNote(["task"], "skipping child-task-index rebuild"),
    );
    return result;
  }

  // Admin full scan is the SOT for this repair — never seed via the product
  // `listRecords`/`findChildTasksByDesign` paths, which is what we're fixing.
  const allTasks = await listRecordsAdminScan(node, "task", schemaHash, {
    includeTombstones: true,
  });
  const liveTasks = allTasks.filter((t) => {
    if (isTombstoned(t)) {
      result.skippedTombstone++;
      return false;
    }
    return true;
  });
  const sotPairs = liveTasks
    .filter((t) => (t.design_slug ?? "").length > 0)
    .map((t) => `${t.design_slug} ${t.slug}`);
  result.scanned = allTasks.length;
  result.byType.task = {
    reindexed: liveTasks.length,
    skippedTombstone: result.skippedTombstone,
  };

  const before = await censusChildTaskIndex(node, opts.cfg, sotPairs);
  if (before) {
    result.childTaskIndexCensus = before;
    const gap =
      before.missingFromIndex.length > 0 || before.extraInIndex.length > 0
        ? ` missing=${before.missingFromIndex.length} extra=${before.extraInIndex.length}`
        : " complete";
    print(
      `child-task-index: indexed=${before.indexed} sot=${before.sot} migrated=${before.migrated}${gap}`,
    );
    if (
      before.missingFromIndex.length > 0 &&
      before.missingFromIndex.length <= 12
    ) {
      print(`  missing: ${before.missingFromIndex.join(", ")}`);
    } else if (before.missingFromIndex.length > 12) {
      print(
        `  missing (first 12): ${before.missingFromIndex.slice(0, 12).join(", ")} …`,
      );
    }
  } else {
    print("child-task-index: entry schema unavailable — cannot census");
  }

  if (opts.dryRun) {
    result.reindexed = sotPairs.length;
    print(
      `dry-run: would rebuild child-task-index for ${sotPairs.length} linked task(s)` +
        (before
          ? before.complete
            ? " — already complete"
            : " — incomplete vs SOT"
          : ""),
    );
    return result;
  }

  await writeChildTaskIndex(node, opts.cfg, liveTasks);
  result.reindexed = sotPairs.length;
  const after = await censusChildTaskIndex(node, opts.cfg, sotPairs);
  if (after) {
    result.childTaskIndexCensus = after;
    print(
      `child-task-index: rebuilt — indexed=${after.indexed} sot=${after.sot} complete=${after.complete}`,
    );
  }
  print(`rebuilt child-task-index for ${sotPairs.length} linked task(s)`);
  return result;
}

/** Rebuild the PapercutStatusIndex (status x slug) from papercut SOT. */
async function rebuildPapercutStatusIndex(
  opts: ReindexOptions,
  node: ReturnType<typeof newWriteClientFromCfg>["node"],
  print: (line: string) => void,
): Promise<ReindexResult> {
  const result: ReindexResult = {
    scanned: 0,
    reindexed: 0,
    skippedTombstone: 0,
    byType: {},
  };
  let schemaHash: string;
  try {
    schemaHash = schemaHashFor("papercut", opts.cfg);
  } catch {
    print(
      missingSchemaHashReadNote(
        ["papercut"],
        "skipping papercut-status-index rebuild",
      ),
    );
    return result;
  }
  const all = await listRecordsAdminScan(node, "papercut", schemaHash, {
    includeTombstones: true,
  });
  const live = all.filter((record) => {
    if (isTombstoned(record)) {
      result.skippedTombstone++;
      return false;
    }
    return true;
  });
  result.scanned = all.length;
  result.byType.papercut = {
    reindexed: live.length,
    skippedTombstone: result.skippedTombstone,
  };

  const before = await censusPapercutStatusIndex(node, opts.cfg, live);
  if (before) {
    result.papercutStatusIndexCensus = before;
    // `stale` is counted separately from `missing`/`extra` because it is a
    // different failure: the row is in the right partition and its snapshot
    // disagrees with the record. Printing only membership is how this index
    // reported `complete` while 46.6% of its payloads were out of date.
    const gap = before.complete
      ? " complete"
      : ` missing=${before.missingFromIndex.length} extra=${before.extraInIndex.length}` +
        ` stale=${before.stalePayload.length}`;
    print(
      `papercut-status-index: indexed=${before.indexed} sot=${before.sot} migrated=${before.migrated}${gap}`,
    );
  } else {
    print(
      "papercut-status-index: entry schema unavailable — run `brain init` first",
    );
  }

  if (opts.dryRun) {
    result.reindexed = live.length;
    print(
      `dry-run: would rebuild papercut-status-index for ${live.length} papercut(s)` +
        (before
          ? before.complete
            ? " — already complete"
            : " — incomplete vs SOT"
          : ""),
    );
    return result;
  }

  await writePapercutStatusIndex(node, opts.cfg, live);
  result.reindexed = live.length;
  const after = await censusPapercutStatusIndex(node, opts.cfg, live);
  if (after) {
    result.papercutStatusIndexCensus = after;
    print(
      `papercut-status-index: rebuilt — indexed=${after.indexed} sot=${after.sot}` +
        ` stale=${after.stalePayload.length} complete=${after.complete}`,
    );
  }
  print(`rebuilt papercut-status-index for ${live.length} papercut(s)`);
  return result;
}
