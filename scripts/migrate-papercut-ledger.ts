// Migrate the freeform `papercut-*` prose ledger into typed `papercut` records.
//
//   bun scripts/migrate-papercut-ledger.ts --dry-run          # default; writes nothing
//   bun scripts/migrate-papercut-ledger.ts --dry-run --json > plan.json
//   bun scripts/migrate-papercut-ledger.ts --apply
//
// Scope decision (Tom, 2026-08-06): migrate the ACTIVE records only. Archived
// ones are already closed and the census does not need them.
//
// This script PARSES PROSE, which is exactly the thing the typed record exists
// to stop relying on. So it is deliberately conservative:
//
//   * Anything it cannot read confidently is reported as `needs_review` and is
//     NEVER written with a guessed value. The prose ledger's own worst failure
//     was a status field that disagreed with the record — a migration that
//     guesses would reproduce it at scale on day one.
//   * `Status: FIXED` in prose maps to `fixed`, NOT `verified`. Prose closures
//     were written under a convention that treated a merge as a closure; 12+
//     findings in the corpus are merged-but-not-running. Promoting them to
//     `verified` would assert a live check nobody ran.
//   * The dry run prints a per-record plan and a summary. Read it before
//     --apply.

import { readConfig } from "../src/config.ts";
import { newWriteClientFromCfg } from "../src/write-context.ts";
import {
  findBySlug,
  listRecords,
  nowIso,
  schemaHashFor,
  type FbrainRecord,
} from "../src/record.ts";
import { symptomHash } from "../src/papercut.ts";
import {
  maintainTypeListIndex,
  markTypePartitionMigrated,
} from "../src/record-list-index.ts";

type Plan = {
  slug: string;
  title: string;
  component: string;
  severity: string;
  status: string;
  kind: string;
  repo: string;
  symptom: string;
  symptom_hash: string;
  fixed_by: string;
  // BLOCKING: --apply skips these. Reserved for "I could not derive this at
  // all", never for "the source had no value and the default is safe".
  needs_review: string[];
  // Non-blocking. A conservative default was applied and this says which, so
  // the migration never reports a value without saying how it got it.
  notes: string[];
};

// Slug shape the ledger actually used: `papercut-<component>-<rest>`. The
// component is the FIRST segment after the prefix — which is exactly the
// scoping this migration is retiring, but it is also the only component signal
// the old records carry, so it is the best available seed. Anything that does
// not fit is flagged rather than guessed.
// Multi-segment components must be tried before their first segment, so
// `papercut-last-stack-…` resolves to `last-stack` and not `last`.
const KNOWN_COMPONENTS = new Set([
  "lastdb",
  "lastdbd",
  "lastgit",
  "laststore",
  "kanban",
  "fkanban",
  "brain",
  "fbrain",
  "fold",
  "routines",
  "routine",
  "last-stack",
  "situations",
  "forge",
  "pipeline",
  "north-star",
  "closeout",
  "cleanup",
  "exemem",
  "schema",
  "ops",
  "host",
  "canary",
  "pickup",
  "disk",
  "codex",
  "coderings",
  "agent",
  "portal",
  "homebrew",
  "card",
  "board",
  "safe-upgrade",
]);

// Aliases collapse the names the ledger used for ONE subsystem. Collapsing them
// is the point of having a typed column: `fold` is the LastDB monorepo and
// `lastdbd` is its daemon, so a census that lists them separately is three
// numbers for one thing.
const COMPONENT_ALIASES: Record<string, string> = {
  fkanban: "kanban",
  fbrain: "brain",
  fold: "lastdb",
  lastdbd: "lastdb",
  laststore: "lastdb",
  routine: "routines",
  card: "kanban",
  board: "kanban",
};

