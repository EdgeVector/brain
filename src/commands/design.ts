// `fbrain design new <slug> [--title T] [--tag T]... [--body STR]` — create a Design.

import { FbrainError, type Verbose } from "../client.ts";
import { newWriteNodeClient } from "../write-context.ts";
import type { Config } from "../config.ts";
import {
  findBySlug,
  nowIso,
  schemaHashFor,
  validateSlug,
  withReadRetry,
} from "../record.ts";

export type DesignNewOptions = {
  cfg: Config;
  slug: string;
  title: string;
  body: string;
  tags: string[];
  force?: boolean;
  verbose?: Verbose;
};

export async function designNew(opts: DesignNewOptions): Promise<void> {
  validateSlug(opts.slug);
  const { node } = newWriteNodeClient({
    baseUrl: opts.cfg.nodeUrl,
    userHash: opts.cfg.userHash,
    ...(opts.verbose ? { verbose: opts.verbose } : {}),
  });
  const hash = schemaHashFor("design", opts.cfg);

  if (!opts.force) {
    // /api/query returns a non-deterministic top-100 slice per schema, so
    // a single findBySlug can miss an existing slug on a schema with >100
    // rows. Without the retry the duplicate guard fails open ~40% of the
    // time and the createRecord below silently overwrites the row. Same
    // hedge put.ts and resolveBySlug use. See PR #53.
    const existing = await withReadRetry(
      () => findBySlug(node, "design", hash, opts.slug),
      (r) => r !== null,
    );
    if (existing) {
      throw new FbrainError({
        code: "slug_already_exists",
        message: `Design with slug "${opts.slug}" already exists.`,
        hint: "Use --force to overwrite (re-creates with the values you passed), or pick a different slug.",
      });
    }
  }

  // --force intentionally skips the lookup and stamps a fresh created_at.
  // It's a deliberate "re-create from scratch" — callers wanting upsert
  // semantics (preserve created_at) should use `fbrain put` instead.
  const now = nowIso();
  const fields = {
    slug: opts.slug,
    title: opts.title,
    body: opts.body,
    status: "draft",
    tags: opts.tags,
    created_at: now,
    updated_at: now,
  };
  await node.createRecord({ schemaHash: hash, fields, keyHash: opts.slug });
}
