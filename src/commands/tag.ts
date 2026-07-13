// `fbrain tag <slug> --add T[,T] --rm T[,T]` — mutate only a record's tags.
//
// This is the tag-side sibling of `status`: resolve the live record, apply a
// set add/remove to `tags`, and write back through updateRecord while
// preserving body/title/status/created_at byte-for-byte. Re-adding an existing
// tag or removing an absent one is a no-op success.

import { FbrainError, type Verbose } from "../client.ts";
import { newWriteClientFromCfg } from "../write-context.ts";
import type { Config } from "../config.ts";
import { resolvePrintSink } from "../format.ts";
import {
  normalizeSlug,
  nowIso,
  resolveBySlug,
  schemaHashFor,
  updateFieldsFrom,
} from "../record.ts";
import { type RecordType } from "../schemas.ts";

export type TagOptions = {
  cfg: Config;
  slug: string;
  add?: readonly string[];
  rm?: readonly string[];
  type?: RecordType;
  verbose?: Verbose;
  print?: (line: string) => void;
  onResult?: (payload: TagResult) => void;
};

export type TagResult = {
  action: "tags_changed";
  type: RecordType;
  slug: string;
  added: string[];
  removed: string[];
  tags: string[];
};

export function parseTagList(values: readonly string[] | undefined): string[] {
  if (values === undefined) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    for (const piece of raw.split(",")) {
      const tag = piece.trim();
      if (tag.length === 0) continue;
      if (seen.has(tag)) continue;
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

export function applyTagMutation(
  existing: readonly string[],
  add: readonly string[],
  rm: readonly string[],
): { tags: string[]; added: string[]; removed: string[] } {
  const removeSet = new Set(rm);
  const addSet = new Set(add);
  const tags = existing.filter((tag) => !removeSet.has(tag));
  const beforeAdd = new Set(tags);
  for (const tag of add) {
    if (!beforeAdd.has(tag)) {
      tags.push(tag);
      beforeAdd.add(tag);
    }
  }

  const oldSet = new Set(existing);
  const newSet = new Set(tags);
  const added = add.filter((tag) => !oldSet.has(tag) && newSet.has(tag));
  const removed = rm.filter((tag) => oldSet.has(tag) && !newSet.has(tag) && !addSet.has(tag));
  return { tags, added, removed };
}

export async function tagCmd(opts: TagOptions): Promise<void> {
  const print = resolvePrintSink(opts);
  const slug = normalizeSlug(opts.slug);
  const add = parseTagList(opts.add);
  const rm = parseTagList(opts.rm);
  if (add.length === 0 && rm.length === 0) {
    throw new FbrainError({
      code: "missing_tag_mutation",
      message: "tag: pass at least one non-empty --add or --rm value.",
      hint: "Example: `fbrain tag my-record --add owner:fbrain` or `fbrain tag my-record --rm stale`.",
    });
  }

  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);
  const only = await resolveBySlug({
    node,
    cfg: opts.cfg,
    slug,
    type: opts.type,
    recoveryVerb: "tag",
  });

  const result = applyTagMutation(only.record.tags, add, rm);
  if (result.added.length > 0 || result.removed.length > 0) {
    const hash = schemaHashFor(only.type, opts.cfg);
    const fields = updateFieldsFrom(only.record, only.type, {
      tags: result.tags,
      updated_at: nowIso(),
    });
    await node.updateRecord({
      schemaHash: hash,
      keyHash: slug,
      fields,
    });
  }

  const parts = [
    ...result.added.map((tag) => `+${tag}`),
    ...result.removed.map((tag) => `-${tag}`),
  ];
  print(
    parts.length === 0
      ? `tags unchanged for ${only.type} ${slug}`
      : `tags changed for ${only.type} ${slug}: ${parts.join(" ")}`,
  );
  opts.onResult?.({
    action: "tags_changed",
    type: only.type,
    slug,
    added: result.added,
    removed: result.removed,
    tags: result.tags,
  });
}
