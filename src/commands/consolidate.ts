// `fbrain consolidate [--type T] [--dry-run] [--verbose]` — one-time
// data migration: copy every live legacy FbrainKindNote row into its
// per-kind canonical schema, then tombstone the legacy row.
//
// Phase E (PR #62) shipped per-kind schemas for Concept / Preference /
// Reference / Agent / Project / Spike. New records of those kinds land
// directly in the per-kind canonical, but pre-Phase-E records still
// live in the shared FbrainKindNote schema and surface to readers only
// via the transitional legacy fallback (`listLegacyKindRecords`,
// `findBySlugLegacy`).
//
// After this command runs against a daemon:
//   - every live legacy row has a per-kind twin and the legacy row is
//     tombstoned (so the legacy fallback returns nothing of substance);
//   - `fbrain list --type <kind>` and `fbrain get` surface every record
//     of that kind from the per-kind path alone;
//   - `fbrain reindex` / `fbrain migrate` (per-kind only) cover the full
//     record set, no legacy-aware variant needed.
//
// Slug conflicts (a legacy row whose slug already has a live per-kind
// row, e.g. because the user re-wrote the slug post-Phase-E) are skipped
// with a warning — the legacy row is left untouched and the per-kind
// row wins on reads (per-kind has precedence in the dedupe in
// `listRecordsWithLegacy` / `resolveBySlug`).
//
// Idempotent: re-running this command after a successful consolidation
// is a no-op — the only legacy rows left are already tombstoned, which
// we skip.

import { newNodeClient, FbrainError, type Verbose } from "../client.ts";
import type { Config } from "../config.ts";
import {
  findBySlug,
  isTombstoned,
  legacyRowToRecord,
  legacySchemaHashFor,
  listRecords,
  nowIso,
  schemaHashFor,
  withReadRetry,
  type FbrainRecord,
} from "../record.ts";
import {
  LEGACY_NOTE_QUERY_FIELDS,
  RECORDS,
  RECORD_TYPES,
  type RecordType,
} from "../schemas.ts";
import { buildTombstoneFields } from "./delete.ts";

export type ConsolidateOptions = {
  cfg: Config;
  // Narrow to a single Phase 6 type. Design/Task are silently skipped if
  // passed because they have no legacy backing. Omit to consolidate every
  // Phase 6 type that has a `legacyKind`.
  type?: RecordType;
  // Counts what would be migrated/skipped without writing anything.
  dryRun?: boolean;
  verbose?: Verbose;
  print?: (line: string) => void;
};

type PerTypeCounts = {
  // Legacy rows of this kind seen on the wire.
  scanned: number;
  // Live mode: rows that landed in per-kind + had their legacy row
  // tombstoned. Dry-run: rows that *would* be migrated.
  migrated: number;
  // Live per-kind row already at this slug — legacy row left untouched.
  skippedConflict: number;
  // Legacy row was already tombstoned (a prior run already migrated it,
  // or the user soft-deleted it before consolidation).
  skippedTombstone: number;
};

export type ConsolidateResult = {
  scanned: number;
  migrated: number;
  skippedConflict: number;
  skippedTombstone: number;
  byType: Partial<Record<RecordType, PerTypeCounts>>;
};

