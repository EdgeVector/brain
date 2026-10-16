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
import type { SnapshotSummary } from "../index-payload.ts";
import type { Config } from "../config.ts";
import { resolvePrintSink, resolvePrintSinks } from "../format.ts";
import {
  crossTypeSlugNote,
  findBySlug,
  findBySlugs,
  findCrossTypeSlugCollisions,
  normalizeSlug,
  nowIso,
  resolveBySlug,
  schemaHashFor,
  updateFieldsFrom,
  withReadRetry,
  type FbrainRecord,
} from "../record.ts";
import { newWriteClientFromCfg } from "../write-context.ts";
import {
  writeDurabilityOf,
  writeDurabilityTokens,
  type WriteDurability,
} from "../write-confirmation.ts";
import { hydrateRecord, parseSpillMarker } from "../body-spill.ts";
import { HEAD_RANGE, INDEX_PARTIAL } from "../list-page.ts";
import { BRAIN_LIST_PAGE_SCHEMA_KEY } from "../schemas.ts";
import {
  buildResidentWritePlan,
  commitResidentWritePlan,
  commitResidentWritePlans,
  type ResidentWritePlan,
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
  prefixPapercutSlug,
  symptomHash,
} from "../papercut.ts";

const PAPERCUT: "papercut" = "papercut";

export type DuplicateCandidate = {
  slug: string;
  title: string;
  status: string;
  score: number;
  exact: boolean;
};

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
  verbose?: Verbose;
  print?: (line: string) => void;
  printErr?: (line: string) => void;
  json?: boolean;
};

