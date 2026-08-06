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
  findBySlug,
  listRecords,
  normalizeSlug,
  nowIso,
  resolveBySlug,
  schemaHashFor,
  updateFieldsFrom,
  type FbrainRecord,
} from "../record.ts";
import { newWriteClientFromCfg } from "../write-context.ts";
import { maintainTypeListIndex } from "../record-list-index.ts";
import {
  ensureComponent,
  ensureDuplicateTarget,
  ensureKind,
  ensurePapercutStatus,
  ensureSeverity,
  ensureVerificationEvidence,
  isLivePapercutStatus,
  normalizeSymptom,
  symptomHash,
} from "../papercut.ts";

const PAPERCUT: "papercut" = "papercut";

// Token-overlap threshold for the near-duplicate gate. Deliberately
// advisory-with-teeth: it BLOCKS the file and names the candidates, and
// `--not-duplicate-of` is how you say "I read them, this is different" — a
// decision that then lives in the record.
export const NEAR_DUPLICATE_THRESHOLD = 0.6;

// Floor on the absolute number of shared tokens. The overlap coefficient below
// divides by the SHORTER text, so without this a three-word symptom fully
// contained in a long title scores 1.0 and blocks everything.
export const NEAR_DUPLICATE_MIN_SHARED_TOKENS = 4;

export type DuplicateCandidate = {
  slug: string;
  title: string;
  status: string;
  score: number;
  exact: boolean;
};

function tokenSet(text: string): Set<string> {
  return new Set(normalizeSymptom(text).split(" ").filter((t) => t.length > 2));
}

// OVERLAP COEFFICIENT (shared / size of the shorter side), not Jaccard.
//
// Jaccard was the first implementation and it had a property that would have
// quietly defeated the whole gate: it divides by the UNION, so every extra
// token in the stored record's body pushes the score down. Measured on the
// worked example — a one-line symptom against a real record — Jaccard scored
// the same paraphrase 0.529 against title+body and 0.750 against the title
// alone. The better-documented a papercut was, the less likely it would catch
// its own duplicate. That is precisely the shape of instrument defect this
// ledger exists to record, so it does not get to ship inside it.
//
// Dividing by the shorter side removes the length coupling. The floor on
// absolute shared tokens (above) covers the failure the change introduces.
//
// Chosen over an embedding call on purpose: this runs on every file, must be
// deterministic for tests, and must not fail the write path when the search
// service is unreachable. It is the SECOND net — the exact `symptom_hash`
// match is the first — and neither is claimed to be complete.
export function similarity(a: string, b: string): number {
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  if (shared < NEAR_DUPLICATE_MIN_SHARED_TOKENS) return 0;
  return shared / Math.min(ta.size, tb.size);
}

// The `Symptom:` line `papercutFileCmd` writes as the first line of every body.
// Comparing against it — rather than the whole body — is what keeps a long,
// well-evidenced record as findable as a terse one.
export function storedSymptom(body: string): string {
  const match = /^Symptom:\s*(.+)$/m.exec(body);
  return match?.[1]?.trim() ?? "";
}

