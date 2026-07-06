// `fbrain link <from-slug> <to-slug>` — store an explicit record edge.
// The legacy task → design pair still writes task.design_slug for
// compatibility; all other pairs store a link:<type>:<slug> tag on the
// source record. Explicit edges reject missing targets.

import { FbrainError, type Verbose } from "../client.ts";
import { newWriteClientFromCfg } from "../write-context.ts";
import type { Config } from "../config.ts";
import { resolvePrintSink } from "../format.ts";
import {
  findBySlug,
  genericLinkTag,
  normalizeSlug,
  nowIso,
  schemaHashFor,
  type FbrainRecord,
} from "../record.ts";
import { RECORD_TYPES, type RecordType } from "../schemas.ts";

export type LinkOptions = {
  cfg: Config;
  fromSlug?: string;
  toSlug?: string;
  fromType?: RecordType;
  toType?: RecordType;
  // Back-compat names used by older CLI/tests/MCP call sites.
  taskSlug: string;
  designSlug: string;
  verbose?: Verbose;
  print?: (line: string) => void;
  // Structured-output sink, mirroring the read commands' `onResult`: fires
  // once on the success path with the SAME normalized slugs the printed
  // `linked <from_type> <from_slug> → <to_type> <to_slug>` line uses.
  onResult?: (payload: LinkResult) => void;
};

// The structured payload the MCP `fbrain_link` tool returns in
// `structuredContent` (mirrors the printed `linked <from_type> ...` line).
export type LinkResult = {
  action: "linked";
  from_type: RecordType;
  from_slug: string;
  to_type: RecordType;
  to_slug: string;
};

export async function linkCmd(opts: LinkOptions): Promise<void> {
  const print = resolvePrintSink(opts);
  const fromType = opts.fromType ?? "task";
  const toType = opts.toType ?? "design";
  const fromSlug = normalizeSlug(opts.fromSlug ?? opts.taskSlug);
  const toSlug = normalizeSlug(opts.toSlug ?? opts.designSlug);
  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);

  const fromHash = schemaHashFor(fromType, opts.cfg);
  const toHash = schemaHashFor(toType, opts.cfg);

  // A keyed point-read (`findBySlug`) is authoritative (found-or-not) without
  // scanning, so a real record on a >100-row schema is still found and a typo'd
  // <task-slug> errors in one query. Same point-read put.ts / new.ts use.
  const source = await findBySlug(node, fromType, fromHash, fromSlug);
  if (!source) {
    if (fromType !== "task" || toType !== "design") {
      throw new FbrainError({
        code: "not_found",
        message: `No ${fromType}: ${fromSlug}`,
        hint: `Create the ${fromType} first or check the slug with \`fbrain list --type ${fromType}\`.`,
      });
    }
    // `link` is directional — <task-slug> first, <design-slug> second — and
    // reversing the two is the most common first-use mistake (the slug the
    // user named as the "task" is really a design). Detect that case and say
    // so explicitly with the corrected command, instead of a bare "No task"
    // that gives no clue the argument order is wrong. Best-effort single
    // lookup: a flaky page miss just falls through to the generic hint.
    const designHash = schemaHashFor("design", opts.cfg);
    const taskHash = schemaHashFor("task", opts.cfg);
    const asDesign = await findBySlug(node, "design", designHash, fromSlug);
    let hint: string;
    if (asDesign) {
      // Only print the swap suggestion when the 2nd arg actually names a
      // task. Otherwise the "corrected" command echoes the failure: the
      // same-slug case (`link d1 d1`) suggests the IDENTICAL failing
      // command, and the two-designs case (`link dA dB`) suggests
      // `link dB dA` which still has no task in the task position and
      // re-fails with `No task: dB`. Skip the lookup when both slugs
      // match — we already know taskSlug isn't a task (it failed the
      // `findBySlug` above). Best-effort: a flaky page miss falls
      // through to the no-concrete-command variant.
      const asTask =
        toSlug === fromSlug
          ? null
          : await findBySlug(node, "task", taskHash, toSlug);
      hint = asTask
        ? `'${fromSlug}' is a design, not a task. \`link\` takes the task first — try \`fbrain link ${toSlug} ${fromSlug}\` (usage: \`fbrain link <task-slug> <design-slug>\`).`
        : `'${fromSlug}' is a design, not a task — \`link\` takes a TASK first. Name a real task (\`fbrain list --type task\`), then the design (usage: \`fbrain link <task-slug> <design-slug>\`).`;
    } else {
      hint = `Create the task first (\`fbrain task new ${fromSlug}\`) or check the slug with \`fbrain list --type task\` (usage: \`fbrain link <task-slug> <design-slug>\`).`;
    }
    throw new FbrainError({
      code: "not_found",
      message: `No task: ${fromSlug}`,
      hint,
    });
  }

  const target = await findBySlug(node, toType, toHash, toSlug);
  if (!target) {
    // Wrong-type detection: if `designSlug` names a record of another type
    // (concept/reference/project/...), telling the user to "create the
    // design first" is actively misleading — `fbrain get <slug>` returns
    // the row. Sweep the non-design types and, on a hit, say WHICH type
    // the slug is so the user can pick a real design instead. Best-effort:
    // each lookup swallows its own flake / missing-hash error and falls
    // through to the existing generic message, matching the defensive
    // style of the task-side `findBySlug(design)` fallback above.
    const wrongType = await findOtherTypeForSlug(node, opts.cfg, toSlug, toType);
    const code = toType === "design" ? "dangling_design_slug" : "dangling_link_target";
    if (wrongType !== null) {
      throw new FbrainError({
        code,
        message: `'${toSlug}' is a ${wrongType}, not a ${toType}.`,
        hint: `Pick a ${toType} (\`fbrain list --type ${toType}\`), or create one with \`fbrain ${toType} new <slug>\`.`,
      });
    }
    throw new FbrainError({
      code,
      message: `No ${toType}: ${toSlug}`,
      hint: `Create the ${toType} first (\`fbrain ${toType} new ...\`).`,
    });
  }

  const now = nowIso();
  const fields = fieldsForLinkUpdate(source, fromType, toType, toSlug, now);

  await node.updateRecord({
    schemaHash: fromHash,
    keyHash: fromSlug,
    fields,
  });

  print(`linked ${fromType} ${fromSlug} → ${toType} ${toSlug}`);
  // Emit the structured payload from the SAME normalized slugs the printed
  // line uses (one source of truth — see the read commands).
  opts.onResult?.({
    action: "linked",
    from_type: fromType,
    from_slug: fromSlug,
    to_type: toType,
    to_slug: toSlug,
  });
}

