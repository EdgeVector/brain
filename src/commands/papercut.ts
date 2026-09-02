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
  type FbrainRecord,
} from "../record.ts";
import { findCmd, type FindHit } from "./find.ts";
import { newWriteClientFromCfg } from "../write-context.ts";
import { recordListEntryHash } from "../record-list-index.ts";
import { readPapercutsByStatus } from "../papercut-status-index.ts";
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

export type DuplicateCandidate = {
  slug: string;
  title: string;
  status: string;
  score: number;
  exact: boolean;
};

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

export function semanticDuplicateCandidates(
  hits: readonly FindHit[],
  opts: { component: string; exactSlug?: string },
): DuplicateCandidate[] {
  const candidates: DuplicateCandidate[] = [];
  for (const hit of hits) {
    const record = hit.record;
    // Only live records gate a new filing. A `verified` papercut that comes
    // back is a RECONFIRMATION and deserves its own record (kind:
    // `reconfirmed`) — folding it into the closed one would hide a regression
    // inside a record that says the defect is gone.
    if (!isLivePapercutStatus(record.status)) continue;
    if (
      typeof record.component === "string" &&
      record.component !== opts.component
    ) {
      continue;
    }
    const exact = record.slug === opts.exactSlug;
    const score = exact ? 1 : hit.maxSimilarity;
    if (exact || score >= SEMANTIC_DUPLICATE_THRESHOLD) {
      candidates.push({
        slug: record.slug,
        title: record.title,
        status: record.status,
        score,
        exact,
      });
    }
  }
  return candidates.sort((a, b) => b.score - a.score);
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
  verbose?: Verbose;
  print?: (line: string) => void;
  json?: boolean;
};

export type PapercutFileResult = {
  action: "filed" | "duplicate_blocked";
  slug: string;
  component: string;
  symptom_hash: string;
  duplicates: DuplicateCandidate[];
  idempotent?: boolean;
};

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
          limit: SEMANTIC_DUPLICATE_LIMIT,
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
  const duplicates = semanticDuplicateCandidates(semanticHits, {
    component,
    exactSlug: slug,
  }).filter((c) => !cleared.has(c.slug));

  if (duplicates.length > 0) {
    const lines = [
      `Possible duplicate: ${duplicates.length} live papercut(s) in \`${component}\` may already describe this.`,
      "",
      ...duplicates.map(
        (d) =>
          `  ${d.exact ? "EXACT" : `${Math.round(d.score * 100)}%  `}  ${d.slug}  [${d.status}]\n         ${d.title}`,
      ),
      "",
      "Read them. Then either:",
      "  * add your evidence to the existing record:  brain append <slug> --type papercut",
      "  * or, if yours is genuinely different:        --not-duplicate-of <slug> (repeatable)",
    ];
    if (opts.json) {
      print(
        JSON.stringify({
          action: "duplicate_blocked",
          slug,
          component,
          symptom_hash: hash,
          duplicates,
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
    };
  }

  if (prior) {
    throw new FbrainError({
      code: "papercut_exists",
      message: `papercut ${slug} already exists (status: ${prior.status}).`,
      hint: "Use `brain append <slug> --type papercut` to add evidence, or pick a new slug.",
    });
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
        list_index_failed: listIndexFailed,
      }),
    );
  } else {
    print(
      `filed papercut ${slug}  [${component}/${severity}/${kind}]  symptom:${hash}`,
    );
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
  verbose?: Verbose;
  print?: (line: string) => void;
  json?: boolean;
};

export type PapercutCloseResult = {
  action: "papercut_closed";
  slug: string;
  from: string;
  to: string;
};

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

  if (opts.json) {
    print(
      JSON.stringify({ action: "papercut_closed", slug, from, to: status }),
    );
  } else {
    print(`papercut ${slug}: ${from} → ${status}`);
  }
  return { action: "papercut_closed", slug, from, to: status };
}

export type PapercutCensusOptions = {
  cfg: Config;
  component?: string;
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
export const CENSUS_METHOD =
  "method: status-keyed papercut index (one keyed partition per status, no papercut enumeration); " +
  "live = open+partial+fixed";

export async function papercutCensusCmd(
  opts: PapercutCensusOptions,
): Promise<void> {
  const print = resolvePrintSink(opts);
  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);
  const records = await readPapercutsByStatus(node, opts.cfg);
  const rows = buildCensus(records, opts.component);

  if (opts.json) {
    print(
      JSON.stringify({ rows, method: CENSUS_METHOD, scanned: records.length }),
    );
    return;
  }
  if (rows.length === 0) {
    print("no papercuts");
    print(CENSUS_METHOD);
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
  print([header, ...lines, "", CENSUS_METHOD].join("\n"));
}

export type PapercutListOptions = {
  cfg: Config;
  component?: string;
  status?: string;
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
};

function str(record: FbrainRecord, field: string): string {
  const v = record[field];
  return typeof v === "string" ? v : "";
}

export function componentOf(record: FbrainRecord): string {
  const c = str(record, "component");
  return c.length > 0 ? c : "(unset)";
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
export function buildPapercutList(
  records: readonly FbrainRecord[],
  opts: { component?: string; status?: string } = {},
): PapercutListRow[] {
  const rows: PapercutListRow[] = [];
  for (const r of records) {
    const component = componentOf(r);
    if (opts.component !== undefined && component !== opts.component) continue;
    if (opts.status !== undefined && r.status !== opts.status) continue;
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
      tags: Array.isArray(r.tags) ? r.tags : [],
      created_at: r.created_at,
      updated_at: r.updated_at,
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
  "method: status-keyed papercut index with batched hydrate (same read as `papercut census`), " +
  "component/status filters applied, every matching row returned, oldest-updated first";

export const LIST_MARK_MAX = 100;

/** Single-line, length-capped rendering for human mode only. */
export function elide(value: string, max: number = LIST_MARK_MAX): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export async function papercutListCmd(
  opts: PapercutListOptions,
): Promise<void> {
  const print = resolvePrintSink(opts);
  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);
  // Read one status partition when the caller named one; the whole ledger
  // otherwise. `readPapercutsByStatus` is the same complete reader `census`
  // uses, so list and census are two views of ONE read and cannot disagree.
  const records = await readPapercutsByStatus(node, opts.cfg, opts.status);
  const listOpts: { component?: string; status?: string } = {};
  if (opts.component !== undefined) listOpts.component = opts.component;
  if (opts.status !== undefined) listOpts.status = opts.status;
  const rows = buildPapercutList(records, listOpts);

  if (opts.json) {
    print(JSON.stringify({ rows, total: rows.length, method: LIST_METHOD }));
    return;
  }
  if (rows.length === 0) {
    print("no papercuts");
    print(LIST_METHOD);
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
  }
  print(
    [header, ...lines, "", `${rows.length} row(s)`, LIST_METHOD].join("\n"),
  );
}