function parseComponent(slug: string, notes: string[], needsReview: string[]): string {
  const rest = slug.replace(/^papercut-/, "");
  const segments = rest.split("-");
  for (let take = 2; take >= 1; take -= 1) {
    const candidate = segments.slice(0, take).join("-");
    if (KNOWN_COMPONENTS.has(candidate)) {
      return COMPONENT_ALIASES[candidate] ?? candidate;
    }
  }
  // Not on the known list. Take the first segment verbatim rather than leaving
  // the column empty: `papercut-wt-…` → `wt` is a real, correct component name
  // we simply had not enumerated. An unfamiliar component fragments the census
  // and is trivially re-pointed later; an EMPTY one is invisible to it, which
  // is the exact failure the column replaced.
  const first = segments[0] ?? "";
  if (/^[a-z][a-z0-9]*$/.test(first)) {
    notes.push(`component "${first}" taken verbatim from the slug (not on the known list)`);
    return COMPONENT_ALIASES[first] ?? first;
  }
  needsReview.push(`component cannot be derived from slug`);
  return "";
}

function parseField(body: string, label: string): string {
  const re = new RegExp(`^${label}:\\s*(.+)$`, "im");
  return re.exec(body)?.[1]?.trim() ?? "";
}

function parseSeverity(body: string, notes: string[]): string {
  const raw = parseField(body, "Severity");
  const m = /\bp([0-3])\b/i.exec(raw);
  if (m) return `p${m[1]}`;
  // Non-blocking: most legacy records simply never carried a severity. p2 is
  // the middle of the ladder and the note says it was defaulted, so nobody
  // later reads it as a judgement anyone made.
  notes.push(raw.length > 0 ? `severity unparsed (${raw.slice(0, 40)}) — defaulted p2` : "no Severity line — defaulted p2");
  return "p2";
}

// The mapping that must not be generous. See the header note.
function parseStatus(body: string, notes: string[]): string {
  const raw = parseField(body, "Status").toUpperCase();
  if (raw.startsWith("OPEN")) return "open";
  if (raw.startsWith("PARTIAL")) return "partial";
  if (raw.startsWith("WONTFIX") || raw.startsWith("WON'T FIX")) return "wontfix";
  if (raw.startsWith("DUPLICATE")) return "duplicate";
  if (raw.startsWith("FIXED") || raw.startsWith("RESOLVED") || raw.startsWith("CLOSED")) {
    // A prose FIXED means "a change merged". Only a `Verified:` line naming a
    // live check earns `verified`, and even then we do not upgrade it here —
    // the run that re-measures it can, with evidence.
    return "fixed";
  }
  // `RECONCILED -> CARD:<slug>` is the papercut-reconciler routine's marker for
  // "a kanban card was cut for this". It is a routing fact, not a repair fact —
  // the defect is still open — so mapping it to `open` is correct, not a
  // fallback. Recorded as a note so the mapping is legible rather than implied.
  if (raw.startsWith("RECONCILED")) {
    notes.push("prose status RECONCILED (carded, not repaired) — mapped to open");
    return "open";
  }
  // Every remaining case defaults to `open`, which is the SAFE direction: it
  // can only ever over-report work, never claim a defect is gone.
  notes.push(
    raw.length === 0
      ? "no Status line — defaulted open"
      : `status unparsed (${raw.slice(0, 40)}) — defaulted open`,
  );
  return "open";
}