export async function consolidateCmd(
  opts: ConsolidateOptions,
): Promise<ConsolidateResult> {
  const print = opts.print ?? ((line: string) => console.log(line));
  const node = newNodeClient({
    baseUrl: opts.cfg.nodeUrl,
    userHash: opts.cfg.userHash,
    verbose: opts.verbose,
  });

  // Phase 6 kinds only — design/task have no legacy backing.
  const requested: readonly RecordType[] = opts.type ? [opts.type] : RECORD_TYPES;
  const types = requested.filter((t) => RECORDS[t].legacyKind !== null);

  const result: ConsolidateResult = {
    scanned: 0,
    migrated: 0,
    skippedConflict: 0,
    skippedTombstone: 0,
    byType: {},
  };

  if (types.length === 0) {
    // User passed --type design/task. Nothing to do.
    print(
      `consolidate: type "${opts.type}" has no legacy backing — nothing to consolidate.`,
    );
    return result;
  }

  // Legacy hash is shared across all Phase 6 kinds. Pick the first to
  // resolve it. `null` means the config doesn't carry the legacy hash —
  // typical for fresh post-Phase-E installs that never wrote a legacy row.
  const legacyHash = legacySchemaHashFor(types[0]!, opts.cfg);
  if (legacyHash === null) {
    print(
      "consolidate: no legacy FbrainKindNote hash registered in config — nothing to consolidate.",
    );
    print("hint:  re-run `fbrain init` to pick up the legacy hash, then retry.");
    return result;
  }

  // Pull the entire legacy table once and group by `kind`. Six per-type
  // queries against the same legacy schema would return the same rows
  // each time, so we save five round-trips here.
  const legacyRows = await node.queryAll({
    schemaHash: legacyHash,
    fields: [...LEGACY_NOTE_QUERY_FIELDS],
  });
  const byKind = new Map<string, ReturnType<typeof legacyRowToRecord>[]>();
  for (const row of legacyRows.results) {
    const rec = legacyRowToRecord(row);
    const bucket = byKind.get(rec.kind);
    if (bucket) bucket.push(rec);
    else byKind.set(rec.kind, [rec]);
  }

  for (const type of types) {
    const counts: PerTypeCounts = {
      scanned: 0,
      migrated: 0,
      skippedConflict: 0,
      skippedTombstone: 0,
    };
    result.byType[type] = counts;

    const wantKind = RECORDS[type].legacyKind!;
    const perKindHash = schemaHashFor(type, opts.cfg);
    const rows = byKind.get(wantKind) ?? [];

    // Pre-fetch the per-kind slugs already present (live, non-tombstoned).
    // Cheaper than a per-row findBySlug, which lists every row each time.
    const perKindAll = await listRecords(node, type, perKindHash);
    const perKindSlugs = new Set(
      perKindAll.filter((r) => !isTombstoned(r)).map((r) => r.slug),
    );

    for (const legacy of rows) {
      result.scanned++;
      counts.scanned++;

      if (isTombstoned(legacy)) {
        // Already migrated (or user soft-deleted pre-consolidation).
        result.skippedTombstone++;
        counts.skippedTombstone++;
        opts.verbose?.(`skipped-tombstone ${type}/${legacy.slug}`);
        continue;
      }

      if (perKindSlugs.has(legacy.slug)) {
        // The user either consolidated this slug by hand or wrote a new
        // per-kind record at the same slug post-Phase-E. Either way we
        // don't overwrite — log and skip.
        result.skippedConflict++;
        counts.skippedConflict++;
        print(
          `consolidate: warning — per-kind ${type} "${legacy.slug}" already exists; ` +
            `skipping legacy row (slug conflict).`,
        );
        opts.verbose?.(`skipped-conflict ${type}/${legacy.slug}`);
        continue;
      }

      if (opts.dryRun) {
        result.migrated++;
        counts.migrated++;
        opts.verbose?.(`would-migrate ${type}/${legacy.slug}`);
        continue;
      }

      const now = nowIso();
      const perKindFields = buildPerKindFields(type, legacy, now);
      await node.createRecord({
        schemaHash: perKindHash,
        fields: perKindFields,
        keyHash: legacy.slug,
      });

      // Verify the per-kind write surfaces on read-back before we tombstone
      // the legacy row — if /api/query is flake-hiding the row we'd rather
      // leave the legacy row intact than orphan the data.
      const verify = await withReadRetry(
        () => findBySlug(node, type, perKindHash, legacy.slug),
        (r) => r !== null,
      );
      if (verify === null) {
        throw new FbrainError({
          code: "consolidate_verify_failed",
          message:
            `Per-kind write for ${type}/${legacy.slug} did not surface on read-back — ` +
            `legacy row left intact.`,
          hint:
            "Re-run with --verbose; the create mutation reported success but the row isn't visible. " +
            "Re-running `fbrain consolidate` is safe — already-tombstoned legacy rows are skipped.",
        });
      }

      const tombstoneFields = buildTombstoneFields(
        type,
        legacy.slug,
        legacy.created_at,
        now,
        true,
      );
      await node.updateRecord({
        schemaHash: legacyHash,
        fields: tombstoneFields,
        keyHash: legacy.slug,
      });
      // Track in our per-kind set so a duplicate slug under a different
      // legacy kind row in the same run would now hit the conflict path.
      perKindSlugs.add(legacy.slug);

      result.migrated++;
      counts.migrated++;
      opts.verbose?.(`migrated ${type}/${legacy.slug}`);
    }
  }

  const prefix = opts.dryRun ? "dry-run: would migrate" : "migrated";
  const typeScope = opts.type ? ` (type=${opts.type})` : "";
  print(
    `${prefix} ${result.migrated} record(s)${typeScope}, ` +
      `skipped ${result.skippedConflict} slug-conflict, ${result.skippedTombstone} tombstone(s)`,
  );

  return result;
}

// Per-kind record shape, stripped of the legacy `kind` discriminator and
// the `v1_marker_*` structural-distinctness fields. created_at is preserved
// from the legacy row; updated_at is stamped now so the per-kind write is
// distinguishable in audit/log.
function buildPerKindFields(
  type: RecordType,
  legacy: FbrainRecord,
  now: string,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    slug: legacy.slug,
    title: legacy.title,
    body: legacy.body,
    status: legacy.status,
    tags: legacy.tags,
    created_at: legacy.created_at,
    updated_at: now,
  };
  if (RECORDS[type].hasDesignSlug) {
    fields.design_slug = legacy.design_slug ?? "";
  }
  return fields;
}

