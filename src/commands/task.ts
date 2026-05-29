// `fbrain task new <slug> [--title T] [--design D] [--tag T]... [--body STR]` — create a Task.

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

export type TaskNewOptions = {
  cfg: Config;
  slug: string;
  title: string;
  body: string;
  tags: string[];
  designSlug?: string;
  force?: boolean;
  verbose?: Verbose;
};

export async function taskNew(opts: TaskNewOptions): Promise<void> {
  validateSlug(opts.slug);
  const { node } = newWriteNodeClient({
    baseUrl: opts.cfg.nodeUrl,
    userHash: opts.cfg.userHash,
    ...(opts.verbose ? { verbose: opts.verbose } : {}),
  });
  const hash = schemaHashFor("task", opts.cfg);

  if (!opts.force) {
    // /api/query returns a non-deterministic top-100 slice per schema, so
    // a single findBySlug can miss an existing slug on a schema with >100
    // rows. Without the retry the duplicate guard fails open ~40% of the
    // time and the createRecord below silently overwrites the row. Same
    // hedge put.ts and resolveBySlug use. See PR #53.
    const existing = await withReadRetry(
      () => findBySlug(node, "task", hash, opts.slug),
      (r) => r !== null,
    );
    if (existing) {
      throw new FbrainError({
        code: "slug_already_exists",
        message: `Task with slug "${opts.slug}" already exists.`,
        hint: "Use --force to overwrite, or pick a different slug.",
      });
    }
  }

  // Validate the design exists, if provided — same dangling-ref rule as link.
  // Retry-hedged for the same /api/query truncation reason as above:
  // without it, a valid parent on a >100-row design schema flakes to
  // dangling_design_slug ~40% of the time.
  if (opts.designSlug && opts.designSlug.length > 0) {
    const designHash = schemaHashFor("design", opts.cfg);
    const parent = await withReadRetry(
      () => findBySlug(node, "design", designHash, opts.designSlug!),
      (r) => r !== null,
    );
    if (!parent) {
      throw new FbrainError({
        code: "dangling_design_slug",
        message: `Cannot link task "${opts.slug}" to design "${opts.designSlug}" — that design does not exist.`,
        hint: "Create the design first (`fbrain design new ...`), or omit --design.",
      });
    }
  }

  const now = nowIso();
  const fields = {
    slug: opts.slug,
    title: opts.title,
    body: opts.body,
    status: "open",
    design_slug: opts.designSlug ?? "",
    tags: opts.tags,
    created_at: now,
    updated_at: now,
  };
  await node.createRecord({ schemaHash: hash, fields, keyHash: opts.slug });
}