export function findDuplicateCandidates(
  existing: readonly FbrainRecord[],
  opts: { component: string; symptom: string; hash: string },
): DuplicateCandidate[] {
  const candidates: DuplicateCandidate[] = [];
  for (const record of existing) {
    // Only live records gate a new filing. A `verified` papercut that comes
    // back is a RECONFIRMATION and deserves its own record (kind:
    // `reconfirmed`) — folding it into the closed one would hide a regression
    // inside a record that says the defect is gone.
    if (!isLivePapercutStatus(record.status)) continue;
    if (typeof record.component === "string" && record.component !== opts.component) {
      continue;
    }
    const exact =
      typeof record.symptom_hash === "string" &&
      record.symptom_hash.length > 0 &&
      record.symptom_hash === opts.hash;
    // Compare against the two SHORT statements of the defect — the title and
    // the stored `Symptom:` line — and take the better match. Never against the
    // whole body: that is the length coupling documented on `similarity`.
    const stored = storedSymptom(record.body ?? "");
    const score = exact
      ? 1
      : Math.max(
          similarity(opts.symptom, record.title),
          stored.length > 0 ? similarity(opts.symptom, stored) : 0,
        );
    if (exact || score >= NEAR_DUPLICATE_THRESHOLD) {
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
};

export async function papercutFileCmd(
  opts: PapercutFileOptions,
): Promise<PapercutFileResult> {
  const print = resolvePrintSink(opts);
  const slug = normalizeSlug(opts.slug);
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

  const existing = await listRecords(node, PAPERCUT, schemaHash, opts.cfg);
  const cleared = new Set((opts.notDuplicateOf ?? []).map(normalizeSlug));
  const duplicates = findDuplicateCandidates(existing, {
    component,
    symptom: opts.symptom,
    hash,
  }).filter((c) => !cleared.has(c.slug));

  if (duplicates.length > 0) {
    const lines = [
      `Refusing to file: ${duplicates.length} live papercut(s) in \`${component}\` may already describe this.`,
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

  const prior = await findBySlug(node, PAPERCUT, schemaHash, slug);
  if (prior) {
    throw new FbrainError({
      code: "papercut_exists",
      message: `papercut ${slug} already exists (status: ${prior.status}).`,
      hint: "Use `brain append <slug> --type papercut` to add evidence, or pick a new slug.",
    });
  }

  const now = nowIso();
  const clearedNote =
    cleared.size > 0
      ? `\n\nCompared against and judged distinct from: ${[...cleared]
          .map((s) => `[[${s}]]`)
          .join(", ")}.`
      : "";
  const body = `Symptom: ${opts.symptom.trim()}\n\n${opts.body.trim()}${clearedNote}\n`;

  await node.createRecord({
    schemaHash,
    keyHash: slug,
    fields: {
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
    },
  });

  // The record is in SOT. It is NOT yet listable — `brain list`, `papercut
  // census` and BM25 all read the type-list index, and a record missing from it
  // is invisible to every one of them while `brain get` still resolves it.
  // Skipping this is precisely how the first papercut ever filed produced a
  // census that said "no papercuts".
  const filed = await findBySlug(node, PAPERCUT, schemaHash, slug);
  const { listIndexFailed } = await maintainTypeListIndex({
    node,
    cfg: opts.cfg,
    type: PAPERCUT,
    record: filed ?? {
      slug,
      title: opts.title,
      body,
      status: "open",
      tags: opts.tags ?? [],
      created_at: now,
      updated_at: now,
    },
    slug,
    ...(opts.verbose ? { verbose: opts.verbose } : {}),
  });

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
    print(`filed papercut ${slug}  [${component}/${severity}/${kind}]  symptom:${hash}`);
    if (listIndexFailed) {
      print(
        "warning: the record persisted but the type-list index patch failed — it will not " +
          "appear in `papercut census` / `brain list` until `fbrain reindex --list-index` runs.",
      );
    }
  }
  return { action: "filed", slug, component, symptom_hash: hash, duplicates: [] };
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

  await node.updateRecord({
    schemaHash,
    keyHash: slug,
    fields: updateFieldsFrom(record, PAPERCUT, patch),
  });

  // Same reason as the file path: the index carries `status`, so a close that
  // skips it leaves the census counting the OLD status forever.
  const closed = await findBySlug(node, PAPERCUT, schemaHash, slug);
  await maintainTypeListIndex({
    node,
    cfg: opts.cfg,
    type: PAPERCUT,
    record: closed ?? { ...record, status, updated_at: now },
    slug,
    ...(opts.verbose ? { verbose: opts.verbose } : {}),
  });

  if (opts.json) {
    print(JSON.stringify({ action: "papercut_closed", slug, from, to: status }));
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
    const c = typeof r.component === "string" && r.component.length > 0 ? r.component : "(unset)";
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
  return [...byComponent.values()].sort((a, b) => b.live - a.live || a.component.localeCompare(b.component));
}

// Every count prints its method. This is a rule the corpus paid for: an
// instrument that reports a number without saying how it got it is how a
// 44.5% win got reported as a 2.2% regression, and how a truncated
// enumeration got copied into durable memory as a fact.
export const CENSUS_METHOD =
  "method: type-list index over type=papercut (keyed read, not a projection scan); " +
  "live = open+partial+fixed";

export async function papercutCensusCmd(opts: PapercutCensusOptions): Promise<void> {
  const print = resolvePrintSink(opts);
  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);
  const schemaHash = schemaHashFor(PAPERCUT, opts.cfg);
  const records = await listRecords(node, PAPERCUT, schemaHash, opts.cfg);
  const rows = buildCensus(records, opts.component);

  if (opts.json) {
    print(JSON.stringify({ rows, method: CENSUS_METHOD, scanned: records.length }));
    return;
  }
  if (rows.length === 0) {
    print("no papercuts");
    print(CENSUS_METHOD);
    return;
  }
  const header = "component            live  open part  fix  ver  wont  dup total";
  const lines = rows.map(
    (r) =>
      `${r.component.padEnd(20)} ${String(r.live).padStart(4)} ${String(r.open).padStart(5)} ` +
      `${String(r.partial).padStart(4)} ${String(r.fixed).padStart(4)} ${String(r.verified).padStart(4)} ` +
      `${String(r.wontfix).padStart(5)} ${String(r.duplicate).padStart(4)} ${String(r.total).padStart(5)}`,
  );
  print([header, ...lines, "", CENSUS_METHOD].join("\n"));
}
