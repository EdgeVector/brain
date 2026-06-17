// `fbrain link <task-slug> <design-slug>` — set a task's parent design.
// Rejects a non-existent design (no dangling refs).

import { FbrainError, type Verbose } from "../client.ts";
import { newWriteClientFromCfg } from "../write-context.ts";
import type { Config } from "../config.ts";
import { resolvePrintSink } from "../format.ts";
import {
  findBySlug,
  findBySlugFast,
  normalizeSlug,
  nowIso,
  schemaHashFor,
} from "../record.ts";
import { RECORD_TYPES, type RecordType } from "../schemas.ts";

export type LinkOptions = {
  cfg: Config;
  taskSlug: string;
  designSlug: string;
  verbose?: Verbose;
  print?: (line: string) => void;
  // Structured-output sink, mirroring the read commands' `onResult`: fires
  // once on the success path with the SAME normalized slugs the printed
  // `linked task <task> → design <design>` line uses. v0 is strictly
  // task → design, so the type pair is fixed.
  onResult?: (payload: LinkResult) => void;
};

// The structured payload the MCP `fbrain_link` tool returns in
// `structuredContent` (mirrors the printed `linked task <task> → design
// <design>` line). v0 only supports task → design.
export type LinkResult = {
  action: "linked";
  from_type: "task";
  from_slug: string;
  to_type: "design";
  to_slug: string;
};

export async function linkCmd(opts: LinkOptions): Promise<void> {
  const print = resolvePrintSink(opts);
  const taskSlug = normalizeSlug(opts.taskSlug);
  const designSlug = normalizeSlug(opts.designSlug);
  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);

  const taskHash = schemaHashFor("task", opts.cfg);
  const designHash = schemaHashFor("design", opts.cfg);

  // /api/query returns a non-deterministic top-100 slice per schema, so a
  // single findBySlug can miss an existing slug on a schema with >100 rows.
  // The fast-miss helper rides out the saturated-daemon empty-page flake
  // (so a real task on a >100-row schema is still found) but short-circuits
  // on a populated-but-missing page, so a typo'd <task-slug> errors in ~one
  // query instead of burning the full 5×250 ms retry budget. Same helper
  // put.ts / new.ts / resolveBySlug use.
  const task = await findBySlugFast(node, "task", taskHash, taskSlug);
  if (!task) {
    // `link` is directional — <task-slug> first, <design-slug> second — and
    // reversing the two is the most common first-use mistake (the slug the
    // user named as the "task" is really a design). Detect that case and say
    // so explicitly with the corrected command, instead of a bare "No task"
    // that gives no clue the argument order is wrong. Best-effort single
    // lookup: a flaky page miss just falls through to the generic hint.
    const asDesign = await findBySlug(node, "design", designHash, taskSlug);
    let hint: string;
    if (asDesign) {
      // Only print the swap suggestion when the 2nd arg actually names a
      // task. Otherwise the "corrected" command echoes the failure: the
      // same-slug case (`link d1 d1`) suggests the IDENTICAL failing
      // command, and the two-designs case (`link dA dB`) suggests
      // `link dB dA` which still has no task in the task position and
      // re-fails with `No task: dB`. Skip the lookup when both slugs
      // match — we already know taskSlug isn't a task (it failed
      // findBySlugFast above). Best-effort: a flaky page miss falls
      // through to the no-concrete-command variant.
      const asTask =
        designSlug === taskSlug
          ? null
          : await findBySlug(node, "task", taskHash, designSlug);
      hint = asTask
        ? `'${taskSlug}' is a design, not a task. \`link\` takes the task first — try \`fbrain link ${designSlug} ${taskSlug}\` (usage: \`fbrain link <task-slug> <design-slug>\`).`
        : `'${taskSlug}' is a design, not a task — \`link\` takes a TASK first. Name a real task (\`fbrain list --type task\`), then the design (usage: \`fbrain link <task-slug> <design-slug>\`).`;
    } else {
      hint = `Create the task first (\`fbrain task new ${taskSlug}\`) or check the slug with \`fbrain list --type task\` (usage: \`fbrain link <task-slug> <design-slug>\`).`;
    }
    throw new FbrainError({
      code: "not_found",
      message: `No task: ${taskSlug}`,
      hint,
    });
  }

  const design = await findBySlugFast(node, "design", designHash, designSlug);
  if (!design) {
    // Wrong-type detection: if `designSlug` names a record of another type
    // (concept/reference/project/...), telling the user to "create the
    // design first" is actively misleading — `fbrain get <slug>` returns
    // the row. Sweep the non-design types and, on a hit, say WHICH type
    // the slug is so the user can pick a real design instead. Best-effort:
    // each lookup swallows its own flake / missing-hash error and falls
    // through to the existing generic message, matching the defensive
    // style of the task-side `findBySlug(design)` fallback above.
    // Messaging only — `link` is still strictly task → design.
    const wrongType = await findOtherTypeForSlug(node, opts.cfg, designSlug);
    if (wrongType !== null) {
      throw new FbrainError({
        code: "dangling_design_slug",
        message: `'${designSlug}' is a ${wrongType}, not a design.`,
        hint:
          "`link` only attaches a task to its parent design (a task's `design_slug`). " +
          "Pick a design (`fbrain list --type design`), or create one with `fbrain design new <slug>`.",
      });
    }
    throw new FbrainError({
      code: "dangling_design_slug",
      message: `No design: ${designSlug}`,
      hint: "Create the design first (`fbrain design new ...`).",
    });
  }

  const now = nowIso();
  const fields = {
    slug: task.slug,
    title: task.title,
    body: task.body,
    status: task.status,
    design_slug: designSlug,
    tags: task.tags,
    created_at: task.created_at,
    updated_at: now,
  };

  await node.updateRecord({
    schemaHash: taskHash,
    keyHash: taskSlug,
    fields,
  });

  print(`linked task ${taskSlug} → design ${designSlug}`);
  // Emit the structured payload from the SAME normalized slugs the printed
  // line uses (one source of truth — see the read commands).
  opts.onResult?.({
    action: "linked",
    from_type: "task",
    from_slug: taskSlug,
    to_type: "design",
    to_slug: designSlug,
  });
}

// Best-effort cross-type lookup: returns the first non-design type the slug
// resolves under, or null if it resolves nowhere (or only flakes). Each per-
// type query is wrapped so a missing schema hash or a thrown lookup doesn't
// crash the wrong-type hint — a flake just falls through to the existing
// "No design / Create the design first" message, preserving the pre-fix UX
// on the unhappy path while improving it on the happy one.
async function findOtherTypeForSlug(
  node: Parameters<typeof findBySlug>[0],
  cfg: Config,
  slug: string,
): Promise<RecordType | null> {
  const otherTypes = RECORD_TYPES.filter((t): t is RecordType => t !== "design");
  const matches = await Promise.all(
    otherTypes.map(async (t) => {
      try {
        const hash = schemaHashFor(t, cfg);
        const row = await findBySlug(node, t, hash, slug);
        return row ? t : null;
      } catch {
        return null;
      }
    }),
  );
  return matches.find((t): t is RecordType => t !== null) ?? null;
}
