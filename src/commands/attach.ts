// `fbrain attach <slug> <file>` / `fbrain attachments <slug>` /
// `fbrain detach <slug> <name-or-ref>` / `fbrain attachment get <slug>
// <name-or-ref> [-o PATH]` — file attachments on knowledge records.
//
// Storage model + search-exclusion rationale: src/attachments.ts and
// docs/attachments.md. These commands only orchestrate: resolve the target
// record (it must exist and be live), ensure the attachment schemas are
// declared, then delegate.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import {
  attachToRecord,
  detachFromRecord,
  ensureAttachmentSchemas,
  findEntry,
  getAttachmentBlob,
  readAttachmentIndex,
  type AttachmentEntry,
} from "../attachments.ts";
import { FbrainError, type Verbose } from "../client.ts";
import type { Config } from "../config.ts";
import { formatTable, resolvePrintSink } from "../format.ts";
import { normalizeSlug, resolveBySlug } from "../record.ts";
import { type RecordType } from "../schemas.ts";
import { newWriteClientFromCfg } from "../write-context.ts";

type CommonOpts = {
  cfg: Config;
  slug: string;
  type?: RecordType;
  verbose?: Verbose;
  print?: (line: string) => void;
};

export type AttachCmdResult = {
  action: "attached";
  type: RecordType;
  slug: string;
  entry: AttachmentEntry;
  deduplicated: boolean;
  replaced: boolean;
};

export async function attachCmd(
  opts: CommonOpts & {
    file: string;
    name?: string;
    force?: boolean;
    onResult?: (payload: AttachCmdResult) => void;
  },
): Promise<void> {
  const print = resolvePrintSink(opts);
  const slug = normalizeSlug(opts.slug);
  if (!existsSync(opts.file)) {
    throw new FbrainError({
      code: "attachment_file_missing",
      message: `File not found: ${opts.file}`,
      hint: "Pass a readable file path: `fbrain attach <slug> <file>`.",
    });
  }
  const bytes = new Uint8Array(readFileSync(opts.file));
  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);
  const resolved = await resolveBySlug({
    node,
    cfg: opts.cfg,
    slug,
    ...(opts.type !== undefined ? { type: opts.type } : {}),
    recoveryVerb: "attach",
  });
  await ensureAttachmentSchemas(node, opts.cfg, { persist: true });
  const result = await attachToRecord({
    node,
    cfg: opts.cfg,
    type: resolved.type,
    slug,
    name: opts.name ?? basename(opts.file),
    bytes,
    ...(opts.force !== undefined ? { force: opts.force } : {}),
    ...(opts.verbose !== undefined ? { verbose: opts.verbose } : {}),
  });
  const how = result.replaced
    ? "replaced"
    : result.blobDeduplicated
      ? "attached (content already stored — deduplicated)"
      : "attached";
  print(
    `${how} "${result.entry.name}" (${result.entry.size} bytes, ${result.entry.media_type}, ` +
      `${result.entry.blob_ref}) to ${resolved.type} ${slug}`,
  );
  opts.onResult?.({
    action: "attached",
    type: resolved.type,
    slug,
    entry: result.entry,
    deduplicated: result.blobDeduplicated,
    replaced: result.replaced,
  });
}

export type AttachmentsCmdResult = {
  action: "attachments_listed";
  type: RecordType;
  slug: string;
  attachments: AttachmentEntry[];
};

