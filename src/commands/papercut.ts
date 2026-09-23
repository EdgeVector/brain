// `brain papercut file|close|census|list` — the typed papercut ledger.
//
// This replaces a freeform-prose ledger whose failures were all measured, not
// inferred (2026-08-03 → 2026-08-06, across the lastgit/kanban/db-developer
// chief-engineer runs):
//
//   * 68 of 109 records read `Status: OPEN`; at least 2 were provably fixed.
//   * 40 of 107 were closed at the BOTTOM and open at the TOP, because
//     `brain append` cannot rewrite the `Status:` line it follows.
//   * 22 had no `Status:` line at all and could not be counted either way.
//   * The same defect was filed twice, two hours apart, by different runs.
//   * A fully specified fix sat unread for three days, because nothing
//     distinguished a finished proposal from a raw complaint.
//
// Each command below closes one of those, and `close` is the one that matters
// most: it performs BOTH writes — the evidence append and the status field —
// so a half-closure is not expressible.

import { FbrainError, type Verbose } from "../client.ts";
import type { Config } from "../config.ts";
import { resolvePrintSink } from "../format.ts";
import {
  crossTypeSlugNote,
  findBySlug,
  findCrossTypeSlugCollisions,
  normalizeSlug,
  nowIso,
  resolveBySlug,
  schemaHashFor,
  updateFieldsFrom,
  withReadRetry,
  type FbrainRecord,
} from "../record.ts";
import { findCmd, type FindHit } from "./find.ts";
import { newWriteClientFromCfg } from "../write-context.ts";
import { recordListEntryHash } from "../record-list-index.ts";
import {
  newPapercutReadStats,
  readPapercutSlugsByStatus,
  readPapercutsByStatus,
} from "../papercut-status-index.ts";
import {
  buildResidentWritePlan,
  commitResidentWritePlan,
} from "../resident-write-plan.ts";
import {
  ensureComponent,
  ensureDuplicateTarget,
  ensureKind,
  ensurePapercutSlug,
  ensurePapercutStatus,
  ensureSeverity,
  ensureVerificationEvidence,
  isLivePapercutStatus,
  symptomHash,
} from "../papercut.ts";

const PAPERCUT: "papercut" = "papercut";

// Raw cosine floor for semantic duplicate candidates. `find` orders with RRF,
// whose scores are intentionally tiny and rank-relative; dedupe needs the
// strongest absolute similarity returned by any individual probe.
export const SEMANTIC_DUPLICATE_THRESHOLD = 0.5;
export const SEMANTIC_DUPLICATE_LIMIT = 10;

// How many papercuts to RETRIEVE before the component / live-status / cleared
// filters run. This is deliberately much larger than SEMANTIC_DUPLICATE_LIMIT,
// which bounds what is DISPLAYED.
//
// The bug this closes (measured 2026-08-17 → 2026-09-03, 15+ recurrences on
// papercut-brain-papercut-file-token-overlap-refuses-unrelated-claims): `find`
// sliced to 10 hits across EVERY component, and only then did we drop
// out-of-component records, terminal records, and the caller's
// --not-duplicate-of set. So a disclaimed candidate still occupied a retrieval
// slot: clearing it did not widen the view, it just revealed whatever the slice
// had been hiding. One filing cost five full re-sends of the whole --body, and
// the round-trip count had no upper bound.
//
// Retrieving wide and filtering after makes an exclusion actually free a slot,
// so the candidate set SHRINKS monotonically across attempts instead of moving.
export const SEMANTIC_DUPLICATE_FETCH_LIMIT = 60;

export type DuplicateCandidate = {
  slug: string;
  title: string;
  status: string;
  score: number;
  exact: boolean;
  /** The candidate's component, when it differs from the filing's. */
  component?: string;
  /**
   * True when the candidate is CLOSED (verified/wontfix/duplicate) inside the
   * recurrence window. A recurrence is never cleared by the bulk
   * `--not-duplicate-of-any` waiver; see RECURRENCE_WINDOW_DAYS.
   */
  recurrence?: boolean;
  /** For a recurrence: the row to reopen (a `duplicate` row's target). */
  canonical?: string;
  /** For a recurrence: when the candidate was last written (its close time). */
  closed_at?: string;
};

// A live papercut in ANOTHER component gates a filing only above this raw
// cosine. Measured 2026-09-23 on the primary: one defect (the close-out
// `rm -f` sample the shell guard rejects) sat in 12 components —
// close-out-skill, routine, exec-guard, codex-exec, codex-exec-guard,
// routinesd, last-stack, shell-safety-guard, routines-shell-guard, … — at
// 0.74–0.86 against its own title, while the nearest unrelated row scored
// 0.743. A component-scoped gate cannot see any of those siblings, so each
// run that picked a new component name filed a fresh row.
export const CROSS_COMPONENT_DUPLICATE_THRESHOLD = 0.83;

// The recurrence gate. Only LIVE rows used to gate a filing, so the moment a
// canonical row was closed `verified` the next run that hit the same defect
// filed a fresh row — measured 2026-09-23: ~251 new rows in ~11 h, most of
// them re-files of defects closed `verified` the same day (zsh `status`, jq
// optional syntax, heredoc backticks, the rm guard). A recurrence must land as
// ONE reopened canonical row, not N fresh ones, or the ledger can never reach
// zero and the recurrence itself is invisible (it reads as new work).
//
// Same component: this floor (stricter than the live 0.5, because a closed row
// refusing a genuinely new defect costs more than a live one; a distinct brain
// append defect scored 0.769 against an unrelated closed append row on
// 2026-09-23). Other components: CROSS_COMPONENT_DUPLICATE_THRESHOLD.
export const RECURRENCE_THRESHOLD = 0.8;
export const RECURRENCE_WINDOW_DAYS = 14;

export function papercutDedupeProbes(opts: {
  title: string;
  symptom: string;
  body: string;
}): string[] {
  const error = /^(?:error|exception):\s*(.+)$/im.exec(opts.body)?.[1]?.trim();
  return [
    ...new Set(
      [opts.title.trim(), opts.symptom.trim(), error ?? ""].filter(Boolean),
    ),
  ];
}

function closedWithinWindow(
  updatedAt: unknown,
  now: Date,
  windowDays: number,
): boolean {
  if (typeof updatedAt !== "string") return false;
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t <= windowDays * 86_400_000;
}

export function semanticDuplicateCandidates(
  hits: readonly FindHit[],
  opts: {
    component: string;
    exactSlug?: string;
    now?: Date;
    recurrenceWindowDays?: number;
  },
): DuplicateCandidate[] {
  const now = opts.now ?? new Date();
  const windowDays = opts.recurrenceWindowDays ?? RECURRENCE_WINDOW_DAYS;
  const candidates: DuplicateCandidate[] = [];
  for (const hit of hits) {
    const record = hit.record;
    const exact = record.slug === opts.exactSlug;
    const score = exact ? 1 : hit.maxSimilarity;
    const sameComponent =
      typeof record.component !== "string" ||
      record.component === opts.component;
    const otherComponent =
      !sameComponent && typeof record.component === "string"
        ? { component: record.component }
        : {};
    if (isLivePapercutStatus(record.status)) {
      const floor = sameComponent
        ? SEMANTIC_DUPLICATE_THRESHOLD
        : CROSS_COMPONENT_DUPLICATE_THRESHOLD;
      if (exact || score >= floor) {
        candidates.push({
          slug: record.slug,
          title: record.title,
          status: record.status,
          score,
          exact,
          ...otherComponent,
        });
      }
      continue;
    }
    // A CLOSED row. The exact-slug case is answered by `papercut_exists`
    // (which names --reopen), not here.
    if (exact) continue;
    if (!closedWithinWindow(record.updated_at, now, windowDays)) continue;
    const floor = sameComponent
      ? RECURRENCE_THRESHOLD
      : CROSS_COMPONENT_DUPLICATE_THRESHOLD;
    if (score < floor) continue;
    const target =
      record.status === "duplicate" &&
      typeof record.duplicate_of === "string" &&
      record.duplicate_of.trim() !== ""
        ? normalizeSlug(record.duplicate_of)
        : record.slug;
    candidates.push({
      slug: record.slug,
      title: record.title,
      status: record.status,
      score,
      exact: false,
      ...otherComponent,
      recurrence: true,
      canonical: target,
      closed_at: record.updated_at,
    });
  }
  return candidates.sort((a, b) => b.score - a.score);
}

/** The distinct rows a recurrence refusal asks the filer to reopen. */
export function recurrenceCanonicals(
  candidates: readonly DuplicateCandidate[],
): string[] {
  return [
    ...new Set(
      candidates
        .filter((c) => c.recurrence)
        .map((c) => c.canonical ?? c.slug),
    ),
  ];
}

/**
 * Split the surviving candidates into the ones that still REFUSE the filing and
 * the ones a bulk `--not-duplicate-of-any` waiver clears.
 *
 * An EXACT slug match is never waivable. It is not a similarity judgement the
 * filer can overrule — it says the record already exists, and the correct
 * answer is `papercut_exists` (or the idempotent replay), not a second row.
 */
