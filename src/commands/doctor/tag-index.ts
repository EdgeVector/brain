// `brain doctor` probe — the tag and backlink membership layout.
//
// Two states, two fixes (docs/tag-membership.md):
//
// 1. REGISTRATION. Tag and backlink membership live in the TagMembership schema.
//    A config with no hash for it reads the legacy TagIndex layout and skips
//    every membership write (it never registers the schema: only `brain init`
//    does). Reads still answer, from legacy rows that no longer move, so the
//    index goes stale silently. That is a FAIL here.
//
// 2. DRIFT. After a tag's legacy members are copied, an OLD binary (the CLI,
//    brain-mcp, a routine, a second device) still writes the legacy row only,
//    and the new code never reads it again. A legacy row whose `updated_at` is
//    newer than the tag's copy stamp means members are missing from the new
//    layout. There is no scan, so this probe cannot certify every tag: it seeds
//    from a small bounded slice of the keyed type-list index, reads the stamp
//    and the legacy row's age for the tags of those records and the link targets
//    in them, and says how many it checked.

import type { NodeClient, Verbose } from "../../client.ts";
import type { Config } from "../../config.ts";
import { backlinkIndexTag } from "../../backlink-index.ts";
import { snapshotSummary, type SnapshotSummary } from "../../index-payload.ts";
import { readTypeListIndex } from "../../record-list-index.ts";
import { RECORD_TYPES, type RecordType } from "../../schemas.ts";
import {
  readTagMigrationStates,
  tagCopyStatus,
  tagIndexAvailable,
  tagMemberSchemaHash,
} from "../../tag-index.ts";
import {
  normalizeSlug,
  parseGenericLinkTag,
  TOMBSTONE_TAG,
} from "../../record.ts";
import type { CheckResult } from "../doctor.ts";

export const TAG_INDEX_CHECK = "tag-index";

/** Records the drift sample reads tags from, and tags it checks. Small: doctor stays cheap. */
export const DOCTOR_TAG_SAMPLE_RECORDS = 25;
export const DOCTOR_TAG_SAMPLE_TAGS = 40;

const REPAIR =
  "replace every old brain binary (CLI, brain-mcp, routines, other devices), then run " +
  "`brain reindex --tags` and `brain reindex --backlinks` at a quiet moment (admin operation, one device at a time)";

export async function runTagIndexProbe(
  node: NodeClient,
  cfg: Config,
  verbose?: Verbose,
  opts: { tags?: readonly string[] } = {},
): Promise<CheckResult> {
  const name = TAG_INDEX_CHECK;
  if (!tagIndexAvailable(cfg)) {
    return {
      name,
      ok: true,
      tag: "SKIP",
      detail: "no tag index schema in this config; run `brain init` first",
    };
  }
  if (tagMemberSchemaHash(cfg) === null) {
    return {
      name,
      ok: false,
      tag: "FAIL",
      detail:
        "the TagMembership schema is not registered in this config: tag and backlink membership is NOT " +
        "written, and reads use the legacy layout, which no longer moves (`list --tag` and `linked_from` go stale)",
      fix: "run `brain init` (the only command that registers the schema), then `brain reindex --tags` and `brain reindex --backlinks`",
    };
  }

  let tags: string[];
  try {
    tags = opts.tags ? [...opts.tags] : await sampleTags(node, cfg);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    verbose?.(`${name}: could not read the type-list index — ${detail}`);
    return {
      name,
      ok: true,
      tag: "SKIP",
      detail: `registered; the drift sample could not read the type-list index: ${detail}`,
    };
  }
  if (tags.length === 0) {
    return {
      name,
      ok: true,
      detail: "registered; no tags in the sampled records, so no drift to check",
    };
  }

  let states;
  try {
    states = await readTagMigrationStates(node, cfg, tags);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    verbose?.(`${name}: could not read the copy stamps — ${detail}`);
    return {
      name,
      ok: false,
      tag: "WARN",
      detail: `registered; could not read the copy stamps: ${detail}`,
      fix: "retry `brain doctor`",
    };
  }
  const drifted = states.filter((s) => tagCopyStatus(s) === "drifted").map((s) => s.tag);
  const pending = states.filter((s) => tagCopyStatus(s) === "pending").length;
  const emptyLegacy = states.filter((s) => tagCopyStatus(s) === "empty").length;
  if (drifted.length > 0) {
    const shown = drifted.slice(0, 3).join(", ");
    return {
      name,
      ok: false,
      tag: "WARN",
      detail:
        `${drifted.length} of ${states.length} sampled tag(s) have a legacy row newer than their copy ` +
        `stamp (for example ${shown}): an old binary or an unsynced device wrote the legacy layout, ` +
        "so their members are missing from the new layout. This is a sample, not a census",
      fix: REPAIR,
    };
  }
  return {
    name,
    ok: true,
    detail:
      `registered; ${states.length} sampled tag(s) checked, none newer in the legacy layout` +
      (emptyLegacy > 0
        ? ` (${emptyLegacy} migrated-empty: a legacy row with no members, recorded once)`
        : "") +
      (pending > 0
        ? ` (${pending} not copied yet: the next read or write of each copies it, or its members have not synced)`
        : "") +
      ". This is a sample, not a census",
  };
}

/** Distinct tags and link-target tags of a bounded slice of the type-list index. */
async function sampleTags(node: NodeClient, cfg: Config): Promise<string[]> {
  const types: RecordType[] = RECORD_TYPES.filter(
    (t) => (cfg.schemaHashes as Record<string, string | undefined>)[t] !== undefined,
  );
  const perType: Array<Array<{ type: RecordType; record: SnapshotSummary }>> = [];
  for (const type of types) {
    let records;
    try {
      records = await readTypeListIndex(node, cfg, type);
    } catch {
      continue;
    }
    if (records === null) continue;
    perType.push(records.map((snapshot) => ({ type, record: snapshotSummary(snapshot) })));
  }
  const tags: string[] = [];
  const seen = new Set<string>();
  const add = (tag: string): void => {
    if (tag.length === 0 || tag === TOMBSTONE_TAG || seen.has(tag)) return;
    if (tags.length >= DOCTOR_TAG_SAMPLE_TAGS) return;
    seen.add(tag);
    tags.push(tag);
  };
  let taken = 0;
  // Round-robin across types: a sample of one type would hide drift in another.
  for (let i = 0; taken < DOCTOR_TAG_SAMPLE_RECORDS; i += 1) {
    let progressed = false;
    for (const rows of perType) {
      const row = rows[i];
      if (row === undefined) continue;
      progressed = true;
      taken += 1;
      for (const tag of row.record.tags) add(tag);
      // Link targets from the keys a summary keeps (design_slug, generic link
      // tags). Wiki links live in the body, which a sample does not read.
      for (const target of summaryLinkTargets(row.record, row.type)) {
        add(backlinkIndexTag(target));
      }
      if (taken >= DOCTOR_TAG_SAMPLE_RECORDS) break;
    }
    if (!progressed) break;
  }
  return tags;
}

/** Link targets a summary names without its body: a task's design, and generic link tags. */
function summaryLinkTargets(record: SnapshotSummary, type: RecordType): string[] {
  const targets = new Set<string>();
  if (type === "task" && typeof record.design_slug === "string" && record.design_slug.length > 0) {
    const design = normalizeSlug(record.design_slug);
    if (design.length > 0) targets.add(design);
  }
  for (const tag of record.tags) {
    const parsed = parseGenericLinkTag(tag);
    if (!parsed) continue;
    const slug = normalizeSlug(parsed.to_slug);
    if (slug.length > 0) targets.add(slug);
  }
  return [...targets];
}
