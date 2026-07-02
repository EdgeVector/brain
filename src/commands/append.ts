// `fbrain append <slug>` — append a chunk to a record's body WITHOUT a full
// rewrite. Closes the third leg of the read/write asymmetry: `fbrain_get`
// windows a large body, `fbrain_put` is a full replace defaulting to empty, so
// the only way to add to a big record was a get→edit→re-put that (a) truncates
// past the get-window and (b) times out on a ~218KB tracker. `append` does a
// bounded read-modify-write: resolve the live record, concatenate the chunk to
// its existing body (with a single separating newline unless suppressed), and
// re-put via `updateRecord` preserving every other field. It can only GROW the
// body, so it can never trip the put-side shrink guard — appending is the safe
// primitive the shrink guard steers agents toward.

import { FbrainError, type Verbose } from "../client.ts";
import { newWriteClientFromCfg } from "../write-context.ts";
import type { Config } from "../config.ts";
import { resolvePrintSink } from "../format.ts";
import {
  normalizeSlug,
  nowIso,
  resolveBySlug,
  schemaHashFor,
} from "../record.ts";
import { RECORDS, type RecordType } from "../schemas.ts";

export type AppendOptions = {
  cfg: Config;
  slug: string;
  // The text to append to the record's body.
  chunk: string;
  type?: RecordType;
  verbose?: Verbose;
  // When true, join the existing body and the new chunk with NO separator
  // (byte-exact concatenation). Default false: a single "\n\n" separates them
  // when the existing body is non-empty and doesn't already end in a blank
  // line, so appended markdown blocks stay readable. Never adds a separator to
  // an empty body (the append then simply seeds the body).
  raw?: boolean;
  print?: (line: string) => void;
  // Structured-output sink, mirroring the other write commands' `onResult`:
  // fires once on success with the SAME resolved `type`/`slug` and the
  // before/after body lengths the printed line reports, so the MCP
  // `fbrain_append` tool's `structuredContent` can't drift from the text.
  onResult?: (payload: AppendResult) => void;
};

// The structured payload the MCP `fbrain_append` tool returns in
// `structuredContent`. `bytesAppended` is the length of the chunk (plus any
// auto-inserted separator); `newBodyChars`/`oldBodyChars` bracket the growth
// so an agent can confirm nothing was truncated.
export type AppendResult = {
  action: "appended";
  type: RecordType;
  slug: string;
  oldBodyChars: number;
  newBodyChars: number;
  bytesAppended: number;
};

// Compute the body after appending `chunk` to `oldBody`. Pure so it's unit
// testable without a node. Applies the separator policy: raw = byte-exact
// concat; otherwise insert "\n\n" between a non-empty body and the chunk
// unless the body already ends with a blank line (avoid stacking blank lines).
export function appendBody(oldBody: string, chunk: string, raw: boolean): string {
  if (raw || oldBody.length === 0) return oldBody + chunk;
  const sep = /\n\n$/.test(oldBody) ? "" : oldBody.endsWith("\n") ? "\n" : "\n\n";
  return oldBody + sep + chunk;
}

export async function appendCmd(opts: AppendOptions): Promise<void> {
  const print = resolvePrintSink(opts);
  const slug = normalizeSlug(opts.slug);
  if (opts.chunk.length === 0) {
    throw new FbrainError({
      code: "empty_append",
      message: "append: the chunk is empty — nothing to append.",
      hint: "Pass a non-empty body chunk (positional/stdin for the CLI, `chunk`/`chunk_path`/`chunk_b64` for the MCP tool).",
    });
  }

  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);
  const only = await resolveBySlug({
    node,
    cfg: opts.cfg,
    slug,
    type: opts.type,
    recoveryVerb: "get",
  });

  const oldBody = only.record.body;
  const newBody = appendBody(oldBody, opts.chunk, opts.raw === true);

  const hash = schemaHashFor(only.type, opts.cfg);
  const now = nowIso();
  const def = RECORDS[only.type];
  const fields: Record<string, unknown> = {
    ...only.record,
    body: newBody,
    updated_at: now,
  };
  if (!def.hasDesignSlug) delete fields.design_slug;
  await node.updateRecord({
    schemaHash: hash,
    keyHash: slug,
    fields,
  });

  const bytesAppended = newBody.length - oldBody.length;
  print(
    `appended ${bytesAppended} chars to ${only.type} ${slug} (${oldBody.length} → ${newBody.length})`,
  );
  opts.onResult?.({
    action: "appended",
    type: only.type,
    slug,
    oldBodyChars: oldBody.length,
    newBodyChars: newBody.length,
    bytesAppended,
  });
}