export function partitionWaivedCandidates(
  candidates: readonly DuplicateCandidate[],
  waiveAll: boolean,
): { duplicates: DuplicateCandidate[]; waived: string[] } {
  if (!waiveAll) return { duplicates: [...candidates], waived: [] };
  // A recurrence is not a similarity call about two live rows: it says a
  // defect closed in the last RECURRENCE_WINDOW_DAYS came back. The bulk
  // waiver would turn it straight back into a fresh row, which is the inflow
  // this gate exists to stop. Only a per-slug --not-duplicate-of (a named
  // judgement) or --reopen clears it.
  return {
    duplicates: candidates.filter((c) => c.exact || c.recurrence === true),
    waived: candidates
      .filter((c) => !c.exact && c.recurrence !== true)
      .map((c) => c.slug),
  };
}

export type PapercutFileOptions = {
  cfg: Config;
  slug: string;
  title: string;
  body: string;
  component: string;
  symptom: string;
  severity: string;
  kind: string;
  repo?: string;
  tags?: string[];
  // Escape hatch for a real non-duplicate that trips the near gate. Records the
  // slug it was compared against so the judgement is auditable rather than a
  // silent `--force`.
  notDuplicateOf?: string[];
  // Bulk form of the escape hatch: clear EVERY candidate the gate raises, in
  // one call. Still auditable — each cleared slug is written into the new
  // record's body, and the note says the waiver was the bulk one, so a reader
  // can tell "I read seven records and judged each distinct" apart from "I
  // waived whatever came back".
  //
  // Exists because the per-slug form made the cost of filing unbounded: the
  // standing rule is ALWAYS file papercuts, and a gate that charges five full
  // --body re-sends per record is a standing incentive to skip filing — the
  // exact failure the typed ledger was built to prevent.
  notDuplicateOfAny?: boolean;
  // Fold this filing into an existing row instead of writing a new one: the
  // filing becomes a `reconfirmed` evidence block on <slug>, and a closed row
  // is reopened. The answer to a recurrence refusal.
  reopen?: string;
  verbose?: Verbose;
  print?: (line: string) => void;
  json?: boolean;
};

export type PapercutFileResult = {
  action: "filed" | "duplicate_blocked" | "reopened";
  slug: string;
  component: string;
  symptom_hash: string;
  duplicates: DuplicateCandidate[];
  idempotent?: boolean;
  // Candidates cleared by --not-duplicate-of-any on THIS call, when it fired.
  waived?: string[];
  // On a refusal that followed `--not-duplicate-of`: the slugs the flag
  // removed from the candidate set, and the ones it named that matched no
  // candidate at all. See `clearedDiagnostics`.
  cleared?: string[];
  cleared_unmatched?: string[];
  // On a recurrence refusal: the canonical row(s) to pass to --reopen.
  reopen?: string[];
  // On `reopened`: the row the filing was folded into, and its status move.
  reopened?: { slug: string; from: string; to: string };
};

/**
 * `papercut file ... --reopen <canonical>`: fold the filing into the canonical
 * row instead of writing a new one. One row carries the recurrence, its kind
 * becomes `reconfirmed`, and a closed row goes back to `open` (a live row
 * keeps its status, except `fixed`, which a recurrence disproves).
 */
async function papercutReopenFromFiling(
  opts: PapercutFileOptions & { component: string; hash: string },
): Promise<PapercutFileResult> {
  const print = resolvePrintSink(opts);
  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);
  let target = normalizeSlug(opts.reopen ?? "");
  let only = await resolveBySlug({
    node,
    cfg: opts.cfg,
    slug: target,
    type: PAPERCUT,
    recoveryVerb: "papercut close",
  });
  // A `duplicate` row is not the canonical; follow it once to its target.
  const dupOf = only.record.duplicate_of;
  if (
    only.record.status === "duplicate" &&
    typeof dupOf === "string" &&
    dupOf.trim() !== ""
  ) {
    target = normalizeSlug(dupOf);
    only = await resolveBySlug({
      node,
      cfg: opts.cfg,
      slug: target,
      type: PAPERCUT,
      recoveryVerb: "papercut close",
    });
  }
  const from = only.record.status;
  const to = from === "open" || from === "partial" ? from : "open";
  const filedAs = opts.slug === target ? "" : ` (filed as \`${opts.slug}\`)`;
  const evidence = [
    `Reconfirmed ${nowIso()}${filedAs}: the defect recurred after this row read \`${from}\`. component=${opts.component} severity=${opts.severity} symptom_hash=${opts.hash}`,
    "",
    `Title: ${opts.title.trim()}`,
    `Symptom: ${opts.symptom.trim()}`,
    "",
    opts.body.trim(),
  ]
    .join("\n")
    .trimEnd();
  const closeOpts: PapercutCloseOptions = {
    cfg: opts.cfg,
    slug: target,
    status: to,
    evidence,
    kind: "reconfirmed",
    print: () => {},
  };
  if (opts.verbose) closeOpts.verbose = opts.verbose;
  await papercutCloseCmd(closeOpts);
  const result: PapercutFileResult = {
    action: "reopened",
    slug: target,
    component: opts.component,
    symptom_hash: opts.hash,
    duplicates: [],
    reopened: { slug: target, from, to },
  };
  if (opts.json) print(JSON.stringify(result));
  else
    print(
      `reopened papercut ${target}: ${from} → ${to} (kind reconfirmed); this filing is its newest evidence block, no new row written`,
    );
  return result;
}

export type ClearedDiagnostics = {
  /** Given slugs that named a candidate and were removed. */
  cleared: string[];
  /** Given slugs that matched NO candidate — a typo, an elided slug, a stale copy. */
  unmatched: string[];
  /** One human line stating both, for the refusal text. */
  line: string;
};

/**
 * What `--not-duplicate-of` actually did against THIS candidate set.
 *
 * Null when no slug was given, so a first refusal prints nothing extra. When
 * slugs were given, the line says how many named a candidate and lists every
 * one that did not — because a refusal that repeats the same wall after the
 * filer cleared it by name is indistinguishable from an ignored flag unless
 * the command says which slugs it recognised.
 */
export function clearedDiagnostics(
  candidates: readonly DuplicateCandidate[],
  cleared: ReadonlySet<string>,
): ClearedDiagnostics | null {
  if (cleared.size === 0) return null;
  const candidateSlugs = new Set(candidates.map((c) => c.slug));
  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const s of cleared) (candidateSlugs.has(s) ? matched : unmatched).push(s);
  const head = `--not-duplicate-of: ${matched.length} of ${cleared.size} given slug(s) named a candidate and were cleared`;
  const tail =
    unmatched.length === 0
      ? "; the rows above are the candidates that remain."
      : `; ${unmatched.length} matched NO candidate (check the exact slug text, it must equal the slug column above): ${unmatched.join(", ")}`;
  return { cleared: matched, unmatched, line: head + tail };
}

type PapercutFileMaterialized = Pick<
  FbrainRecord,
  | "slug"
  | "title"
  | "body"
  | "status"
  | "tags"
  | "created_at"
  | "updated_at"
> &
  Record<string, unknown>;

/** Exact same filing input may safely repair membership and return success. */
export function isIdempotentPapercutFile(
  existing: FbrainRecord,
  desired: PapercutFileMaterialized,
): boolean {
  const scalarFields = [
    "slug",
    "title",
    "body",
    "status",
    "component",
    "repo",
    "severity",
    "kind",
    "symptom_hash",
  ] as const;
  if (scalarFields.some((field) => existing[field] !== desired[field]))
    return false;
  const existingTags = Array.isArray(existing.tags) ? existing.tags : [];
  const desiredTags = Array.isArray(desired.tags) ? desired.tags : [];
  return (
    existingTags.length === desiredTags.length &&
    existingTags.every((tag, index) => tag === desiredTags[index])
  );
}

