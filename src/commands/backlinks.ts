// `fbrain backlinks <slug>` — list records that explicitly link to a slug or
// mention it with a body wiki-link (`[[slug]]`). Unlike explicit `link`
// writes, this read does not require the target slug to exist; dangling wiki
// references are intentional notes-to-self in fbrain bodies.

import { newReadClientFromCfg, type Verbose } from "../client.ts";
import { findBacklinks } from "../backlink-index.ts";
import type { Config } from "../config.ts";
import { resolvePrintSink } from "../format.ts";
import {
  normalizeSlug,
  type Backlink,
} from "../record.ts";
import type { RecordType } from "../schemas.ts";

export type BacklinksJson = {
  slug: string;
  type?: RecordType;
  linked_from: Array<{
    type: RecordType;
    slug: string;
    status: string;
    via: Array<"explicit" | "body">;
  }>;
};

export type BacklinksOptions = {
  cfg: Config;
  slug: string;
  type?: RecordType;
  json?: boolean;
  verbose?: Verbose;
  print?: (line: string) => void;
  onResult?: (payload: BacklinksJson) => void;
};

export async function backlinksCmd(opts: BacklinksOptions): Promise<void> {
  const print = resolvePrintSink(opts);
  const slug = normalizeSlug(opts.slug);
  const node = newReadClientFromCfg(opts.cfg, opts.verbose);
  const links = await findBacklinks(node, opts.cfg, slug, {
    targetType: opts.type,
    verbose: opts.verbose,
  });
  const json = backlinksToJson(slug, opts.type, links);
  opts.onResult?.(json);
  if (opts.json) {
    print(JSON.stringify(json));
    return;
  }
  print(formatBacklinks(json));
}

export function backlinksToJson(
  slug: string,
  type: RecordType | undefined,
  links: ReadonlyArray<Backlink>,
): BacklinksJson {
  const out: BacklinksJson = {
    slug,
    linked_from: links.map((link) => ({
      type: link.type,
      slug: link.slug,
      status: link.status,
      via: link.via,
    })),
  };
  if (type !== undefined) out.type = type;
  return out;
}

export function formatBacklinks(json: BacklinksJson): string {
  const target = json.type === undefined ? json.slug : `${json.type} ${json.slug}`;
  if (json.linked_from.length === 0) return `backlinks for ${target}: (none)`;
  const lines = [`backlinks for ${target}:`];
  for (const link of json.linked_from) {
    lines.push(`- ${link.type} ${link.slug} (${link.status}; ${link.via.join(", ")})`);
  }
  return lines.join("\n");
}
