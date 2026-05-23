// `fbrain design new <slug> [--title T] [--tag T]... [--body STR]` — create a Design.

import { newNodeClient, FbrainError, type Verbose } from "../client.ts";
import type { Config } from "../config.ts";
import {
  findBySlug,
  nowIso,
  schemaHashFor,
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
  const node = newNodeClient({
    baseUrl: opts.cfg.nodeUrl,
    userHash: opts.cfg.userHash,
    verbose: opts.verbose,
  });
  const hash = schemaHashFor("design", opts.cfg);

  if (!opts.force) {
    const existing = await findBySlug(node, "design", hash, opts.slug);
    if (existing) {
      throw new FbrainError({
        code: "slug_already_exists",
        message: `Design with slug "${opts.slug}" already exists.`,
        hint: "Use --force to overwrite (re-creates with the values you passed), or pick a different slug.",
      });
    }
  }

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

function validateSlug(slug: string): void {
  if (slug.length === 0) {
    throw new FbrainError({
      code: "invalid_slug",
      message: "Slug must be non-empty.",
    });
  }
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(slug)) {
    throw new FbrainError({
      code: "invalid_slug",
      message: `Slug "${slug}" is invalid.`,
      hint: "Slugs are lowercase, start with a letter or digit, and use [a-z0-9-_].",
    });
  }
}