function fieldsForLinkUpdate(
  source: FbrainRecord,
  fromType: RecordType,
  toType: RecordType,
  toSlug: string,
  now: string,
): Record<string, unknown> {
  const tags =
    fromType === "task" && toType === "design"
      ? source.tags
      : Array.from(new Set([...source.tags, genericLinkTag(toType, toSlug)]));
  const fields: Record<string, unknown> = {
    slug: source.slug,
    title: source.title,
    body: source.body,
    status: source.status,
    tags,
    created_at: source.created_at,
    updated_at: now,
  };
  if (fromType === "task") {
    fields.design_slug =
      toType === "design" ? toSlug : source.design_slug ?? "";
  }
  return fields;
}

// Best-effort cross-type lookup: returns the first non-target type the slug
// resolves under, or null if it resolves nowhere (or only flakes). Each
// lookup is wrapped so a missing schema hash or a thrown lookup doesn't
// crash the wrong-type hint — a flake just falls through to the existing
// "No design / Create the design first" message, preserving the pre-fix UX
// on the unhappy path while improving it on the happy one.
//
// COST-BOUNDED error decoration: this fires only to dress up a failure, so it
// must stay cheaper than the happy path, not fan out wider. Two bounds:
//   1. Lookups are grouped by UNIQUE schema hash — the Phase 6 types share
//      the unified MEMO hash, so querying per-TYPE issued the same keyed
//      lookup several times over; one probe per hash answers for all the
//      types mapped onto it.
//   2. Probes run SEQUENTIALLY with an early exit on the first hit (instead
//      of the previous unconditional parallel fan-out across every type), so
//      the typical wrong-type case costs one or two single-attempt keyed
//      point-reads (`findBySlug` — no retry budget), and the worst case is
//      one small keyed query per unique schema hash.
async function findOtherTypeForSlug(
  node: Parameters<typeof findBySlug>[0],
  cfg: Config,
  slug: string,
  targetType: RecordType,
): Promise<RecordType | null> {
  // Group the non-target types by schema hash, preserving RECORD_TYPES order
  // (the returned type label for a shared-hash hit is the first type mapped
  // onto that hash — the same first-match-wins answer the old per-type sweep
  // produced).
  const typesByHash = new Map<string, RecordType>();
  for (const t of RECORD_TYPES) {
    if (t === targetType) continue;
    let hash: string;
    try {
      hash = schemaHashFor(t, cfg);
    } catch {
      continue; // partially-initialised config — skip, as before
    }
    if (!typesByHash.has(hash)) typesByHash.set(hash, t);
  }
  // Don't re-probe the target type's own schema through a shared hash.
  try {
    typesByHash.delete(schemaHashFor(targetType, cfg));
  } catch {
    // target hash unavailable — nothing to exclude
  }
  for (const [hash, t] of typesByHash) {
    try {
      const row = await findBySlug(node, t, hash, slug);
      if (row) return t;
    } catch {
      // Best-effort: a flaked probe falls through to the next hash.
    }
  }
  return null;
}