export async function papercutFileCmd(
  opts: PapercutFileOptions,
): Promise<PapercutFileResult> {
  const print = resolvePrintSink(opts);
  const slug = ensurePapercutSlug(normalizeSlug(opts.slug));
  const component = ensureComponent(opts.component);
  const severity = ensureSeverity(opts.severity);
  const kind = ensureKind(opts.kind);
  if (opts.symptom.trim().length === 0) {
    throw new FbrainError({
      code: "missing_symptom",
      message:
        "--symptom is required: one sentence naming the OBSERVABLE, not the fix.\n" +
        "It is the dedupe key — two runs seeing the same thing should write the same sentence.",
    });
  }
  const hash = symptomHash(component, opts.symptom);

  if (opts.reopen !== undefined && opts.reopen.trim() !== "") {
    return papercutReopenFromFiling({ ...opts, slug, component, hash });
  }

  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);
  const schemaHash = schemaHashFor(PAPERCUT, opts.cfg);
  const cleared = new Set((opts.notDuplicateOf ?? []).map(normalizeSlug));
  const now = nowIso();
  const clearedNote =
    cleared.size > 0
      ? `\n\nCompared against and judged distinct from: ${[...cleared]
          .map((s) => `[[${s}]]`)
          .join(", ")}.`
      : "";
  const body = `Symptom: ${opts.symptom.trim()}\n\n${opts.body.trim()}${clearedNote}\n`;
  const materialized: PapercutFileMaterialized = {
    slug,
    title: opts.title,
    body,
    status: "open",
    component,
    repo: opts.repo ?? "",
    severity,
    kind,
    symptom_hash: hash,
    fixed_by: "",
    verified_by: "",
    duplicate_of: "",
    tags: opts.tags ?? [],
    created_at: now,
    updated_at: now,
  };

  // Preserve the cheap exact-restatement pre-filter as one point read. The
  // fuzzy tail is semantic `find`, never a papercut partition enumeration.
  const prior = await findBySlug(node, PAPERCUT, schemaHash, slug);
  if (prior && isIdempotentPapercutFile(prior, materialized)) {
    const primaryFields = updateFieldsFrom(prior, PAPERCUT, {});
    const plan = await buildResidentWritePlan({
      node,
      cfg: opts.cfg,
      type: PAPERCUT,
      schemaHash,
      previous: prior,
      next: prior,
      primaryFields,
    });
    await commitResidentWritePlan({ node, plan, type: PAPERCUT, slug });
    const result: PapercutFileResult = {
      action: "filed",
      slug,
      component,
      symptom_hash: hash,
      duplicates: [],
      idempotent: true,
    };
    if (opts.json) print(JSON.stringify(result));
    else print(`papercut ${slug} already filed; keyed membership verified`);
    return result;
  }
  let semanticHits: FindHit[];
  if (prior) {
    // An exact slug settles the pre-filter without paying for vector search.
    semanticHits = [
      {
        type: PAPERCUT,
        slug: prior.slug,
        fusedScore: 0,
        maxSimilarity: 1,
        matchHits: [],
        record: prior,
      },
    ];
  } else {
    const probes = papercutDedupeProbes({
      title: opts.title,
      symptom: opts.symptom,
      body: opts.body,
    });
    try {
      semanticHits = (
        await findCmd({
          cfg: opts.cfg,
          matches: probes,
          types: [PAPERCUT],
          // Retrieve wide, filter after — see SEMANTIC_DUPLICATE_FETCH_LIMIT.
          // Every already-cleared slug is additional headroom, so disclaiming
          // one candidate cannot push an unseen one out of the result set.
          limit: SEMANTIC_DUPLICATE_FETCH_LIMIT + cleared.size,
          verbose: opts.verbose,
          print: () => {},
          printErr: () => {},
        })
      ).hits;
    } catch (error) {
      semanticHits = [];
      opts.verbose?.(
        `papercut dedupe: semantic probe unavailable; exact-slug pre-filter only (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  // Every in-component live candidate over the floor, not a top-k page of them.
  // The refusal used to report a slice while reading as a complete count
  // ("Possible duplicate: 2 live papercut(s) ..."), so clearing the named two
  // surfaced two more and the filer had no way to learn the whole set in one
  // call.
  const allCandidates = semanticDuplicateCandidates(semanticHits, {
    component,
    exactSlug: slug,
  });
  // A recurrence is also cleared by naming its canonical row.
  const remaining = allCandidates.filter(
    (c) =>
      !cleared.has(c.slug) &&
      !(c.canonical !== undefined && cleared.has(c.canonical)),
  );
  const clearing = clearedDiagnostics(allCandidates, cleared);

  const { duplicates, waived } = partitionWaivedCandidates(
    remaining,
    opts.notDuplicateOfAny === true,
  );

  if (duplicates.length > 0) {
    const canonicals = recurrenceCanonicals(duplicates);
    const liveCount = duplicates.filter((d) => d.recurrence !== true).length;
    const lines = [
      liveCount > 0
        ? `Possible duplicate: ${liveCount} live papercut(s) may already describe this (component \`${component}\`, plus near-identical rows in other components).`
        : `Recurrence: ${duplicates.length} papercut(s) CLOSED in the last ${RECURRENCE_WINDOW_DAYS} days already describe this.`,
      "",
      ...duplicates.map(
        (d) =>
          `  ${d.exact ? "EXACT" : `${Math.round(d.score * 100)}%  `}  ${d.slug}  [${d.status}${d.component ? ` · ${d.component}` : ""}]` +
          (d.recurrence && d.canonical && d.canonical !== d.slug
            ? `  → canonical ${d.canonical}`
            : "") +
          `\n         ${d.title}`,
      ),
      "",
      "This is the COMPLETE candidate set for this filing, not a first page:",
      "clearing these cannot reveal more. Read them. Then either:",
      "  * add your evidence to the existing record:  brain append <slug> --type papercut",
      "  * or, if yours is genuinely different:        --not-duplicate-of <slug> (repeatable)",
      "  * or, having read all of the above:           --not-duplicate-of-any",
    ];
    if (canonicals.length > 0) {
      lines.push(
        "",
        "A CLOSED row above means the defect came back: its fix did not stick, or is not",
        "installed yet. Do not file a fresh row. Re-run this same command with",
        ...canonicals.map((c) => `  --reopen ${c}`),
        "to add this filing to that row as a `reconfirmed` evidence block and reopen it.",
        "--not-duplicate-of-any does NOT clear a recurrence; only --not-duplicate-of <slug> does.",
      );
    }
    // A refusal that follows a `--not-duplicate-of` must say what the flags
    // DID. On 2026-09-06 a filer cleared all 10 named candidates and was
    // refused with the same 10, and the refusal text gave no way to tell "the
    // flag was ignored" from "the slugs did not match": both read as the
    // identical wall. Naming the cleared count and the unmatched slugs makes
    // the next occurrence self-diagnosing.
    if (clearing) lines.push("", clearing.line);
    if (opts.json) {
      print(
        JSON.stringify({
          action: "duplicate_blocked",
          slug,
          component,
          symptom_hash: hash,
          duplicates,
          ...(canonicals.length > 0 ? { reopen: canonicals } : {}),
          ...(clearing ? { cleared: clearing.cleared, cleared_unmatched: clearing.unmatched } : {}),
        }),
      );
    } else {
      print(lines.join("\n"));
    }
    return {
      action: "duplicate_blocked",
      slug,
      component,
      symptom_hash: hash,
      duplicates,
      ...(canonicals.length > 0 ? { reopen: canonicals } : {}),
      ...(clearing ? { cleared: clearing.cleared, cleared_unmatched: clearing.unmatched } : {}),
    };
  }

  if (prior) {
    throw new FbrainError({
      code: "papercut_exists",
      message: `papercut ${slug} already exists (status: ${prior.status}).`,
      hint: isLivePapercutStatus(prior.status)
        ? "Use `brain append <slug> --type papercut` to add evidence, or pick a new slug."
        : `The row is closed. If the defect came back, re-run with \`--reopen ${slug}\` to add this filing as evidence and reopen it.`,
    });
  }

  // Write the bulk waiver into the record itself. `--force` would leave no
  // trace; this leaves the exact slugs, and wording a reader can distinguish
  // from the per-slug form above, so a later reconcile can re-judge the call.
  if (waived.length > 0) {
    materialized.body =
      `${materialized.body.trimEnd()}\n\nFiled with --not-duplicate-of-any after the gate raised ` +
      `${waived.length} candidate(s) in \`${component}\`, cleared as a set rather than ` +
      `individually: ${waived.map((s) => `[[${s}]]`).join(", ")}.\n`;
  }

  const record = materialized as FbrainRecord;
  const plan = await buildResidentWritePlan({
    node,
    cfg: opts.cfg,
    type: PAPERCUT,
    schemaHash,
    previous: null,
    next: record,
    primaryFields: materialized,
    now,
  });
  await commitResidentWritePlan({ node, plan, type: PAPERCUT, slug });

  // Same best-effort cross-type collision NOTE that `fbrain new` and
  // `fbrain put` emit on a create. `papercut file` did not, and that silence
  // is how the fleet accumulated 55 slugs holding BOTH a `reference` (the
  // pre-2026-08-04 prose ledger record, closed and archived) and a `papercut`
  // (the typed row, `open`) — measured on the primary 2026-09-01, 55 of 58 in
  // component `lastgit`. Every one of those was filed through this verb, over
  // an ancestor it never mentioned. STDERR only, swallowed on error, so it can
  // neither fail the file nor perturb stdout/`--json`.
  const collisions = await findCrossTypeSlugCollisions(
    node,
    opts.cfg,
    PAPERCUT,
    slug,
  );
  const collisionNote = crossTypeSlugNote(PAPERCUT, slug, collisions);
  if (collisionNote) console.error(collisionNote);

  // The resident batch writes the primary row, the list row, and the status
  // row together. A missing list schema is the only case where this version
  // cannot include the list projection.
  const listIndexFailed = recordListEntryHash(opts.cfg) === null;
  if (opts.json) {
    print(
      JSON.stringify({
        action: "filed",
        slug,
        component,
        symptom_hash: hash,
        duplicates: [],
        waived,
        list_index_failed: listIndexFailed,
      }),
    );
  } else {
    print(
      `filed papercut ${slug}  [${component}/${severity}/${kind}]  symptom:${hash}`,
    );
    if (waived.length > 0) {
      print(
        `  --not-duplicate-of-any cleared ${waived.length} candidate(s), recorded in the body: ${waived.join(", ")}`,
      );
    }
    if (listIndexFailed) {
      print(
        "warning: the record persisted but the type-list index patch failed — it will not " +
          "appear in `papercut census` / `brain list` until `brain reindex --list-index` runs.",
      );
    }
  }
  return {
    action: "filed",
    slug,
    component,
    symptom_hash: hash,
    duplicates: [],
    waived,
  };
}

export type PapercutCloseOptions = {
  cfg: Config;
  slug: string;
  status: string;
  evidence: string;
  fixedBy?: string;
  verifiedBy?: string;
  duplicateOf?: string;
  /** Internal: also set the row's kind (used by `file --reopen`). */
  kind?: string;
  verbose?: Verbose;
  print?: (line: string) => void;
  json?: boolean;
};

export type PapercutCloseResult = {
  action: "papercut_closed";
  slug: string;
  from: string;
  to: string;
  /** Present when the slug also exists as a `reference` record. */
  twin?: PapercutTwinResult;
};

/** What `papercut close` did to the reference twin of a dual-typed slug. */
export type PapercutTwinResult = {
  type: "reference";
  from: string;
  to: string;
  /** False when the twin already carried the target status. */
  changed: boolean;
  /** After a change: the re-read agreed with the write. */
  persisted: boolean;
  /** After a change: the status the re-read returned. */
  reread?: string;
  /** Set when the twin could not be read; nothing was written to it. */
  error?: string;
};

/** The `reference` status a typed close implies, or null when it implies none. */
export const REFERENCE_TWIN_CLOSED = "archived";

/**
 * Typed `fixed`, `verified`, `wontfix` and `duplicate` all mean the reference
 * ledger's `archived`: measured 2026-08-18, every agreeing dual-typed pair on
 * the primary was one of those four against `archived` (27 + 13 + 1 rows),
 * and `open`/`partial` against `active` (33 + 7). `partial` stays live on
 * both sides on purpose — it means the body carries an unresolved half.
 */
export function referenceTwinStatusFor(typedStatus: string): string | null {
  return isLivePapercutStatus(typedStatus) && typedStatus !== "fixed"
    ? null
    : REFERENCE_TWIN_CLOSED;
}

async function closeReferenceTwin(opts: {
  node: ReturnType<typeof newWriteClientFromCfg>["node"];
  cfg: Config;
  slug: string;
  status: string;
  stamp: string;
  now: string;
  verbose?: Verbose;
}): Promise<PapercutTwinResult | null> {
  const target = referenceTwinStatusFor(opts.status);
  if (target === null) return null;
  if (opts.cfg.schemaHashes.reference === undefined) return null;
  const refHash = schemaHashFor("reference", opts.cfg);
  let twin: FbrainRecord | null;
  try {
    twin = await findBySlug(opts.node, "reference", refHash, opts.slug);
  } catch (error) {
    // The typed close is already committed. A twin read that fails must not
    // turn a successful close into an error, but it must not be silent either:
    // silence is how the two copies drifted for a month.
    return {
      type: "reference",
      from: "?",
      to: target,
      changed: false,
      persisted: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (twin === null) return null;
  if (twin.status === target) {
    return { type: "reference", from: twin.status, to: target, changed: false, persisted: true };
  }
  const patch = {
    status: target,
    body: `${twin.body.replace(/\s+$/, "")}\n${opts.stamp}`,
    updated_at: opts.now,
  };
  const primaryFields = updateFieldsFrom(twin, "reference", patch);
  const next = { ...twin, ...patch } as FbrainRecord;
  const plan = await buildResidentWritePlan({
    node: opts.node,
    cfg: opts.cfg,
    type: "reference",
    schemaHash: refHash,
    previous: twin,
    next,
    primaryFields,
    now: opts.now,
  });
  await commitResidentWritePlan({
    node: opts.node,
    plan,
    type: "reference",
    slug: opts.slug,
  });
  // Verify-after-write with the full point-read retry budget. The defect on
  // record (papercut-brain-status-write-reports-a-transition-it-did-not-
  // persist-after-a-typed-close) is precisely a reference status write that
  // printed its transition and re-read as `active`, so this verb does not
  // print one it has not re-read.
  const seen = await withReadRetry(
    () => findBySlug(opts.node, "reference", refHash, opts.slug),
    (r) => r !== null && r.status === target,
  );
  const reread = seen?.status ?? "(missing)";
  return {
    type: "reference",
    from: twin.status,
    to: target,
    changed: true,
    persisted: reread === target,
    reread,
  };
}

// The whole point of this command: ONE call performs both writes. The prose
// ledger required two (`brain append` for the evidence, `brain status` for the
// field) and runs routinely did the first and forgot the second — 40 of 107
// records on 2026-08-04. A closure that cannot be half-applied cannot drift.
export async function papercutCloseCmd(
  opts: PapercutCloseOptions,
): Promise<PapercutCloseResult> {
  const print = resolvePrintSink(opts);
  const slug = normalizeSlug(opts.slug);
  const status = ensurePapercutStatus(opts.status);
  const fixedBy = opts.fixedBy ?? "";
  const verifiedBy = opts.verifiedBy ?? "";
  const duplicateOf = opts.duplicateOf ?? "";
  ensureVerificationEvidence(status, verifiedBy);
  ensureDuplicateTarget(status, duplicateOf);
  if (opts.evidence.trim().length === 0) {
    throw new FbrainError({
      code: "missing_evidence",
      message: "--evidence is required: what you did and what you observed.",
    });
  }

  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);
  const schemaHash = schemaHashFor(PAPERCUT, opts.cfg);
  const only = await resolveBySlug({
    node,
    cfg: opts.cfg,
    slug,
    type: PAPERCUT,
    recoveryVerb: "papercut close",
  });
  const record = only.record;
  const from = record.status;
  const now = nowIso();

  const stamp = [
    "",
    `## ${status} — ${now.slice(0, 10)}`,
    "",
    opts.evidence.trim(),
    fixedBy ? `\nFixed-by: ${fixedBy}` : "",
    verifiedBy ? `Verified-by: ${verifiedBy}` : "",
    duplicateOf ? `Duplicate-of: [[${normalizeSlug(duplicateOf)}]]` : "",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");

  const patch: Record<string, unknown> = {
    status,
    body: `${record.body.replace(/\s+$/, "")}\n${stamp}`,
    updated_at: now,
  };
  if (fixedBy) patch.fixed_by = fixedBy;
  if (verifiedBy) patch.verified_by = verifiedBy;
  if (duplicateOf) patch.duplicate_of = normalizeSlug(duplicateOf);
  if (opts.kind) patch.kind = ensureKind(opts.kind);

  const transitioned = { ...record, ...patch } as FbrainRecord;
  const primaryFields = updateFieldsFrom(record, PAPERCUT, patch);
  const plan = await buildResidentWritePlan({
    node,
    cfg: opts.cfg,
    type: PAPERCUT,
    schemaHash,
    previous: record,
    next: transitioned,
    primaryFields,
    now,
  });
  await commitResidentWritePlan({ node, plan, type: PAPERCUT, slug });

  // The reference twin, in the SAME verb. Measured 2026-08-18 on the
  // `papercut-lastdb-*` family: 3 of 84 dual-typed slugs read typed-CLOSED x
  // reference-ACTIVE, every one of them closed through this verb and then
  // hand-written on the reference side as a separate `brain status`, which is
  // the step a run can forget and the write that was observed not to persist
  // when it followed this one. The `papercut-lastgit-*` family drifted 92 of
  // 121 the OTHER way for the mirror-image reason. Writing the twin here
  // removes both the step and the ordering.
  const twin = await closeReferenceTwin({
    node,
    cfg: opts.cfg,
    slug,
    status,
    stamp,
    now,
    verbose: opts.verbose,
  });

  if (opts.json) {
    print(
      JSON.stringify({
        action: "papercut_closed",
        slug,
        from,
        to: status,
        ...(twin ? { twin } : {}),
      }),
    );
  } else {
    print(`papercut ${slug}: ${from} → ${status}`);
    if (twin && twin.changed) print(`reference ${slug}: ${twin.from} → ${twin.to}`);
    else if (twin) print(`reference ${slug}: already ${twin.to}, left as is`);
    if (twin && twin.changed && !twin.persisted) {
      print(
        `warning: reference ${slug} re-read as "${twin.reread}" after the write; ` +
          `re-run \`brain status ${slug} ${twin.to} --type reference\` and re-read it.`,
      );
    }
    if (twin?.error) {
      print(
        `warning: the reference twin of ${slug} could not be read (${twin.error}); ` +
          `its status was NOT written. Close it with \`brain status ${slug} archived --type reference\`.`,
      );
    }
  }
  return {
    action: "papercut_closed",
    slug,
    from,
    to: status,
    ...(twin ? { twin } : {}),
  };
}

export type PapercutCensusOptions = {
  cfg: Config;
  component?: string;
  /**
   * Accepted and ignored: serving records from the index payload snapshot is
   * now the default for `census`. Kept so callers that opted in still parse.
   */
  fast?: boolean;
  /**
   * Point-read every record and re-check it against its partition, instead of
   * counting from the index snapshot. The only reading that catches a record
   * whose status moved without the index following; costs one node request per
   * row.
   */
  pointRead?: boolean;
  verbose?: Verbose;
  print?: (line: string) => void;
  json?: boolean;
};

export type PapercutCensusRow = {
  component: string;
  open: number;
  partial: number;
  fixed: number;
  verified: number;
  wontfix: number;
  duplicate: number;
  live: number;
  total: number;
};

export function buildCensus(
  records: readonly FbrainRecord[],
  component?: string,
): PapercutCensusRow[] {
  const byComponent = new Map<string, PapercutCensusRow>();
  for (const r of records) {
    const c =
      typeof r.component === "string" && r.component.length > 0
        ? r.component
        : "(unset)";
    if (component !== undefined && c !== component) continue;
    let row = byComponent.get(c);
    if (!row) {
      row = {
        component: c,
        open: 0,
        partial: 0,
        fixed: 0,
        verified: 0,
        wontfix: 0,
        duplicate: 0,
        live: 0,
        total: 0,
      };
      byComponent.set(c, row);
    }
    // Only tally statuses the census actually has a column for. An unknown
    // status (a hand-written row, or a value from a future enum this binary
    // predates) is still counted in `total`, so the columns can never silently
    // sum to less than the total without the total saying so.
    const counts = row as unknown as Record<string, number | undefined>;
    const current = counts[r.status];
    if (typeof current === "number") counts[r.status] = current + 1;
    if (isLivePapercutStatus(r.status)) row.live += 1;
    row.total += 1;
  }
  return [...byComponent.values()].sort(
    (a, b) => b.live - a.live || a.component.localeCompare(b.component),
  );
}

// Every count prints its method. This is a rule the corpus paid for: an
// instrument that reports a number without saying how it got it is how a
// 44.5% win got reported as a 2.2% regression, and how a truncated
// enumeration got copied into durable memory as a fact.
//
// `buildCensus` reads exactly two fields off each record: `component` and
// `status`. Both are written only by verbs that go through the resident write
// plan (`papercut file`, `papercut close`, `put`, `status`), and that plan
// patches this index in the same write. So the snapshot cannot lag on either
// one, and the census does not need a point read to be correct. Measured on
// the primary over all 2230 common open rows on 2026-09-04, snapshot against
// point read: `component` and `status` disagreed on ZERO rows, while
// `updated_at` disagreed on 1044 (46.8%) and `tags` on 5 — the two fields
// `brain append` and `brain tag` used to write without patching the index, and
// the two fields the census never reads.
//
// The point read remains available as `--point-read`, because it is the only
// reading that can catch a record whose status moved WITHOUT this index
// following. That is a repair-detection check, not a counting method, and it
// costs one node request per row: 2977 requests and 141.8s against 3.3s for
// the same ledger on the same primary. Charging every caller of `census` that
// price to run an index audit made the ledger's own sizing instrument more
// expensive than the thing it sizes — `Papercut` is a top-five lifetime
// consumer on the node — so the audit is opt-in and the count is not.
export const CENSUS_METHOD =
  "method: status-keyed papercut index (one keyed partition per status, no papercut enumeration), " +
  "component and status read from the index payload snapshot, which the resident write plan " +
  "patches on every write of either field (no point reads); " +
  "run --point-read to re-read every record and catch a status the index did not follow; " +
  "live = open+partial+fixed";

/** The audit reading: every record point-read and re-checked against its partition. */
export const CENSUS_METHOD_POINT_READ =
  "method: status-keyed papercut index (one keyed partition per status, no papercut enumeration), " +
  "every record point-read and re-checked against its partition (--point-read); " +
  "live = open+partial+fixed";

/**
 * @param pointRead re-read every record instead of counting from the snapshot.
 */
export function censusMethod(pointRead: boolean): string {
  return pointRead ? CENSUS_METHOD_POINT_READ : CENSUS_METHOD;
}

export async function papercutCensusCmd(
  opts: PapercutCensusOptions,
): Promise<void> {
  const print = resolvePrintSink(opts);
  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);
  // The count is served from the index snapshot unless the caller asks for the
  // audit reading. `opts.fast` stays accepted so existing callers that opted
  // in to the snapshot keep working; it now names the default.
  const pointRead = opts.pointRead === true;
  const method = censusMethod(pointRead);
  const records = await readPapercutsByStatus(node, opts.cfg, undefined, {
    fast: !pointRead,
  });
  const rows = buildCensus(records, opts.component);

  if (opts.json) {
    print(JSON.stringify({ rows, method, scanned: records.length }));
    return;
  }
  if (rows.length === 0) {
    print("no papercuts");
    print(method);
    return;
  }
  const header =
    "component            live  open part  fix  ver  wont  dup total";
  const lines = rows.map(
    (r) =>
      `${r.component.padEnd(20)} ${String(r.live).padStart(4)} ${String(r.open).padStart(5)} ` +
      `${String(r.partial).padStart(4)} ${String(r.fixed).padStart(4)} ${String(r.verified).padStart(4)} ` +
      `${String(r.wontfix).padStart(5)} ${String(r.duplicate).padStart(4)} ${String(r.total).padStart(5)}`,
  );
  print([header, ...lines, "", method].join("\n"));
}

// The row filters `list` applies. This is ONE table because the defect it
// closes is a filter that was parsed and then never passed on: `<component>`
// in August 2026, and `--severity`/`--kind`/`--repo`/`--tag` until
// 2026-09-04. Each was accepted by the CLI's strict parser, named as valid by
// that parser's own unknown-option hint, and then dropped without a word — so
// a triage run that asked for the p0 rows was served all 2144 open rows and
// had nothing in the output to tell it apart from a real answer.
//
// A key added here must also be filtered by `buildPapercutList`, named by
// `listFilterClause`, and consumed by the CLI's `list` flag table. The guard
// tests assert all four, so a new filter cannot be half-wired the way these
// four were.
export type PapercutListFilters = {
  component?: string;
  status?: string;
  severity?: string;
  kind?: string;
  repo?: string;
  /** A row matches when it carries EVERY tag given, not any of them. */
  tags?: readonly string[];
};

/** The filter keys, in the order the method line names them. */
export const PAPERCUT_LIST_FILTERS = [
  "component",
  "status",
  "severity",
  "kind",
  "repo",
  "tags",
] as const;

export type PapercutListOptions = PapercutListFilters & {
  cfg: Config;
  /**
   * Slug + status partition only, no record hydrate. For queue consumers that
   * re-verify on their own point-get. See `readPapercutSlugsByStatus`.
   */
  indexOnly?: boolean;
  /**
   * Accepted and ignored: serving records from the index payload snapshot is
   * now the default for `list` too. Kept so callers that opted in still parse,
   * and still refused alongside `--body-resolved`, where it asks for a reading
   * that filter cannot use.
   */
  fast?: boolean;
  /**
   * Point-read every record and re-check it against its partition, instead of
   * reading it from the index payload snapshot. The only reading that catches
   * a record whose header moved without the index following; costs one node
   * request per row.
   */
  pointRead?: boolean;
  /**
   * Keep only the rows whose BODY claims a resolution the typed status does
   * not carry. Forces point reads; refuses `--fast` and `--index-only`.
   */
  bodyResolved?: boolean;
  verbose?: Verbose;
  print?: (line: string) => void;
  json?: boolean;
};

// One row per papercut, carrying every stored header field.
//
// The prior implementation delegated to the generic record lister with
// `type: "papercut"`, whose projection is seven generic columns
// (type/slug/status/tags/title/created_at/updated_at). That dropped
// `component`, `severity`, `kind`, `repo`, `fixed_by`, `verified_by`,
// `symptom_hash` and `duplicate_of` with no partial-projection marker, so a
// consumer read a missing field as an empty one. Those are exactly the fields
// the shared routine procedure (`papercut-ledger-hygiene.md`) directs every
// chief-engineer run to audit — `close --status verified` goes out of its way
// to REQUIRE `--verified-by` and to reject a bare merge reference, and then the
// only survey reader could not show whether it was ever supplied. An audit run
// through the old listing concluded "no routine populates these" no matter how
// many did.
export type PapercutListRow = {
  slug: string;
  title: string;
  status: string;
  component: string;
  severity: string;
  kind: string;
  repo: string;
  fixed_by: string;
  verified_by: string;
  duplicate_of: string;
  symptom_hash: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  /**
   * Present ONLY under `--body-resolved`, and only on rows that matched: the
   * body line claiming a resolution the typed `status` does not carry. It is a
   * CANDIDATE marker for a live re-check, never a verdict — see
   * `bodyResolutionClaim`.
   */
  body_claim?: BodyResolutionClaim;
  /**
   * Present ONLY under `--body-resolved`, on a live row whose body names
   * `Closes-when:` children that ALL read closed. A CANDIDATE, never a
   * verdict — see `closesWhenClaim`.
   */
  closes_when?: ClosesWhenClaim;
};

function str(record: FbrainRecord, field: string): string {
  const v = record[field];
  return typeof v === "string" ? v : "";
}

function componentOf(record: FbrainRecord): string {
  const c = str(record, "component");
  return c.length > 0 ? c : "(unset)";
}

/**
 * A resolution claim the record makes about ITSELF, in its own body.
 *
 * The ledger predates the typed `status` column, so a run that fixed a defect
 * wrote its verdict as prose — `Status: FIXED`, `Verified: <live check>` — and
 * the typed header stayed wherever the record was filed. Measured on the
 * primary 2026-09-05: of the 16 open rows carrying a `fixed_by` header, 11
 * said `Status: FIXED` AND carried a `Verified:` line while the typed status
 * still read `open`, the oldest since 2026-08-05. `papercut list --status
 * open` and `papercut census` both rank on the typed field, so those counted
 * as outstanding defect load in every reader, and nothing compared the two —
 * which is what made them invisible as closure candidates for a month.
 *
 * `**FIXED**` is in the corpus, so the markers tolerate emphasis and the list
 * or quote prefixes a Markdown body puts in front of a line.
 */
export type BodyResolutionClaim = {
  /** `verified` asserts a live re-check; `fixed` asserts only a merge. */
  level: "verified" | "fixed";
  /** The line that matched, so a reader can show its own evidence. */
  line: string;
};

const BODY_STATUS_CLAIM =
  /^[\s>#*-]*Status:\s*\**\s*(FIXED|VERIFIED|RESOLVED)\b/i;
const BODY_VERIFIED_CLAIM = /^[\s>#*-]*Verified(?:-by)?:\s*\**\s*\S/i;

/** The strongest resolution claim the body makes, or null if it makes none. */
export function bodyResolutionClaim(body: unknown): BodyResolutionClaim | null {
  if (typeof body !== "string" || body.length === 0) return null;
  let fixed: string | null = null;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (BODY_VERIFIED_CLAIM.test(line)) return { level: "verified", line };
    const m = BODY_STATUS_CLAIM.exec(line);
    if (m === null) continue;
    // A `Status:` line naming VERIFIED is itself a live-check claim.
    if ((m[1] ?? "").toUpperCase() === "VERIFIED")
      return { level: "verified", line };
    // Keep the FIRST fixed claim but keep scanning: a `Verified:` line later
    // in the same closing block outranks it, and the two usually sit together.
    if (fixed === null) fixed = line;
  }
  return fixed === null ? null : { level: "fixed", line: fixed };
}

/**
 * The typed statuses a body claim cannot improve on. `wontfix` and `duplicate`
 * are deliberate terminal decisions and `verified` is already the strongest
 * state, so a resolution line under any of them is consistent, not stale.
 */
const PAPERCUT_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "verified",
  "wontfix",
  "duplicate",
]);

/**
 * True when the body asserts a state the typed header does not.
 *
 * `partial` is excluded deliberately, and it is the exclusion worth stating:
 * `partial` MEANS the body carries a resolved half and an unresolved one
 * (`PAPERCUT_STATUSES`: "some of it repaired, some still open — say which in
 * the body"), so a resolution line inside one is expected and says nothing
 * about the record as a whole. Reporting those would bury the real finding
 * under rows behaving exactly as documented.
 *
 * `fixed` plus a `verified` claim IS reported. `fixed` means "merged, NOT yet
 * re-measured", so a body that already records a live check is one
 * `papercut close --status verified` away with its evidence written down.
 */
export function bodyClaimOutranksStatus(
  claim: BodyResolutionClaim | null,
  status: string,
): boolean {
  if (claim === null) return false;
  if (PAPERCUT_TERMINAL_STATUSES.has(status)) return false;
  if (status === "open") return true;
  if (status === "fixed") return claim.level === "verified";
  return false;
}

/** The claim to report for a row, or null when the row is not a candidate. */
export function staleClosureClaim(
  record: FbrainRecord,
): BodyResolutionClaim | null {
  const claim = bodyResolutionClaim(record.body);
  return bodyClaimOutranksStatus(claim, record.status) ? claim : null;
}

/**
 * `Closes-when: <slug>` — a record whose status is a FUNCTION of another's.
 *
 * A record that fixes most of itself and splits the last item out to a child
 * record keeps its own status `open`, and from that moment its true status is
 * "closed when the child is". No reader computed that: on 2026-08-18 a
 * `papercut-lastgit-*` parent stayed open for 3.5 h after its child was
 * verified and surfaced as the stalest genuinely-open record in its family,
 * consuming the audit budget that exists to find real work. The convention
 * shipped that day as prose; this is the reader for it.
 *
 * Forms accepted, one per line, any Markdown prefix:
 *   Closes-when: [[child-slug]]
 *   Closes-when: child-slug
 *   Closes-when: [[a]], [[b]]        (ALL must be closed)
 */
const BODY_CLOSES_WHEN = /^[\s>#*-]*Closes-when:\s*(.+)$/i;
const SLUG_TOKEN = /[a-z0-9][a-z0-9._-]*/gi;

export function closesWhenSlugs(body: unknown): string[] {
  if (typeof body !== "string" || body.length === 0) return [];
  const out: string[] = [];
  for (const raw of body.split("\n")) {
    const m = BODY_CLOSES_WHEN.exec(raw.trim());
    if (m === null) continue;
    // Strip wikilink brackets, then take every slug-shaped token. A trailing
    // clause ("— once #370 lands") is prose, not a slug, but any token in it
    // that looks like a slug would be read as one; keep the line to slugs.
    const text = (m[1] ?? "").replace(/\[\[|\]\]/g, " ");
    for (const tok of text.match(SLUG_TOKEN) ?? []) {
      if (tok.includes("-") && !out.includes(tok)) out.push(tok);
    }
  }
  return out;
}

/**
 * The statuses under which a child counts as closed for its parent. Both
 * ledgers' terminal states, because the child may live in either: a typed
 * papercut closes to `fixed`/`verified`/`wontfix`/`duplicate`, a legacy
 * reference record to `archived`.
 */
export const CHILD_CLOSED_STATUSES: ReadonlySet<string> = new Set([
  "fixed",
  "verified",
  "wontfix",
  "duplicate",
  "archived",
]);

export type ClosesWhenClaim = {
  /** Every child the record named, with the status each was read at. */
  children: { slug: string; status: string }[];
};

/**
 * The claim to report for a row whose every named child reads closed, or null.
 *
 * Only a live parent is a candidate: a terminal one has already been decided.
 * A child that could not be read (absent from `childStatus`) blocks the claim
 * rather than being skipped — an unread dependency is unknown, not satisfied.
 *
 * This is a CANDIDATE, not a closure, and more so than a body claim: the
 * child's status says the child's item is done, and only the child's FIX
 * says whether that covers the parent's item. The counter-example is on
 * record — the same command, same flag, adjacent sentences, different row
 * class — and it took a code read to see. So the reader surfaces the pair and
 * the operator reads the fix.
 */
export function closesWhenClaim(
  record: FbrainRecord,
  childStatus: ReadonlyMap<string, string>,
): ClosesWhenClaim | null {
  if (PAPERCUT_TERMINAL_STATUSES.has(record.status)) return null;
  const slugs = closesWhenSlugs(record.body);
  if (slugs.length === 0) return null;
  const children: { slug: string; status: string }[] = [];
  for (const slug of slugs) {
    const status = childStatus.get(slug);
    if (status === undefined || !CHILD_CLOSED_STATUSES.has(status)) return null;
    children.push({ slug, status });
  }
  return { children };
}

/**
 * Filter + order the ledger for `papercut list`.
 *
 * Ordering is **oldest `updated_at` first**, deliberately opposite to the
 * newest-first convention of the generic record lister. The documented consumer
 * of this reader is the reconcile loop in `papercut-ledger-hygiene.md` — "take
 * the two oldest active records you have not already reconciled today" — and a
 * newest-first sample is precisely the shape that forces that loop to reach for
 * a second reader. Every matching row is returned, so a caller wanting the
 * other order can just reverse it.
 */
/**
 * The ONE row-filter predicate. `buildPapercutList` applies it to the records
 * it renders, and `papercutListCmd` hands the same closure to the index reader
 * to pre-select candidates from the payload snapshot. They cannot disagree
 * about what a filter means, because there is only one of them.
 *
 * `status` is included for the rendering caller. Candidate narrowing
 * deliberately omits it: the partition key already selects the status, and the
 * reader's fail-closed check must stay free to catch a record whose status
 * moved without the index following.
 */
export function matchesPapercutFilters(
  r: FbrainRecord,
  opts: PapercutListFilters = {},
): boolean {
  const tags = Array.isArray(r.tags) ? r.tags : [];
  if (opts.component !== undefined && componentOf(r) !== opts.component)
    return false;
  if (opts.status !== undefined && r.status !== opts.status) return false;
  if (opts.severity !== undefined && str(r, "severity") !== opts.severity)
    return false;
  if (opts.kind !== undefined && str(r, "kind") !== opts.kind) return false;
  if (opts.repo !== undefined && str(r, "repo") !== opts.repo) return false;
  // AND, not any: `--tag read-path --tag cli` asks for the rows carrying
  // both. Any-semantics would widen the result as the caller narrows the
  // request, which is the shape of failure this whole change is about.
  if (opts.tags !== undefined && !opts.tags.every((t) => tags.includes(t)))
    return false;
  return true;
}

export function buildPapercutList(
  records: readonly FbrainRecord[],
  opts: PapercutListFilters = {},
  bodyResolved: boolean = false,
  /** Status of every `Closes-when:` child the caller could read, by slug. */
  childStatus: ReadonlyMap<string, string> = new Map(),
): PapercutListRow[] {
  const rows: PapercutListRow[] = [];
  for (const r of records) {
    const component = componentOf(r);
    const tags = Array.isArray(r.tags) ? r.tags : [];
    if (!matchesPapercutFilters(r, opts)) continue;
    // Deliberately NOT part of `matchesPapercutFilters`: that predicate is the
    // one handed to the index reader to pre-select candidates from the payload
    // snapshot, and this claim is read off `body`, the field an append writes.
    // Narrowing on it would decide from the snapshot the caller was refused.
    const claim = bodyResolved ? staleClosureClaim(r) : null;
    const dependency = bodyResolved ? closesWhenClaim(r, childStatus) : null;
    if (bodyResolved && claim === null && dependency === null) continue;
    rows.push({
      slug: r.slug,
      title: r.title,
      status: r.status,
      component,
      severity: str(r, "severity"),
      kind: str(r, "kind"),
      repo: str(r, "repo"),
      fixed_by: str(r, "fixed_by"),
      verified_by: str(r, "verified_by"),
      duplicate_of: str(r, "duplicate_of"),
      symptom_hash: str(r, "symptom_hash"),
      tags,
      created_at: r.created_at,
      updated_at: r.updated_at,
      ...(claim === null ? {} : { body_claim: claim }),
      ...(dependency === null ? {} : { closes_when: dependency }),
    });
  }
  return rows.sort(
    (a, b) =>
      a.updated_at.localeCompare(b.updated_at) || a.slug.localeCompare(b.slug),
  );
}

// Same rule as `CENSUS_METHOD`: a reader that reports rows without saying how
// it got them is how a 20-row cross-component sample got read as one family's
// ledger. This one also has to say what it is NOT — the old reader silently
// dropped its `<component>` positional, so the promise that the filter was
// actually applied is the load-bearing half of the line.
export const LIST_METHOD =
  "method: status-keyed papercut index (same read as `papercut census`), " +
  "every record point-read and re-checked against its partition (--point-read), " +
  "FILTERS, every matching row returned, oldest-updated first";

/**
 * The default listing, served from the snapshot the index already carries.
 *
 * `census` flipped to this reading on 2026-09-04 and `list` deliberately did
 * not, on one measured objection: `list` is ordered oldest-updated-first
 * because the reconcile loop consumes it in that order, and `updated_at` was
 * stale on 1044 of 2230 rows (46.8%) — it was the one field `brain append` and
 * `brain tag` wrote without patching this index.
 *
 * Those two verbs patch the index now, and the objection was re-measured on
 * the primary 2026-09-06 rather than assumed to still hold. Two readings, one
 * unfiltered pair and one controlled sandwich (fast, point-read, fast, so a
 * row written mid-window is excluded rather than counted as lag):
 *
 * | reading | rows | node requests | node service time |
 * |---|---|---|---|
 * | point-read, unfiltered | 3388 | 3404 | 2743.3s (199.4s wall) |
 * | snapshot, unfiltered   | 3389 |   10 |   21.7s (21.9s wall)  |
 * | point-read, --severity p0 | 274 | 290 | 369.8s |
 * | snapshot,   --severity p0 | 274 |  10 |  32.1s |
 *
 * Agreement, snapshot against point read, on the 273 of 274 sandwich rows that
 * did not change during the window: every stored field agreed — status,
 * severity, kind, component, repo, fixed_by, verified_by, duplicate_of, title,
 * tags, created_at, symptom_hash — and `updated_at` disagreed on ONE row
 * (0.37%, against 46.8% two days earlier). On the unfiltered pair, 2 of 3388
 * rows carried a snapshot `updated_at` older than the point read, both last
 * written 2026-09-04, i.e. residue from before the patch rather than new drift.
 *
 * So the ordering objection now costs the reconcile loop at most a couple of
 * positions, and the reading it was protecting cost 340x the node requests of
 * the one it rejected. `--point-read` keeps the audit reading, which is still
 * the only one that catches a header the index did not follow.
 */
export const LIST_METHOD_FAST =
  "method: status-keyed papercut index (same read as `papercut census`), " +
  "records read from the index payload snapshot, NOT point-read, " +
  "FILTERS, every matching row returned, " +
  "ordered by a possibly-stale updated_at — the header fields are current, " +
  "updated_at and tags can lag a write made before this index was last rebuilt; " +
  "run --point-read to re-read every record and catch a header the index did not follow";

// The old line said "component/status filters applied" as a fixed string, and
// that was accurate only for as long as those were the only two filters the
// reader could be given. It stayed on screen unchanged while four more were
// accepted and dropped. Naming the filters ACTUALLY applied, computed from the
// same table the row loop reads, is the half of the line a caller can check.
/**
 * The filters a payload snapshot may decide on its own.
 *
 * `status` is absent deliberately — see `matchesPapercutFilters`. Every field
 * here was measured against the point-read record on all 2252 open rows of the
 * primary on 2026-09-04 and disagreed on none; `updated_at`, the one field
 * that did drift, is not a filter and so cannot narrow anything.
 */
export const PAPERCUT_NARROWABLE_FILTERS = PAPERCUT_LIST_FILTERS.filter(
  (f) => f !== "status",
);

/** The filters that will actually pre-select candidates for this call. */
export function narrowingFilters(
  filters: PapercutListFilters,
): PapercutListFilters | null {
  const picked: PapercutListFilters = {};
  let any = false;
  for (const f of PAPERCUT_NARROWABLE_FILTERS) {
    const v = filters[f];
    if (v === undefined) continue;
    Object.assign(picked, { [f]: v });
    any = true;
  }
  return any ? picked : null;
}

export function listFilterClause(filters: PapercutListFilters): string {
  const applied = PAPERCUT_LIST_FILTERS.filter(
    (f) => filters[f] !== undefined,
  );
  return applied.length === 0
    ? "no filter given, every papercut returned"
    : `${applied.join("/")} filters applied`;
}

export function listMethod(
  fast: boolean,
  filters: PapercutListFilters = {},
  narrowed?: { fields: readonly string[]; rows: number; pointReads: number },
): string {
  const base = (fast ? LIST_METHOD_FAST : LIST_METHOD).replace(
    "FILTERS",
    listFilterClause(filters),
  );
  if (!narrowed) return base;
  // Say what was NOT read, and why that could be wrong. A reader who only
  // learns the command got faster cannot tell a narrowed answer from a
  // complete one, and this reader's whole contract is that it returns every
  // matching row.
  return (
    `${base}; candidates pre-selected from the index snapshot on ` +
    `${narrowed.fields.join("/")} (${narrowed.pointReads} of ${narrowed.rows} ` +
    `rows point-read) — a row whose snapshot disagrees on those fields is not read`
  );
}

// The index-only projection has to say what it did NOT do: the row's `status`
// is the partition key the slug was found under and was not re-verified
// against the record, and no header field beyond slug/status is present. A
// consumer that reads this as the hydrated ledger would treat a missing field
// as an empty one — the exact defect the hydrated row type exists to prevent.
export const LIST_INDEX_ONLY_METHOD =
  "method: status-keyed papercut index, index-only projection (slug + status partition; " +
  "records not hydrated, status not re-verified per record, no component filter), " +
  "status filter applied, every matching row returned, slug order";

/**
 * What `--body-resolved` did, appended to whichever method line applies.
 *
 * It has to say CANDIDATES out loud. A reader that saw a filtered list of rows
 * whose bodies say FIXED could reasonably flip them in bulk, and the whole
 * reason these rows are worth surfacing is that the live check was never
 * re-run — a body claiming verified is a hypothesis until someone re-measures.
 * This reader has no write path at all, by construction.
 */
export const LIST_METHOD_BODY_RESOLVED =
  "; --body-resolved: kept only rows whose BODY claims a resolution the typed " +
  "status does not carry (status open, or fixed carrying a live-check line), " +
  "and live rows whose body names `Closes-when:` children that ALL read " +
  "fixed/verified/wontfix/duplicate/archived (each child point-read; read the child's FIX before closing the parent); " +
  "records point-read because `body` is the field being matched — these are " +
  "CANDIDATES for a live re-check, NOT closures, and this reader never writes";

/**
 * Which reading `list` performs for a given invocation.
 *
 * Extracted so the DEFAULT is a tested property rather than an inline
 * condition. `census` flipped to the snapshot on 2026-09-04 and `list` did
 * not, and the two readers then disagreed on cost by two orders of magnitude
 * for two days without anything failing.
 *
 * @returns true to read rows from the index payload snapshot, false to
 * point-read every record and re-check it against its partition.
 */
export function listReadsSnapshot(opts: {
  pointRead?: boolean;
  bodyResolved?: boolean;
}): boolean {
  // `--body-resolved` matches the record BODY, which the snapshot lags for any
  // row appended to before the last index rebuild — and an append is exactly
  // the write that puts a closing block into a body.
  if (opts.bodyResolved === true) return false;
  return opts.pointRead !== true;
}

/**
 * Point-read every `Closes-when:` child the given records name, typed
 * papercut first and legacy reference second, and return the status each was
 * read at. A child absent from both ledgers is left out of the map, which
 * `closesWhenClaim` treats as unknown, not closed.
 */
export async function readClosesWhenChildren(
  node: ReturnType<typeof newWriteClientFromCfg>["node"],
  cfg: Config,
  records: readonly FbrainRecord[],
): Promise<Map<string, string>> {
  const wanted = new Set<string>();
  for (const r of records) for (const s of closesWhenSlugs(r.body)) wanted.add(s);
  const out = new Map<string, string>();
  if (wanted.size === 0) return out;
  const papercutHash = schemaHashFor(PAPERCUT, cfg);
  const referenceHash =
    cfg.schemaHashes.reference === undefined ? null : schemaHashFor("reference", cfg);
  await Promise.all(
    [...wanted].map(async (slug) => {
      const typed = await findBySlug(node, PAPERCUT, papercutHash, slug);
      if (typed !== null) {
        out.set(slug, typed.status);
        return;
      }
      if (referenceHash === null) return;
      const legacy = await findBySlug(node, "reference", referenceHash, slug);
      if (legacy !== null) out.set(slug, legacy.status);
    }),
  );
  return out;
}

export const LIST_MARK_MAX = 100;

/** Single-line, length-capped rendering for human mode only. */
export function elide(value: string, max: number = LIST_MARK_MAX): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export async function papercutListCmd(
  opts: PapercutListOptions,
): Promise<void> {
  // Refuse a bad flag COMBINATION before opening a client: an invocation
  // this reader cannot serve is a usage error, and it should not need a
  // reachable node to say so.
  const bodyResolved = opts.bodyResolved === true;
  // Refuse rather than silently degrade, the same way `--index-only` refuses a
  // filter it cannot serve. `--fast` CAN reach a body — `psi_payload` is a
  // snapshot of the whole record — which is exactly why this has to be an
  // explicit refusal instead of an absence: the snapshot lags `brain append`
  // for any row written before appends began patching this index, and an
  // append is precisely the write that puts a closing block into a body. The
  // rows a stale snapshot would drop are the newest and most interesting ones,
  // and dropping them is silent.
  if (bodyResolved && opts.fast === true) {
    throw new FbrainError({
      code: "papercut_list_body_resolved_needs_point_read",
      message:
        "`--body-resolved` matches the record body, and `--fast` serves bodies from the index payload snapshot, which lags exactly the appends this filter looks for.",
      hint: "Drop --fast. A row whose closing block was appended after the last index rebuild would be missed, and missing it is silent.",
    });
  }
  if (bodyResolved && opts.indexOnly === true) {
    throw new FbrainError({
      code: "papercut_list_index_only_no_body",
      message:
        "`--index-only` reads the status-keyed index without hydrating records, and `body` is a record field that projection does not carry.",
      hint: "Drop --index-only to get the hydrated ledger that --body-resolved can filter.",
    });
  }
  const print = resolvePrintSink(opts);
  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);
  if (opts.indexOnly) {
    // One keyed partition read, and not even a payload parse: this projection
    // is the slug/status pair a queue consumer re-verifies on its own point
    // get.
    // `--index-only` reads slug + status partition and nothing else, so every
    // other filter names a record field that is not present to filter on.
    // Refusing is the point: the previous release refused `component` here and
    // silently ignored the rest, which is the same accepted-and-dropped shape
    // this change exists to remove.
    const unservable = PAPERCUT_LIST_FILTERS.filter(
      (f) => f !== "status" && opts[f] !== undefined,
    );
    if (unservable.length > 0) {
      throw new FbrainError({
        code: "papercut_list_index_only_no_component",
        message: `\`--index-only\` reads the status-keyed index without hydrating records, and ${unservable.join(", ")} ${unservable.length === 1 ? "is a record field" : "are record fields"} the index does not carry.`,
        hint: "Drop --index-only to get the hydrated, filtered ledger, or drop the filter it cannot serve.",
      });
    }
    const rows = (
      await readPapercutSlugsByStatus(node, opts.cfg, opts.status)
    ).sort((a, b) => a.slug.localeCompare(b.slug));
    if (opts.json) {
      print(
        JSON.stringify({
          rows,
          total: rows.length,
          method: LIST_INDEX_ONLY_METHOD,
        }),
      );
      return;
    }
    for (const r of rows) print(`${r.status.padEnd(9)} ${r.slug}`);
    print(`${rows.length} row(s)`);
    print(LIST_INDEX_ONLY_METHOD);
    return;
  }
  // Read one status partition when the caller named one; the whole ledger
  // otherwise. `readPapercutsByStatus` is the same complete reader `census`
  // uses, so list and census are two views of ONE read and cannot disagree.
  // See LIST_METHOD_FAST for why the snapshot is the default reading.
  const fast = listReadsSnapshot({ pointRead: opts.pointRead, bodyResolved });
  const filters: PapercutListFilters = {};
  for (const f of PAPERCUT_LIST_FILTERS) {
    const v = opts[f];
    if (v !== undefined) Object.assign(filters, { [f]: v });
  }
  // Narrow on the record-field filters, then filter AGAIN on what came back.
  // The second pass is what makes a wrongly-including snapshot harmless: it
  // costs one point read, not a wrong row.
  const narrowBy = narrowingFilters(filters);
  const stats = newPapercutReadStats();
  const records = await readPapercutsByStatus(node, opts.cfg, opts.status, {
    fast,
    narrow: narrowBy
      ? (record) => matchesPapercutFilters(record, narrowBy)
      : undefined,
    stats,
  });
  const baseMethod = listMethod(
    fast,
    filters,
    narrowBy
      ? {
          fields: Object.keys(narrowBy),
          rows: stats.rows,
          pointReads: stats.pointReads,
        }
      : undefined,
  );
  // `Closes-when:` children are point-read, in either ledger, only under
  // --body-resolved: that is the reading that already paid for every body.
  const childStatus = bodyResolved
    ? await readClosesWhenChildren(node, opts.cfg, records)
    : new Map<string, string>();
  const rows = buildPapercutList(records, filters, bodyResolved, childStatus);
  const method = bodyResolved ? `${baseMethod}${LIST_METHOD_BODY_RESOLVED}` : baseMethod;

  if (opts.json) {
    print(JSON.stringify({ rows, total: rows.length, method }));
    return;
  }
  if (rows.length === 0) {
    print("no papercuts");
    print(method);
    return;
  }
  const header = "status    sev  component     slug";
  const lines: string[] = [];
  const indent = " ".repeat(30);
  for (const r of rows) {
    lines.push(
      `${r.status.padEnd(9)} ${r.severity.padEnd(4)} ${r.component.padEnd(13)} ${r.slug}`,
    );
    if (r.title) lines.push(`${indent}${r.title}`);
    // Closure provenance is the point of the ledger; show it where it exists
    // rather than making every audit re-read each record to find out.
    //
    // `verified_by` holds a full live-check transcript by design — the close
    // verb demands one — and several run past 500 characters, which makes a
    // scan of 115 rows unreadable. Human mode elides; --json carries the whole
    // value, so the audit path loses nothing.
    const marks: string[] = [];
    if (r.fixed_by) marks.push(`fixed-by: ${elide(r.fixed_by)}`);
    if (r.verified_by) marks.push(`verified-by: ${elide(r.verified_by)}`);
    if (r.duplicate_of) marks.push(`duplicate-of: ${r.duplicate_of}`);
    if (marks.length > 0) lines.push(`${indent}[${marks.join(" · ")}]`);
    // The matched line IS the finding. A row listed without it just asserts
    // that some rule fired, and the operator has to re-read the record to see
    // what for.
    if (r.body_claim)
      lines.push(
        `${indent}body claims ${r.body_claim.level}: ${elide(r.body_claim.line)}`,
      );
    if (r.closes_when)
      lines.push(
        `${indent}closes-when: ${r.closes_when.children
          .map((c) => `[[${c.slug}]] is ${c.status}`)
          .join(", ")} — read the child's fix before closing`,
      );
  }
  print([header, ...lines, "", `${rows.length} row(s)`, method].join("\n"));
}