function parseKind(body: string): string {
  if (/^##+\s*(the\s+)?(proposed\s+)?fix\b/im.test(body)) return "specified-fix";
  if (/reconfirm/i.test(body)) return "reconfirmed";
  return "complaint";
}

function parseRepo(body: string): string {
  const raw = parseField(body, "Repo");
  const m = /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/.exec(raw);
  return m?.[1] ?? "";
}

// The symptom line is the dedupe key, so the migration must derive it the same
// way a human would: the record's own one-line statement of the defect. The
// title is that statement — the ledger's house style put it there.
function parseSymptom(record: FbrainRecord): string {
  const explicit = parseField(record.body, "Symptom");
  if (explicit.length > 0) return explicit;
  return record.title.replace(/^papercut\s*[—-]\s*/i, "").trim();
}

function buildPlan(record: FbrainRecord): Plan {
  const needsReview: string[] = [];
  const notes: string[] = [];
  const component = parseComponent(record.slug, notes, needsReview);
  const severity = parseSeverity(record.body, notes);
  const status = parseStatus(record.body, notes);
  const symptom = parseSymptom(record);
  if (symptom.length === 0) needsReview.push("no symptom could be derived");
  return {
    slug: record.slug,
    title: record.title,
    component,
    severity,
    status,
    kind: parseKind(record.body),
    repo: parseRepo(record.body),
    symptom,
    // An EMPTY symptom must NEVER get a hash. The first version of this script
    // hashed it anyway, so every unhydrated record shared one hash and the
    // collision report claimed 3 legacy duplicate filings that did not exist —
    // five unrelated kanban defects "colliding" because their symptom was "".
    // A dedupe key computed from nothing is not a weak signal, it is a false one.
    symptom_hash:
      component.length > 0 && symptom.length > 0 ? symptomHash(component, symptom) : "",
    fixed_by: parseField(record.body, "Fixed-by"),
    needs_review: needsReview,
    notes,
  };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const json = args.includes("--json");
  if (!apply && !args.includes("--dry-run")) {
    console.error("Pass --dry-run (safe) or --apply. Refusing to guess.");
    return 2;
  }

  const cfg = readConfig();
  const { node } = newWriteClientFromCfg(cfg);
  const referenceHash = schemaHashFor("reference", cfg);
  const listed = await listRecords(node, "reference", referenceHash, cfg);

  const candidates = listed.filter(
    (r) => r.slug.startsWith("papercut-") && r.status === "active",
  );

  // HYDRATE EVERY RECORD WITH A POINT READ. `listRecords` reads the type-list
  // index, which is a PROJECTION: measured 2026-08-06 against the live primary,
  // it returned an empty `title` and `body` for 330 of 568 active papercut
  // records while `brain get` returned both. Migrating from the projection
  // would have written 330 records with no symptom, no severity and a status
  // silently defaulted to `open` — including records whose prose says FIXED.
  //
  // A migration reads the RECORD, never the index that lists it.
  const source: FbrainRecord[] = [];
  const unhydrated: string[] = [];
  const CONCURRENCY = 16;
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    const hydrated = await Promise.all(
      batch.map(async (r) => ({
        slug: r.slug,
        record: await findBySlug(node, "reference", referenceHash, r.slug),
      })),
    );
    for (const h of hydrated) {
      if (h.record === null || h.record.title.length === 0) unhydrated.push(h.slug);
      else source.push(h.record);
    }
    process.stderr.write(`\rhydrating ${Math.min(i + CONCURRENCY, candidates.length)}/${candidates.length}`);
  }
  process.stderr.write("\n");

  const plans = source.map(buildPlan);

  // Duplicate detection ACROSS the migration set: two legacy records with the
  // same (component, symptom) are the duplicate filings this ledger could not
  // see. Report them; do not silently merge.
  const byHash = new Map<string, string[]>();
  for (const p of plans) {
    if (p.symptom_hash.length === 0) continue;
    const list = byHash.get(p.symptom_hash) ?? [];
    list.push(p.slug);
    byHash.set(p.symptom_hash, list);
  }
  const collisions = [...byHash.entries()].filter(([, slugs]) => slugs.length > 1);

  const clean = plans.filter((p) => p.needs_review.length === 0);
  const review = plans.filter((p) => p.needs_review.length > 0);

  if (json) {
    console.log(
      JSON.stringify(
        { total: plans.length, clean: clean.length, review: review.length, collisions, plans },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(`listed:      ${candidates.length} active papercut-* reference records`);
  console.log(`hydrated:    ${source.length}`);
  if (unhydrated.length > 0) {
    console.log(`UNHYDRATED:  ${unhydrated.length} (point read returned nothing or an empty title)`);
    for (const slug of unhydrated.slice(0, 10)) console.log(`  ${slug}`);
    if (unhydrated.length > 10) console.log(`  … and ${unhydrated.length - 10} more`);
  }
  console.log(`clean:  ${clean.length}`);
  console.log(`review: ${review.length}`);
  console.log(`symptom-hash collisions (legacy duplicate filings): ${collisions.length}`);
  for (const [hash, slugs] of collisions) {
    console.log(`  ${hash}  ${slugs.join("  ")}`);
  }
  console.log("");
  const byStatus = new Map<string, number>();
  const byComponent = new Map<string, number>();
  for (const p of plans) {
    byStatus.set(p.status, (byStatus.get(p.status) ?? 0) + 1);
    byComponent.set(p.component || "(unresolved)", (byComponent.get(p.component || "(unresolved)") ?? 0) + 1);
  }
  const noteCounts = new Map<string, number>();
  for (const p of plans) {
    for (const n of p.notes) {
      const key = n.replace(/\(.*?\)/, "(…)");
      noteCounts.set(key, (noteCounts.get(key) ?? 0) + 1);
    }
  }
  console.log("");
  console.log("defaults applied (non-blocking):");
  for (const [note, count] of [...noteCounts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${note}`);
  }
  console.log("");
  console.log("by status:", [...byStatus].map(([k, v]) => `${k}=${v}`).join(" "));
  console.log("by component:", [...byComponent].map(([k, v]) => `${k}=${v}`).join(" "));

  if (!apply) {
    console.log("");
    console.log("DRY RUN — nothing written. Re-run with --apply once the plan reads right.");
    console.log("Records needing review are NOT written by --apply; migrate those by hand.");
    return 0;
  }

  const papercutHash = schemaHashFor("papercut", cfg);
  const now = nowIso();
  let written = 0;
  let indexFailures = 0;
  for (const p of clean) {
    const original = source.find((r) => r.slug === p.slug)!;
    const fields = {
        slug: p.slug,
        title: p.title,
        body: original.body,
        status: p.status,
        component: p.component,
        repo: p.repo,
        severity: p.severity,
        kind: p.kind,
        symptom_hash: p.symptom_hash,
        fixed_by: p.fixed_by,
        verified_by: "",
        duplicate_of: "",
        tags: original.tags,
      created_at: original.created_at || now,
      updated_at: now,
    };
    await node.createRecord({ schemaHash: papercutHash, keyHash: p.slug, fields });

    // SEED THE TYPE-LIST INDEX PER RECORD.
    //
    // Not an optimization — it is what makes the migrated ledger readable at
    // all. `listRecords` returns the index when the partition is marked
    // complete, and otherwise COLD-SEEDS by full-scanning the product schema.
    // Measured on the primary 2026-08-06: that full scan is broken for this
    // schema — the node reports a `total_count` over the whole keyspace (955,
    // and it tracked records written to OTHER types during the session) and
    // pages with repeated keys, so the client's loop guard aborts.
    //
    // Writing the index here means the cold-seed path is never taken: the
    // migration IS the seed. See
    // `papercut-schema-on-primary-writes-land-but-scans-return-nothing-20260806`.
    const { listIndexFailed } = await maintainTypeListIndex({
      node,
      cfg,
      type: "papercut",
      record: { ...(fields as unknown as FbrainRecord) },
      slug: p.slug,
    });
    if (listIndexFailed) indexFailures += 1;
    written += 1;
    if (written % 25 === 0) process.stderr.write(`\rwriting ${written}/${clean.length}`);
  }
  process.stderr.write("\n");

  // Mark the partition complete only if EVERY entry landed. A partition marked
  // complete while missing rows is trusted forever by `readTypeListIndex` —
  // the exact "under-reports and nobody can tell" state this ledger replaces.
  if (indexFailures === 0) {
    await markTypePartitionMigrated(node, cfg, "papercut");
    console.log(`\nwrote ${written} typed papercut records; list-index seeded and marked complete`);
  } else {
    console.log(
      `\nwrote ${written} typed papercut records, but ${indexFailures} list-index patches FAILED.\n` +
        "Partition deliberately NOT marked complete — a complete marker over a partial index is " +
        "trusted forever. Re-run `fbrain reindex --list-index` or re-run this migration.",
    );
  }
  console.log(`${review.length} left for manual review`);
  return indexFailures === 0 ? 0 : 1;
}

process.exit(await main());
