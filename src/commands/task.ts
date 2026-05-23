// `fbrain task new <slug> [--title T] [--design D] [--tag T]... [--body STR]` — create a Task.

import { newNodeClient, FbrainError, type Verbose } from "../client.ts";
import type { Config } from "../config.ts";
import { findBySlug, nowIso, schemaHashFor, validateSlug } from "../record.ts";

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
  const node = newNodeClient({
    baseUrl: opts.cfg.nodeUrl,
    userHash: opts.cfg.userHash,
    verbose: opts.verbose,
  });
  const hash = schemaHashFor("task", opts.cfg);

  if (!opts.force) {
    const existing = await findBySlug(node, "task", hash, opts.slug);
    if (existing) {
      throw new FbrainError({
        code: "slug_already_exists",
        message: `Task with slug "${opts.slug}" already exists.`,
        hint: "Use --force to overwrite, or pick a different slug.",
      });
    }
  }

  // Validate the design exists, if provided — same dangling-ref rule as link.
  if (opts.designSlug && opts.designSlug.length > 0) {
    const designHash = schemaHashFor("design", opts.cfg);
    const parent = await findBySlug(node, "design", designHash, opts.designSlug);
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