export type PapercutFileResult = {
  action: "filed" | "duplicate_blocked";
  slug: string;
  component: string;
  symptom_hash: string;
  duplicates: DuplicateCandidate[];
  idempotent?: boolean;
  /** What the node said about flushing this filing to disk. */
  durability?: WriteDurability;
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

async function readOtherSymptomSlug(
  node: ReturnType<typeof newWriteClientFromCfg>["node"],
  cfg: Config,
  symptomHashValue: string,
  slug: string,
): Promise<string | null> {
  const schemaHash = cfg.schemaHashes[BRAIN_LIST_PAGE_SCHEMA_KEY] ?? "";
  if (schemaHash.length === 0) return null;
  const res = await node.queryAll({
    schemaHash,
    fields: ["blp_page"],
    filter: {
      HashRangeKey: { hash: `symptom#${symptomHashValue}`, range: HEAD_RANGE },
    },
  });
  const raw = res.results[0]?.fields?.blp_page;
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const cards = (parsed as { cards?: unknown }).cards;
  if (!Array.isArray(cards)) return null;
  for (const card of cards) {
    if (!card || typeof card !== "object") continue;
    const held = (card as { slug?: unknown }).slug;
    if (typeof held !== "string" || held.length === 0 || held === slug) continue;
    return held;
  }
  return null;
}

type PapercutPageCard = {
  slug: string;
  status: string;
  title: string;
  updated_at: string;
};

type PapercutPage = { cards: PapercutPageCard[]; older: string };

function papercutPageHash(status?: string): string {
  return status && status.length > 0 ? `papercut#${status}` : "papercut";
}

async function readPapercutPage(
  node: ReturnType<typeof newWriteClientFromCfg>["node"],
  cfg: Config,
  hash: string,
  verbose?: Verbose,
): Promise<PapercutPage> {
  const empty: PapercutPage = { cards: [], older: "" };
  const schemaHash = cfg.schemaHashes[BRAIN_LIST_PAGE_SCHEMA_KEY] ?? "";
  if (schemaHash.length === 0) return empty;
  verbose?.(`query HashRangeKey hash=${hash} range=${HEAD_RANGE} field=blp_page`);
  const res = await node.queryAll({
    schemaHash,
    fields: ["blp_page"],
    filter: { HashRangeKey: { hash, range: HEAD_RANGE } },
  });
  const raw = res.results[0]?.fields?.blp_page;
  if (typeof raw !== "string" || raw.length === 0) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object") return empty;
  const body = parsed as { cards?: unknown; older?: unknown };
  const cards: PapercutPageCard[] = [];
  if (Array.isArray(body.cards)) {
    for (const item of body.cards) {
      if (!item || typeof item !== "object") continue;
      const card = item as {
        slug?: unknown;
        status?: unknown;
        title?: unknown;
        updated_at?: unknown;
      };
      if (typeof card.slug !== "string" || card.slug.length === 0) continue;
      cards.push({
        slug: card.slug,
        status: typeof card.status === "string" ? card.status : "",
        title: typeof card.title === "string" ? card.title : "",
        updated_at: typeof card.updated_at === "string" ? card.updated_at : "",
      });
    }
  }
  return {
    cards,
    older: typeof body.older === "string" ? body.older : "",
  };
}

function pageSummaries(cards: readonly PapercutPageCard[]): SnapshotSummary[] {
  return cards.map((card) => ({
    slug: card.slug,
    title: card.title,
    status: card.status,
    tags: [],
    created_at: "",
    updated_at: card.updated_at,
  }));
}

async function productRecordsOnPage(
  node: ReturnType<typeof newWriteClientFromCfg>["node"],
  cfg: Config,
  slugs: readonly string[],
  hydrate: boolean,
): Promise<FbrainRecord[]> {
  if (slugs.length === 0) return [];
  const schemaHash = schemaHashFor(PAPERCUT, cfg);
  const found = await findBySlugs(node, PAPERCUT, schemaHash, slugs);
  const out: FbrainRecord[] = [];
  for (const slug of slugs) {
    const row = found.get(slug) ?? null;
    if (row === null) continue;
    if (hydrate && parseSpillMarker(row.body)) {
      out.push(await hydrateRecord(node, cfg, PAPERCUT, row));
      continue;
    }
    out.push(row);
  }
  return out;
}

function pageMethod(base: string, hash: string, older: string): string {
  const sample = older.length > 0 ? ` sample ${older}` : "";
  return `${base}; hash ${hash}; range ${HEAD_RANGE}${sample}`;
}

export async function papercutFileCmd(
  opts: PapercutFileOptions,
): Promise<PapercutFileResult> {
  const { print, printErr } = resolvePrintSinks(opts);
  const given = normalizeSlug(opts.slug);
  const slug = ensurePapercutSlug(prefixPapercutSlug(given));
  if (slug !== given) printErr(`papercut file: slug prefixed: ${slug}`);
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
  const now = nowIso();
  const body = `Symptom: ${opts.symptom.trim()}\n\n${opts.body.trim()}\n`;
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

  const prior = await findBySlug(node, PAPERCUT, schemaHash, slug, opts.cfg);
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
    const receipt = await commitResidentWritePlan({
      node,
      plan,
      type: PAPERCUT,
      slug,
      durable: true,
      failOnIndexPartial: true,
    });
    const result: PapercutFileResult = {
      action: "filed",
      slug,
      component,
      symptom_hash: hash,
      duplicates: [],
      idempotent: true,
      durability: writeDurabilityOf(receipt),
    };
    if (opts.json) print(JSON.stringify(result));
    else
      print(
        `papercut ${slug} already filed; keyed membership verified ` +
          writeDurabilityTokens(receipt).join(" "),
      );
    return result;
  }
  if (prior) {
    throw new FbrainError({
      code: "papercut_exists",
      message: `papercut ${slug} already exists (status: ${prior.status}).`,
      hint: isLivePapercutStatus(prior.status)
        ? "Use `brain append <slug> --type papercut` to add evidence, or `brain papercut set` to change a header."
        : "The row is closed. Add evidence with `brain append <slug> --type papercut`.",
    });
  }

  const held = await readOtherSymptomSlug(node, opts.cfg, hash, slug);
  if (held) {
    const duplicates: DuplicateCandidate[] = [
      { slug: held, title: "", status: "", score: 0, exact: false },
    ];
    const result: PapercutFileResult = {
      action: "duplicate_blocked",
      slug,
      component,
      symptom_hash: hash,
      duplicates,
    };
    if (opts.json) print(JSON.stringify(result));
    else {
      print(`duplicate: ${held}`);
      print("The symptom head already names that slug. This filing was not written.");
    }
    return result;
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
  const fileReceipt = await commitResidentWritePlan({
    node,
    plan,
    type: PAPERCUT,
    slug,
    durable: true,
    failOnIndexPartial: true,
  });

  const collisions = await findCrossTypeSlugCollisions(
    node,
    opts.cfg,
    PAPERCUT,
    slug,
  );
  const collisionNote = crossTypeSlugNote(PAPERCUT, slug, collisions);
  if (collisionNote) console.error(collisionNote);

  if (opts.json) {
    print(
      JSON.stringify({
        action: "filed",
        slug,
        component,
        symptom_hash: hash,
        duplicates: [],
        durability: writeDurabilityOf(fileReceipt),
      }),
    );
  } else {
    print(
      `filed papercut ${slug}  [${component}/${severity}/${kind}]  symptom:${hash} ` +
        writeDurabilityTokens(fileReceipt).join(" "),
    );
  }
  return {
    action: "filed",
    slug,
    component,
    symptom_hash: hash,
    duplicates: [],
    durability: writeDurabilityOf(fileReceipt),
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
  /** Also set the row's kind in the same write. */
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
  /**
   * What the node said about flushing the typed row's status write to disk.
   * `unreported` means the node did not answer, which is not the same claim as
   * `queued` — see `writeDurabilityOf`.
   */
  durability: WriteDurability;
  /** The mutation id of the status write, when the receipt carried one. */
  revision?: string;
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
  /**
   * What the node said about flushing the twin's status write. The re-read
   * above cannot distinguish a queued write from a durable one, so
   * `persisted: true` is not a durability claim.
   */
  durability?: WriteDurability;
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

async function planReferenceTwin(opts: {
  node: ReturnType<typeof newWriteClientFromCfg>["node"];
  cfg: Config;
  slug: string;
  status: string;
  stamp: string;
  now: string;
  verbose?: Verbose;
}): Promise<{
  prior: PapercutTwinResult | null;
  plan: ResidentWritePlan | null;
  from: string | null;
  to: string | null;
}> {
  const target = referenceTwinStatusFor(opts.status);
  if (target === null) return { prior: null, plan: null, from: null, to: null };
  if (opts.cfg.schemaHashes.reference === undefined) {
    return { prior: null, plan: null, from: null, to: null };
  }
  const refHash = schemaHashFor("reference", opts.cfg);
  let twin: FbrainRecord | null;
  try {
    twin = await findBySlug(opts.node, "reference", refHash, opts.slug, opts.cfg);
  } catch (error) {
    return {
      prior: {
        type: "reference",
        from: "?",
        to: target,
        changed: false,
        persisted: false,
        error: error instanceof Error ? error.message : String(error),
      },
      plan: null,
      from: null,
      to: null,
    };
  }
  if (twin === null) return { prior: null, plan: null, from: null, to: null };
  if (twin.status === target) {
    return {
      prior: {
        type: "reference",
        from: twin.status,
        to: target,
        changed: false,
        persisted: true,
      },
      plan: null,
      from: null,
      to: null,
    };
  }
  const patch = {
    status: target,
    body: `${twin.body.replace(/\s+$/, "")}\n${opts.stamp}`,
    updated_at: opts.now,
  };
  const primaryFields = updateFieldsFrom(twin, "reference", patch);
  const plan = await buildResidentWritePlan({
    node: opts.node,
    cfg: opts.cfg,
    type: "reference",
    schemaHash: refHash,
    previous: twin,
    next: { ...twin, ...patch },
    primaryFields,
    now: opts.now,
    preserveStoredEdges: true,
    ...(opts.verbose !== undefined ? { verbose: opts.verbose } : {}),
  });
  return {
    prior: null,
    plan,
    from: twin.status,
    to: target,
  };
}

// One call writes the status field and the evidence block. The reference twin,
// when it changes, uses the same primary batch and keeps its related pages current.
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
  if (plan.indexNotes.includes(INDEX_PARTIAL)) {
    const why = plan.indexNotes.filter((line) => line !== INDEX_PARTIAL && line.length > 0);
    throw new FbrainError({
      code: "index_partial",
      message:
        `index partial for papercut ${slug}` +
        (why.length > 0 ? ` (${why.join(", ")})` : ""),
      hint: "The command does not report success. Read the record before a manual retry.",
    });
  }
  const twinPlan = await planReferenceTwin({
    node,
    cfg: opts.cfg,
    slug,
    status,
    stamp,
    now,
    verbose: opts.verbose,
  });
  const writes = [
    { plan, type: PAPERCUT, slug },
    ...(twinPlan.plan ? [{ plan: twinPlan.plan, type: "reference" as const, slug }] : []),
  ];
  const receipt = await commitResidentWritePlans({
    node,
    writes,
    durable: true,
    failOnIndexPartial: true,
  });
  const durability = writeDurabilityOf(receipt);
  const revision = receipt.mutationIds[0];

  let twin = twinPlan.prior;
  if (twinPlan.plan && twinPlan.from && twinPlan.to) {
    const refHash = schemaHashFor("reference", opts.cfg);
    const target = twinPlan.to;
    const seen = await withReadRetry(
      () => findBySlug(node, "reference", refHash, slug, opts.cfg, { hydrate: false }),
      (row) => row !== null && row.status === target,
    );
    const reread = seen?.status ?? "(missing)";
    twin = {
      type: "reference",
      from: twinPlan.from,
      to: target,
      changed: true,
      persisted: reread === target,
      reread,
      durability,
    };
  }

  if (opts.json) {
    print(
      JSON.stringify({
        action: "papercut_closed",
        slug,
        from,
        to: status,
        ...(twin ? { twin } : {}),
        durability,
        ...(revision ? { revision } : {}),
      }),
    );
  } else {
    print(
      `papercut ${slug}: ${from} → ${status} ${writeDurabilityTokens(receipt).join(" ")}`,
    );
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
    durability,
    ...(revision ? { revision } : {}),
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
  records: readonly SnapshotSummary[],
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

// The count names its read. The page carries slug, status, title, and updated_at.
export const CENSUS_METHOD =
  "method: one HashRangeKey on the papercut list page, field blp_page, " +
  "counts from the cards on that page, the page does not carry component, " +
  "run --point-read to read those slugs from the product records; " +
  "live = open+partial+fixed";

/** The same page, then the product records for the slugs on it. */
export const CENSUS_METHOD_POINT_READ =
  "method: one HashRangeKey on the papercut list page, field blp_page, " +
  "then the product records for the slugs on that page (--point-read); " +
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
  const pointRead = opts.pointRead === true;
  if (opts.component && !pointRead) {
    throw new FbrainError({
      code: "papercut_census_page_field",
      message: "The list page does not carry component.",
      hint: "Pass --point-read to read component from the product records on the page.",
    });
  }
  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);
  const hash = papercutPageHash();
  const page = await readPapercutPage(node, opts.cfg, hash, opts.verbose);
  const records = pointRead
    ? await productRecordsOnPage(
        node,
        opts.cfg,
        page.cards.map((card) => card.slug),
        false,
      )
    : pageSummaries(page.cards);
  const method = pageMethod(censusMethod(pointRead), hash, page.older);
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

function str(record: { [field: string]: unknown }, field: string): string {
  const v = record[field];
  return typeof v === "string" ? v : "";
}

function componentOf(record: { [field: string]: unknown }): string {
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
const BODY_FIXED_BY_CLAIM = /^[\s>#*-]*Fixed(?:-by)?:\s*\**\s*(.+)$/i;

/**
 * Extract the repair PR reference from an explicit "Fixed-by:" line in the body.
 *
 * Returns the PR reference if found (e.g., "EdgeVector/brain #123" or "fold #456"),
 * or null if no explicit "Fixed-by:" line is present. This ensures only
 * explicitly asserted repairs are recognized, not incident PRs cited elsewhere
 * in the body.
 *
 * Requires the repository/source scope to match the correct format:
 * - "owner/repo #number" for GitHub-style PRs
 * - "short-name #number" for internal repos
 */
export function extractFixedByFromBody(body: unknown): string | null {
  if (typeof body !== "string" || body.length === 0) return null;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const m = BODY_FIXED_BY_CLAIM.exec(line);
    if (m === null) continue;
    const prRef = (m[1] ?? "").trim();
    if (prRef.length === 0) continue;
    return prRef;
  }
  return null;
}

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
  r: SnapshotSummary,
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

// A row read from the index snapshot has no `body` (index-payload.ts). The
// body-resolved filter reads the body, so it needs a whole record: a row that
// is not one is refused here instead of being matched against a head.
function wholeRecordOrThrow(r: SnapshotSummary): FbrainRecord {
  if (typeof r.body !== "string") {
    throw new FbrainError({
      code: "papercut_body_unavailable",
      message: `papercut ${r.slug} was read from the index snapshot, which keeps no body; the body-resolved filter needs the record.`,
      hint: "Read it with --point-read (the body-resolved filter always does).",
    });
  }
  return r as FbrainRecord;
}

export function buildPapercutList(
  records: readonly SnapshotSummary[],
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
    const full = bodyResolved ? wholeRecordOrThrow(r) : null;
    const claim = full ? staleClosureClaim(full) : null;
    const dependency = full ? closesWhenClaim(full, childStatus) : null;
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
  "method: one HashRangeKey on the papercut list page, field blp_page, " +
  "then the product records for the slugs on that page (--point-read), " +
  "FILTERS, oldest updated_at first";

export const LIST_METHOD_FAST =
  "method: one HashRangeKey on the papercut list page, field blp_page, " +
  "same page as papercut census, cards on that page, " +
  "the page carries slug, status, title, and updated_at, " +
  "FILTERS, oldest updated_at on the card first";

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
  "method: one HashRangeKey on the papercut list page, field blp_page, " +
  "slug and status from the card, product records not read, slug order";

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
  if (bodyResolved && opts.fast === true) {
    throw new FbrainError({
      code: "papercut_list_body_resolved_needs_point_read",
      message: "`--body-resolved` reads the product body. `--fast` reads the page only.",
      hint: "Drop --fast.",
    });
  }
  if (bodyResolved && opts.indexOnly === true) {
    throw new FbrainError({
      code: "papercut_list_index_only_no_body",
      message: "`--index-only` reads the card. The card does not carry body.",
      hint: "Drop --index-only.",
    });
  }
  const print = resolvePrintSink(opts);
  const status = opts.status ? ensurePapercutStatus(opts.status) : undefined;
  const hash = papercutPageHash(status);
  if (opts.indexOnly) {
    const unservable = PAPERCUT_LIST_FILTERS.filter(
      (f) => f !== "status" && opts[f] !== undefined,
    );
    if (unservable.length > 0) {
      throw new FbrainError({
        code: "papercut_list_index_only_no_component",
        message: `\`--index-only\` reads the card, and ${unservable.join(", ")} ${unservable.length === 1 ? "is" : "are"} not on that card.`,
        hint: "Drop --index-only, or drop the filter.",
      });
    }
  }
  const fast = listReadsSnapshot({ pointRead: opts.pointRead, bodyResolved });
  const filters: PapercutListFilters = {};
  for (const f of PAPERCUT_LIST_FILTERS) {
    const v = opts[f];
    if (v !== undefined) Object.assign(filters, { [f]: v });
  }
  if (status) filters.status = status;
  const narrowBy = narrowingFilters(filters);
  if (!opts.indexOnly && fast && narrowBy) {
    throw new FbrainError({
      code: "papercut_list_page_field",
      message: "The list page does not carry component, severity, kind, repo, or tags.",
      hint: "Pass --point-read to read those fields from the product records on the page.",
    });
  }
  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);
  const page = await readPapercutPage(node, opts.cfg, hash, opts.verbose);
  if (opts.indexOnly) {
    const rows = page.cards
      .map((card) => ({ slug: card.slug, status: card.status }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
    const method = pageMethod(LIST_INDEX_ONLY_METHOD, hash, page.older);
    if (opts.json) {
      print(JSON.stringify({ rows, total: rows.length, method }));
      return;
    }
    for (const r of rows) print(`${r.status.padEnd(9)} ${r.slug}`);
    print(`${rows.length} row(s)`);
    print(method);
    return;
  }
  const records = fast
    ? pageSummaries(page.cards)
    : await productRecordsOnPage(
        node,
        opts.cfg,
        page.cards.map((card) => card.slug),
        bodyResolved,
      );
  const baseMethod = pageMethod(listMethod(fast, filters), hash, page.older);
  const childStatus = bodyResolved
    ? await readClosesWhenChildren(node, opts.cfg, records.map(wholeRecordOrThrow))
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

// ---------------------------------------------------------------------------
// `papercut set` — amend a header column on an existing row.
//
// Before this verb the ledger had `file`, `close`, `census` and `list`, and no
// way to correct a header column after the filing. `file` refuses a second call
// on the same slug (the dedupe gate reports an EXACT self-match, which is
// correct — the row IS a duplicate of itself), and `close` writes only status
// columns. So a filing that omitted `--kind` kept `kind: complaint` forever.
//
// That is not cosmetic. `papercut list --status open --kind specified-fix` is
// the documented cheapest triage query: a row whose remedy a prior run already
// worked out. A record carrying a concrete remedy but reading `complaint` never
// appears in it, and the prose correction in its body is invisible to every
// filter. Measured 2026-09-26 on
// papercut-brain-papercut-has-no-verb-to-amend-a-header-column-after-filing.

/**
 * The header columns `papercut set` may amend.
 *
 * `status`, `fixed_by`, `verified_by` and `duplicate_of` are deliberately
 * absent: those are the closure columns and `papercut close` owns them,
 * because a status move must carry evidence. `symptom_hash` is absent because
 * it is the dedupe key — rewriting it would let one row impersonate another.
 * `tags` are absent because `brain tag <slug> --type papercut` already writes
 * them through the tag-membership index.
 */
export const PAPERCUT_HEADER_COLUMNS = [
  "component",
  "kind",
  "repo",
  "severity",
] as const;

export type PapercutHeaderColumn = (typeof PAPERCUT_HEADER_COLUMNS)[number];

export type PapercutHeaderChange = {
  field: PapercutHeaderColumn;
  from: string;
  to: string;
};

export type PapercutHeaderAmendPlan = {
  changes: PapercutHeaderChange[];
  /** Requested columns whose value already matched. */
  unchanged: PapercutHeaderColumn[];
};

/** Normalise one requested header value the same way `papercut file` does. */
export function normalizePapercutHeaderValue(
  field: PapercutHeaderColumn,
  value: string,
): string {
  if (field === "component") return ensureComponent(value);
  if (field === "kind") return ensureKind(value);
  if (field === "severity") return ensureSeverity(value);
  // `repo` is a free-form `owner/name` scope and `papercut file` does not
  // validate it. Validating it here only would mean the same string is
  // accepted at filing time and refused at amend time, which is worse than
  // either rule on its own.
  return value.trim();
}

/**
 * The whole decision of `papercut set`, as a pure function: which requested
 * columns actually move, and which already hold the requested value.
 *
 * A column that already matches is reported as unchanged and is NOT written.
 * That is not an optimisation. Every write bumps `updated_at`, and
 * `papercut list` orders oldest-updated-first — so a no-op amend would move a
 * row to the back of the triage queue without changing anything about it. A
 * verb whose no-op reorders the queue it feeds is a verb nobody can run twice.
 */
export function planPapercutHeaderAmend(
  record: FbrainRecord,
  requested: Partial<Record<PapercutHeaderColumn, string>>,
): PapercutHeaderAmendPlan {
  const changes: PapercutHeaderChange[] = [];
  const unchanged: PapercutHeaderColumn[] = [];
  for (const field of PAPERCUT_HEADER_COLUMNS) {
    const raw = requested[field];
    if (raw === undefined) continue;
    const to = normalizePapercutHeaderValue(field, raw);
    const from = typeof record[field] === "string" ? (record[field] as string) : "";
    if (from === to) {
      unchanged.push(field);
      continue;
    }
    changes.push({ field, from, to });
  }
  return { changes, unchanged };
}

/** `kind complaint → specified-fix` for the audit line and the printed diff. */
export function renderPapercutHeaderChange(change: PapercutHeaderChange): string {
  const from = change.from.length > 0 ? change.from : "(none)";
  const to = change.to.length > 0 ? change.to : "(none)";
  return `${change.field} ${from} → ${to}`;
}

/**
 * One appended line recording what moved.
 *
 * A header rewrite is a durable change with no diff: the column simply reads
 * differently and `updated_at` says only that something happened. Without this
 * line a reader who finds `kind: specified-fix` on a row filed as `complaint`
 * has no way to know it was amended, when, or from what.
 */
export function papercutHeaderAuditLine(
  changes: readonly PapercutHeaderChange[],
  now: string,
): string {
  return `Header-amended ${now}: ${changes.map(renderPapercutHeaderChange).join(", ")}`;
}

export type PapercutSetOptions = {
  cfg: Config;
  slug: string;
  component?: string;
  kind?: string;
  repo?: string;
  severity?: string;
  verbose?: Verbose;
  print?: (line: string) => void;
  json?: boolean;
};

export type PapercutSetResult = {
  action: "papercut_header_amended" | "papercut_header_unchanged";
  slug: string;
  changes: PapercutHeaderChange[];
  unchanged: PapercutHeaderColumn[];
};

export async function papercutSetCmd(
  opts: PapercutSetOptions,
): Promise<PapercutSetResult> {
  const print = resolvePrintSink(opts);
  const slug = normalizeSlug(opts.slug);
  const requested: Partial<Record<PapercutHeaderColumn, string>> = {};
  if (opts.component !== undefined) requested.component = opts.component;
  if (opts.kind !== undefined) requested.kind = opts.kind;
  if (opts.repo !== undefined) requested.repo = opts.repo;
  if (opts.severity !== undefined) requested.severity = opts.severity;
  if (Object.keys(requested).length === 0) {
    throw new FbrainError({
      code: "invalid_papercut_field",
      message: `papercut set requires at least one of ${PAPERCUT_HEADER_COLUMNS.map((f) => `--${f}`).join(" ")}.`,
      hint: "To move a row's status use `brain papercut close <slug> --status S --evidence E`; to add a tag use `brain tag <slug> --type papercut`.",
    });
  }
  // Validate every requested value BEFORE the node is touched. The planner
  // validates too, but it runs after `resolveBySlug`, so a typo'd `--kind`
  // would otherwise cost a point read and then report not_found for the SLUG
  // — which reads as "the row is missing" rather than "the value is wrong".
  for (const [field, value] of Object.entries(requested)) {
    normalizePapercutHeaderValue(field as PapercutHeaderColumn, value as string);
  }

  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);
  const schemaHash = schemaHashFor(PAPERCUT, opts.cfg);
  const only = await resolveBySlug({
    node,
    cfg: opts.cfg,
    slug,
    type: PAPERCUT,
    recoveryVerb: "papercut set",
  });
  const record = only.record;
  const plan = planPapercutHeaderAmend(record, requested);

  if (plan.changes.length === 0) {
    if (opts.json) {
      print(
        JSON.stringify({
          action: "papercut_header_unchanged",
          slug,
          changes: [],
          unchanged: plan.unchanged,
        }),
      );
    } else {
      print(
        `papercut ${slug}: unchanged — ${plan.unchanged.join(", ")} already ` +
          `${plan.unchanged.length === 1 ? "holds" : "hold"} the requested value. ` +
          `No write, so updated_at (which \`papercut list\` orders on) did not move.`,
      );
    }
    return {
      action: "papercut_header_unchanged",
      slug,
      changes: [],
      unchanged: plan.unchanged,
    };
  }

  const now = nowIso();
  const patch: Record<string, unknown> = { updated_at: now };
  for (const change of plan.changes) patch[change.field] = change.to;
  patch.body = `${record.body.replace(/\s+$/, "")}\n\n${papercutHeaderAuditLine(plan.changes, now)}\n`;

  const next = { ...record, ...patch } as FbrainRecord;
  const primaryFields = updateFieldsFrom(record, PAPERCUT, patch);
  const writePlan = await buildResidentWritePlan({
    node,
    cfg: opts.cfg,
    type: PAPERCUT,
    schemaHash,
    previous: record,
    next,
    primaryFields,
    now,
  });
  const setReceipt = await commitResidentWritePlan({
    node,
    plan: writePlan,
    type: PAPERCUT,
    slug,
  });

  if (opts.json) {
    print(
      JSON.stringify({
        action: "papercut_header_amended",
        slug,
        changes: plan.changes,
        unchanged: plan.unchanged,
        durability: writeDurabilityOf(setReceipt),
      }),
    );
  } else {
    print(
      `papercut ${slug}: ${plan.changes.map(renderPapercutHeaderChange).join(", ")} ` +
        writeDurabilityTokens(setReceipt).join(" "),
    );
    if (plan.unchanged.length > 0) {
      print(`  unchanged: ${plan.unchanged.join(", ")}`);
    }
  }
  return {
    action: "papercut_header_amended",
    slug,
    changes: plan.changes,
    unchanged: plan.unchanged,
  };
}