export async function attachmentsCmd(
  opts: CommonOpts & { onResult?: (payload: AttachmentsCmdResult) => void },
): Promise<void> {
  const print = resolvePrintSink(opts);
  const slug = normalizeSlug(opts.slug);
  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);
  const resolved = await resolveBySlug({
    node,
    cfg: opts.cfg,
    slug,
    ...(opts.type !== undefined ? { type: opts.type } : {}),
    recoveryVerb: "attachments",
  });
  const index = await readAttachmentIndex(node, opts.cfg, resolved.type, slug);
  const entries = index?.entries ?? [];
  if (entries.length === 0) {
    print(`no attachments on ${resolved.type} ${slug}`);
  } else {
    const lines = formatTable([
      ["NAME", "SIZE", "MEDIA_TYPE", "BLOB_REF", "ADDED_AT"],
      ...entries.map((e) => [e.name, String(e.size), e.media_type, e.blob_ref, e.added_at]),
    ]);
    for (const line of lines) print(line);
  }
  opts.onResult?.({
    action: "attachments_listed",
    type: resolved.type,
    slug,
    attachments: entries,
  });
}

export type DetachCmdResult = {
  action: "detached";
  type: RecordType;
  slug: string;
  removed: AttachmentEntry;
};

export async function detachCmd(
  opts: CommonOpts & {
    nameOrRef: string;
    onResult?: (payload: DetachCmdResult) => void;
  },
): Promise<void> {
  const print = resolvePrintSink(opts);
  const slug = normalizeSlug(opts.slug);
  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);
  const resolved = await resolveBySlug({
    node,
    cfg: opts.cfg,
    slug,
    ...(opts.type !== undefined ? { type: opts.type } : {}),
    recoveryVerb: "detach",
  });
  const result = await detachFromRecord({
    node,
    cfg: opts.cfg,
    type: resolved.type,
    slug,
    nameOrRef: opts.nameOrRef,
  });
  print(
    `detached "${result.removed.name}" (${result.removed.blob_ref}) from ${resolved.type} ${slug}` +
      ` — blob content remains in the content-addressed store`,
  );
  opts.onResult?.({
    action: "detached",
    type: resolved.type,
    slug,
    removed: result.removed,
  });
}

export type AttachmentGetCmdResult = {
  action: "attachment_written";
  type: RecordType;
  slug: string;
  entry: AttachmentEntry;
  output: string;
  bytes: number;
};

export async function attachmentGetCmd(
  opts: CommonOpts & {
    nameOrRef: string;
    output?: string;
    force?: boolean;
    onResult?: (payload: AttachmentGetCmdResult) => void;
  },
): Promise<void> {
  const print = resolvePrintSink(opts);
  const slug = normalizeSlug(opts.slug);
  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);
  const resolved = await resolveBySlug({
    node,
    cfg: opts.cfg,
    slug,
    ...(opts.type !== undefined ? { type: opts.type } : {}),
    recoveryVerb: "attachment get",
  });
  const index = await readAttachmentIndex(node, opts.cfg, resolved.type, slug);
  const entry = findEntry(index?.entries ?? [], opts.nameOrRef);
  if (entry === null) {
    throw new FbrainError({
      code: "attachment_not_found",
      message: `No attachment "${opts.nameOrRef}" on ${resolved.type} ${slug}.`,
      hint: `Run \`fbrain attachments ${slug}\` to list what is attached.`,
    });
  }
  const blob = await getAttachmentBlob(node, opts.cfg, entry.blob_ref);
  const outPath = opts.output ?? entry.name;
  if (outPath !== "-" && existsSync(outPath) && opts.force !== true) {
    throw new FbrainError({
      code: "attachment_output_exists",
      message: `Refusing to overwrite ${outPath}.`,
      hint: "Pass `-o <other-path>` or `--force` to overwrite.",
    });
  }
  if (outPath === "-") {
    process.stdout.write(blob.bytes);
  } else {
    writeFileSync(outPath, blob.bytes);
  }
  print(
    `wrote ${blob.size} bytes (${entry.blob_ref}, verified) from ${resolved.type} ${slug} ` +
      `to ${outPath === "-" ? "stdout" : outPath}`,
  );
  opts.onResult?.({
    action: "attachment_written",
    type: resolved.type,
    slug,
    entry,
    output: outPath,
    bytes: blob.size,
  });
}
