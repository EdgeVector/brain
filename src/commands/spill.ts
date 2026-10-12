// `brain spill <slug> [--type T]` — spill one record's long text to a body file
// by hand. A legacy record that is already above the atom limit stays readable
// and spills the next time anything writes it. This verb lets an owner spill a
// KNOWN record now, without waiting for a write. It point-reads one record: no
// schema scan.
//
// What it does: read the record (the read funnel returns the FULL text), seal
// it through the write plan (blob, sidecar, then the record and every index
// snapshot that copies it), then read it back and prove the text is unchanged.
// A record with nothing to spill (no field above 32 KiB) or one that already
// keeps its text in a body file is reported and left alone.

import { createHash } from "node:crypto";

import type { Verbose } from "../client.ts";
import type { Config } from "../config.ts";
import { fieldsToSpill, serializedBytes, spillFieldsFor, storedFieldsOf } from "../body-spill.ts";
import { resolvePrintSink } from "../format.ts";
import {
  findBySlug,
  normalizeSlug,
  nowIso,
  resolveBySlug,
  schemaHashFor,
  updateFieldsFrom,
  withReadRetry,
} from "../record.ts";
import {
  buildResidentWritePlan,
  commitResidentWritePlan,
  recordFromPrimaryFields,
} from "../resident-write-plan.ts";
import type { RecordType } from "../schemas.ts";
import { newWriteClientFromCfg } from "../write-context.ts";
import { FbrainError } from "../client.ts";

export type SpillOptions = {
  cfg: Config;
  slug: string;
  type?: RecordType;
  verbose?: Verbose;
  json?: boolean;
  print?: (line: string) => void;
  onResult?: (payload: SpillResult) => void;
};

export type SpillFieldReport = {
  field: string;
  /** Serialized size of the field as the node stored it before this command. */
  stored_bytes_before: number;
  /** Serialized size of the field as the node stores it now. */
  stored_bytes_after: number;
  /** Full text size in UTF-8 bytes. */
  text_bytes: number;
};

export type SpillResult = {
  action: "spilled" | "already_spilled" | "nothing_to_spill";
  type: RecordType;
  slug: string;
  fields: SpillFieldReport[];
};

function sha256Of(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function spillCmd(opts: SpillOptions): Promise<SpillResult> {
  const print = resolvePrintSink(opts);
  const slug = normalizeSlug(opts.slug);
  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);
  const only = await resolveBySlug({
    node,
    cfg: opts.cfg,
    slug,
    ...(opts.type !== undefined ? { type: opts.type } : {}),
    recoveryVerb: "get",
  });
  const { type, record } = only;
  const stored = storedFieldsOf(record);
  const names = spillFieldsFor(type);
  const report = (after: Record<string, unknown>): SpillFieldReport[] =>
    names
      .filter((f) => typeof record[f] === "string" && (record[f] as string).length > 0)
      .map((f) => ({
        field: f,
        stored_bytes_before: serializedBytes(stored[f]),
        stored_bytes_after: serializedBytes(after[f]),
        text_bytes: Buffer.byteLength(record[f] as string, "utf8"),
      }));
  const finish = (result: SpillResult): SpillResult => {
    const lines = result.fields.map(
      (f) =>
        `  ${f.field}: text ${f.text_bytes} bytes, stored ${f.stored_bytes_before} -> ${f.stored_bytes_after} bytes`,
    );
    if (opts.json) print(JSON.stringify(result));
    else print([`${result.action} ${type} ${slug}`, ...lines].join("\n"));
    opts.onResult?.(result);
    return result;
  };

  const fields = updateFieldsFrom(record, type, {});
  // A hydrated field holds the full text while the node stores the marker form.
  // Only a field that is stored as raw text AND is long enough needs a spill.
  const alreadySpilled = names.filter((f) => stored[f] !== record[f]);
  const toSpill = fieldsToSpill(type, slug, fields).filter((f) => stored[f] === record[f]);
  if (toSpill.length === 0) {
    return finish({
      action: alreadySpilled.length > 0 ? "already_spilled" : "nothing_to_spill",
      type,
      slug,
      fields: report(stored),
    });
  }

  const hash = schemaHashFor(type, opts.cfg);
  const now = nowIso();
  const plan = await buildResidentWritePlan({
    node,
    cfg: opts.cfg,
    type,
    schemaHash: hash,
    previous: record,
    next: record,
    primaryFields: fields,
    now,
    ...(opts.verbose ? { verbose: opts.verbose } : {}),
  });
  await commitResidentWritePlan({ node, plan, type, slug });

  // Read back: the full text must be byte-identical, and the stored form small.
  const seen = await withReadRetry(
    () => findBySlug(node, type, hash, slug, opts.cfg),
    (r) => r !== null && names.every((f) => r[f] === record[f]),
  );
  for (const f of names) {
    if (seen === null || seen[f] !== record[f]) {
      throw new FbrainError({
        code: "spill_verify_failed",
        message:
          `spill: ${type} ${slug} field ${f} does not read back identical ` +
          `(before sha256 ${sha256Of(String(record[f] ?? "")).slice(0, 12)}, ` +
          `after ${sha256Of(String(seen?.[f] ?? "")).slice(0, 12)}).`,
        hint: "Re-read with `brain get`; the old text is still in the record until the write lands.",
      });
    }
  }
  return finish({
    action: "spilled",
    type,
    slug,
    fields: report(recordFromPrimaryFields(plan.ops.find((o) => o.projection === "primary")?.fields ?? stored)),
  });
}
