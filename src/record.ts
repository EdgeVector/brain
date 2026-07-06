// Shared record helpers used by the design/task/put/get/list/status/link commands.

import type { NodeClient, QueryRow } from "./client.ts";
import { FbrainError, isLoopbackNodeUrl, newReadClientFromCfg } from "./client.ts";
import type { Config } from "./config.ts";
import {
  RECORDS,
  RECORD_TYPES,
  isRecordType,
  isValidStatus,
  statusValuesFor,
  type RecordType,
} from "./schemas.ts";



export type FbrainRecord = {
  slug: string;
  title: string;
  body: string;
  status: string;
  tags: string[];
  design_slug?: string;
  created_at: string;
  updated_at: string;
  // Type-specific extra String columns (see RecordTypeDef.extraStringFields),
  // e.g. a `decision` record's program/gate_slug/decided_by/decided_on. Carried
  // generically by rowToRecord/buildFields so dedicated-shape types need no
  // per-field plumbing.
  [extraField: string]: string | string[] | undefined;
};

export type BacklinkVia = "explicit" | "body";

export type Backlink = {
  type: RecordType;
  slug: string;
  status: string;
  via: BacklinkVia[];
  updated_at: string;
};

const GENERIC_LINK_TAG_PREFIX = "link:";

export function genericLinkTag(toType: RecordType, toSlug: string): string {
  return `${GENERIC_LINK_TAG_PREFIX}${toType}:${toSlug}`;
}

export function parseGenericLinkTag(
  tag: string,
): { to_type: RecordType; to_slug: string } | null {
  if (!tag.startsWith(GENERIC_LINK_TAG_PREFIX)) return null;
  const rest = tag.slice(GENERIC_LINK_TAG_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  const rawType = rest.slice(0, sep);
  const toSlug = rest.slice(sep + 1);
  if (!isRecordType(rawType) || toSlug.length === 0) return null;
  return { to_type: rawType, to_slug: toSlug };
}

export function wikiLinkSlugs(body: string): string[] {
  const found = new Set<string>();
  const re = /\[\[([^\]\n]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const raw = match[1] ?? "";
    const slug = normalizeSlug(raw.split(/[|#]/, 1)[0] ?? "");
    if (slug.length > 0) found.add(slug);
  }
  return Array.from(found);
}

// Soft-delete sentinel — see docs/phase-5-delete-spike.md. fold_db is
// append-only, so `fbrain delete` overwrites the record's user fields and
// stamps this tag; every fbrain read path filters records carrying it.
export const TOMBSTONE_TAG = "__fbrain_deleted__";

export function isTombstoned(r: FbrainRecord): boolean {
  return r.tags.includes(TOMBSTONE_TAG);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function fieldsFor(type: RecordType): string[] {
  return RECORDS[type].schema.schema.fields.slice();
}

export function schemaHashFor(
  type: RecordType,
  cfg: { schemaHashes: Record<string, string> },
): string {
  const hash = cfg.schemaHashes[type];
  if (!hash || hash.length === 0) {
    throw new FbrainError({
      code: "missing_schema_hash",
      message: `No canonical hash registered for type "${type}" in config.`,
      hint:
        "This config is stale or partial. Routine reads skip unavailable types; " +
        "for setup/repair, run `fbrain init --grant-consent` against the configured " +
        "socket-backed node to refresh schema hashes.",
    });
  }
  return hash;
}

export function missingSchemaHashReadNote(
  skipped: readonly RecordType[],
  action: string,
): string {
  return (
    `note: skipping type(s) ${skipped.join(", ")} — schema unavailable in this config or node ` +
    `(${action}). Routine reads continue over available socket-backed schemas; ` +
    "repair the stale config with a deliberate `fbrain init --grant-consent`."
  );
}

export function isSchemaNotFoundReadError(err: unknown): boolean {
  if (!(err instanceof FbrainError)) return false;
  if (err.code === "missing_schema_hash") return true;
  if (err.code !== "node_http_404" && err.code !== "node_http_400") {
    return false;
  }
  const msg = err.message.toLowerCase();
  return (
    msg.includes("schema not found") ||
    msg.includes("not found as schema or view") ||
    msg.includes("unknown schema")
  );
}

// Deduped list of canonical schema hashes for the given record types. Used
// by `search` and `ask` to scope native-index queries to fbrain's schemas
// (the `schemas` filter on /api/native-index/search). Phase 6 types
// concept/preference/reference/agent/project/spike all map to the same
// unified MEMO schema, so the per-type lookups return the same hash six
// times — the Set collapses them so the URL stays compact and the verbose
// count is meaningful ("N unique schemas" vs N record types). Missing or
// empty entries are filtered out so a partially-initialised config doesn't
// inject an empty filter element.
export function uniqueSchemaHashes(
  cfg: { schemaHashes: Record<string, string> },
  types: readonly RecordType[],
): string[] {
  return Array.from(
    new Set(
      types
        .map((t) => cfg.schemaHashes[t])
        .filter((h): h is string => typeof h === "string" && h.length > 0),
    ),
  );
}

// Shared by `ask` and `search`: turn an optional `--type` selection into a
// membership Set plus the canonical-order RecordType list to walk. Undefined
// or empty `types` returns `null` filter + all 8 RECORD_TYPES so callers can
// branch on the null instead of a length check. `activeTypes` preserves
// RECORD_TYPES order regardless of the order the user passed `--type` in.
//
// Config-guard (papercut-fbrain-decision-type-hash-missing): every downstream
// consumer of `activeTypes` calls `schemaHashFor(t, cfg)`, which THROWS
// `missing_schema_hash` for a type absent from the local config. A partially
// initialised config (e.g. one predating the `decision` schema) therefore made
// read commands fail the WHOLE query the instant one walked type lacked a hash
// — even though the other types were perfectly resolvable. When a `cfg` is
// supplied we DROP the unavailable types (both from `activeTypes` and from the
// returned `typeFilter` Set the native-hit resolver consults) and report each
// skipped type via `onSkip`, so reads degrade gracefully instead of aborting.
// This mirrors `resolveBySlug`'s existing
// `RECORD_TYPES.filter((t) => cfg.schemaHashes[t] !== undefined)` discipline.
// Callers omit `cfg` to keep the pre-existing "walk every requested type"
// behavior (e.g. non-query call sites / tests that don't touch config hashes).
export function resolveTypeFilter(
  types?: readonly RecordType[],
  cfg?: { schemaHashes: Record<string, string> },
  onSkip?: (skipped: readonly RecordType[]) => void,
): {
  typeFilter: Set<RecordType> | null;
  activeTypes: readonly RecordType[];
} {
  const hasHash = (t: RecordType): boolean =>
    cfg === undefined ||
    (typeof cfg.schemaHashes[t] === "string" && cfg.schemaHashes[t]!.length > 0);

  const requested = types && types.length > 0 ? new Set(types) : null;

  // Which requested (or, when unfiltered, all) types are actually resolvable
  // against the config, in canonical order.
  const available = RECORD_TYPES.filter(
    (t) => (requested ? requested.has(t) : true) && hasHash(t),
  );

  if (onSkip) {
    const skipped = RECORD_TYPES.filter(
      (t) => (requested ? requested.has(t) : true) && !hasHash(t),
    );
    if (skipped.length > 0) onSkip(skipped);
  }

  // Keep the filter Set only for an EXPLICIT `--type` request, narrowed to the
  // available types so the native-hit resolver never gates on a hash-less type.
  const typeFilter = requested ? new Set(available) : null;
  const activeTypes: readonly RecordType[] = available;
  return { typeFilter, activeTypes };
}

export function rowToRecord(row: QueryRow, type: RecordType): FbrainRecord {
  const f = (row.fields ?? {}) as Record<string, unknown>;
  const base: FbrainRecord = {
    slug: stringField(f, "slug"),
    title: stringField(f, "title"),
    body: stringField(f, "body"),
    status: stringField(f, "status"),
    tags: arrayStringField(f, "tags"),
    created_at: stringField(f, "created_at"),
    updated_at: stringField(f, "updated_at"),
  };
  if (RECORDS[type].hasDesignSlug) base.design_slug = stringField(f, "design_slug");
  for (const ef of RECORDS[type].extraStringFields ?? []) {
    base[ef] = stringField(f, ef);
  }
  return base;
}

export function stringField(f: Record<string, unknown>, key: string): string {
  const v = f[key];
  if (typeof v === "string") return v;
  if (v == null) return "";
  return String(v);
}

function arrayStringField(f: Record<string, unknown>, key: string): string[] {
  const v = f[key];
  // Mirror put.ts's inline-list parser (`.filter(s => s.length > 0)`): the
  // write path treats empty strings as non-tags, so the read path must too —
  // otherwise a phantom empty tag from the server (legacy data, the block-list
  // parser's unfiltered branch, or a non-fbrain client) surfaces as a stray
  // `,` separator in `fbrain get` / `fbrain list`, inflates `r.tags.length`,
  // and — worst — propagates back to the server on the next `put` / `link`
  // / `migrate`, since those write paths preserve `existing.tags` verbatim
  // (`put.ts:buildFields` `tags: tags ?? existing?.tags ?? []`).
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === "string" && x.length > 0);
  }
  if (typeof v === "string" && v.length > 0) {
    return v
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

export async function listRecords(
  node: NodeClient,
  type: RecordType,
  schemaHash: string,
): Promise<FbrainRecord[]> {
  const res = await node.queryAll({ schemaHash, fields: fieldsFor(type) });
  return res.results.map((row) => rowToRecord(row, type));
}

// The body-less identity of a live record — slug, when it last changed, and
// its tags (needed only to drop tombstones). This is the SHAPE the BM25 cache
// fingerprint is computed over (see `computeFingerprint`), so a record listed
// this way produces the same fingerprint as one fetched in full.
export type RecordKey = {
  type: RecordType;
  slug: string;
  updatedAt: string;
};

// The minimal `/api/query` projection that still answers "did the corpus
// change?". `ask` runs this BEFORE deciding whether to do a full body fetch:
// on a warm cache hit the body fetch is skipped entirely, turning the corpus
// load from O(all records, full bodies) into O(this cheap listing). We pull
// slug + updated_at for the fingerprint, and tags only to drop tombstones (a
// soft-deleted record must not contribute to the fingerprint, exactly as the
// full corpus build excludes it). Critically NO `body` / `title` / `status` —
// those are the heavy fields whose repeated fetch this card removes.
//
// `computeFingerprint` over the returned keys MUST equal the fingerprint a
// full `loadBm25Documents` + `BM25Index.build` stamps for the same corpus, so
// the two paths share `tombstone` semantics: both drop `TOMBSTONE_TAG` rows.
export async function listRecordKeys(
  node: NodeClient,
  type: RecordType,
  schemaHash: string,
): Promise<RecordKey[]> {
  const res = await node.queryAll({
    schemaHash,
    fields: ["slug", "tags", "updated_at"],
  });
  const keys: RecordKey[] = [];
  for (const row of res.results) {
    const f = (row.fields ?? {}) as Record<string, unknown>;
    // Reuse the same tombstone test the full path uses: build the tag list
    // through the shared array parser so a phantom empty tag / string-encoded
    // list can't make the two paths disagree on what's live.
    const tags = arrayStringField(f, "tags");
    if (tags.includes(TOMBSTONE_TAG)) continue;
    keys.push({
      type,
      slug: stringField(f, "slug"),
      updatedAt: stringField(f, "updated_at"),
    });
  }
  return keys;
}

// Page size for the no-match probe/hint paths (`hasAnyLiveRecord`,
// `listLiveSlugsPage`). Matches the node's own `/api/query` default page
// (DEFAULT_QUERY_LIMIT=100 in fold_db_node) — small enough that a probe on a
// populated brain stays a single cheap round trip, large enough that a page
// made entirely of tombstones is vanishingly unlikely to hide a live record.
export const NO_MATCH_PROBE_PAGE_LIMIT = 100;

// The two projections the no-match paths need: `tags` to drop tombstones,
// `slug` for the nearest-slug hint. Critically NO `body`/`title` — those are
// the heavy fields whose fetch on every no-match path this projection removes.
const LIVE_SLUG_PAGE_FIELDS = ["slug", "tags"];

// ONE small `/api/query` page of live (non-tombstoned) slugs for a schema —
// slug+tags projection only, `limit` rows max, never paginated. This is the
// bounded primitive behind the no-match hint paths: the empty-brain probe
// (`hasAnyLiveRecord`) and the MCP fbrain_get nearest-slug candidate scan.
// Both are best-effort decoration, so sampling the first page is the
// contract — callers that need the COMPLETE row set use `listRecords` /
// `listRecordKeys` (paginated, guarded) instead. Falls back to `queryAll`
// only for a NodeClient without `queryPage` (hand-built test mocks); the
// real client always has it.
export async function listLiveSlugsPage(
  node: NodeClient,
  schemaHash: string,
  limit: number = NO_MATCH_PROBE_PAGE_LIMIT,
): Promise<string[]> {
  const rows = node.queryPage
    ? await node.queryPage({ schemaHash, fields: LIVE_SLUG_PAGE_FIELDS, limit })
    : (await node.queryAll({ schemaHash, fields: LIVE_SLUG_PAGE_FIELDS })).results.slice(
        0,
        limit,
      );
  const slugs: string[] = [];
  for (const row of rows) {
    const f = (row.fields ?? {}) as Record<string, unknown>;
    // Same tombstone test the full read path uses, via the shared array
    // parser, so a phantom empty tag / string-encoded list can't make the
    // probe disagree with `listRecords` on what's live.
    const tags = arrayStringField(f, "tags");
    if (tags.includes(TOMBSTONE_TAG)) continue;
    slugs.push(stringField(f, "slug"));
  }
  return slugs;
}

// Cheap "does this brain hold ANY live record?" probe, used only on the
// search/ask/list no-match path to distinguish a brand-new EMPTY brain (a new
// dev who hasn't created anything yet) from a populated brain whose query
// simply matched nothing. Walks fbrain's distinct schema hashes and asks each
// for ONE small slug+tags page (`listLiveSlugsPage` — never a paginated
// full-field fetch), returning true on the FIRST live (non-tombstone) row
// seen. The types in `RECORD_TYPES` collapse onto a handful of unique schema
// hashes (the Phase 6 types share the unified MEMO hash), so this is at most
// a few single-page round trips and short-circuits the instant any record is
// found.
//
// Returns `false` only when every schema hash comes back with no live row —
// i.e. the empty-brain case. Errors propagate (a probe that can't reach the
// node should surface, not silently claim "empty").
export async function hasAnyLiveRecord(
  node: NodeClient,
  cfg: { schemaHashes: Record<string, string> },
): Promise<boolean> {
  const hashes = uniqueSchemaHashes(cfg, RECORD_TYPES);
  for (const schemaHash of hashes) {
    let slugs: string[];
    try {
      slugs = await listLiveSlugsPage(node, schemaHash);
    } catch (err) {
      if (isSchemaNotFoundReadError(err)) continue;
      throw err;
    }
    if (slugs.length > 0) return true;
  }
  return false;
}

export async function findBySlug(
  node: NodeClient,
  type: RecordType,
  schemaHash: string,
  slug: string,
): Promise<FbrainRecord | null> {
  const r = await findBySlugRaw(node, type, schemaHash, slug);
  if (r === null) return null;
  return isTombstoned(r) ? null : r;
}

// Unfiltered variant — returns tombstoned records too. Only `fbrain delete`
// needs this (to verify its own soft-delete landed). All other read paths
// MUST use `findBySlug` so they treat tombstones as gone.
// POINT-READ by key: the node resolves `filter:{HashKey:<slug>}` as an indexed
// key lookup (records are slug-keyed), so this never scans the schema. This
// replaced a `listRecords` full scan — the full-scan latency + its intermittent
// empty-page flake were the SOLE reason the read/write paths grew a fast-miss +
// empty-page-retry loop; a keyed point-read has neither (measured 0/20 flakes,
// put→read visible in ~32ms), so those workarounds are deleted below. The
// `queryAll` fallback stays only for an old node build without keyed queries.
export async function findBySlugRaw(
  node: NodeClient,
  type: RecordType,
  schemaHash: string,
  slug: string,
): Promise<FbrainRecord | null> {
  const fields = fieldsFor(type);
  const row = node.queryByKey
    ? await node.queryByKey({ schemaHash, fields, keyHash: slug })
    : (await node.queryAll({ schemaHash, fields })).results.find(
        (r) => r.key?.hash === slug || r.fields?.slug === slug,
      ) ?? null;
  return row === null ? null : rowToRecord(row, type);
}

// Tombstone-filtered point-read. Identical to `findBySlug` now that the base
// lookup is keyed; kept as a named export for the call sites that use it.
export async function findBySlugPointRead(
  node: NodeClient,
  type: RecordType,
  schemaHash: string,
  slug: string,
): Promise<FbrainRecord | null> {
  return findBySlug(node, type, schemaHash, slug);
}

// Read-flake retry — docs/phase-7-search-latency-spike.md (H2 polluted-daemon
// case). The same /api/query intermittently returns 0 results on a daemon
// whose top-50 budget is saturated by phantom embeddings + orphan schemas:
// `fbrain put` lands and `fbrain search` returns the row, but `fbrain get`
// flakes ~1/5 of the time. scripts/parity-smoketest.sh rides this out by
// retrying each `fbrain get` 5× at 250 ms; the user-facing CLI now does the
// same so users don't see "No record" for a row they just wrote.
//
// 5 × 250 ms is the smoketest's empirical setting — adjust together, not
// independently, if the upstream G3d/G3e fix changes the flake rate.
export const READ_RETRY_ATTEMPTS = 5;
export const READ_RETRY_BACKOFF_MS = 250;

// Empty-page retry cap for the fast-miss helper (`findBySlugWithFastMiss`).
// Separate from READ_RETRY_ATTEMPTS because the fast-miss loop ONLY retries
// on an empty page — every other branch (populated-with-hit, populated-
// without-hit) returns on the first attempt. On a fresh / sparsely-populated
// node, every record type's page is empty until its first record lands, so
// burning the full 5×250 ms budget on every "first-write-of-a-type" turned
// the new-developer Quick-Start into a ~1.2 s-per-write cliff (measured
// 2026-06-05). On `fbrain get`/`delete`, the cost compounds across the
// 8-type resolution sweep + the dangling-ref validators — ~56 queries to
// fetch one record when 5 of the 8 type pages are empty.
//
// Cap = 2 keeps a single retry for the documented saturated-daemon empty-
// result flake (the row exists but `/api/query` returns []) while making the
// fresh-node case cost ~1 extra query (~250 ms) instead of ~1100 ms.
// Verify-after-write callers that *expect* the row to exist still go through
// `withReadRetry` with the full budget — they are not affected.
export const EMPTY_PAGE_RETRY_ATTEMPTS = 2;

export type ReadRetryOptions = {
  maxAttempts?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  // Cap on retries when the queried page comes back empty (the only branch
  // that retries inside `findBySlugWithFastMiss`). Defaults to
  // `EMPTY_PAGE_RETRY_ATTEMPTS`. Tests override this together with `sleep`
  // to pin the count without paying real backoff.
  emptyPageAttempts?: number;
  // Number of CONSECUTIVE positive probes the vector-index confirmation
  // (`verifyVectorIndexed`) requires before reporting the slug stably visible.
  // Defaults to `VECTOR_INDEX_VERIFY_CONSECUTIVE`. The fold_db native index's
  // visibility FLICKERS — a single positive hit does not mean the row is
  // queryable on the very next call — so one transient hit is not enough to
  // honestly report `indexPending: false`. Tests pin this together with
  // `maxAttempts`/`sleep` to assert the consecutive-hit contract without
  // paying real backoff.
  consecutiveHits?: number;
};

// Pure schedule: how long to wait *before* attempt N (1-based). Constant
// `ceilingMs` today — first attempt skips the wait, subsequent attempts pause
// for the ceiling. Splitting this out lets tests pin the schedule's contract
// (monotonic, capped) independently of the retry driver, and lets the schedule
// grow later (linear/exponential/jittered) without touching `withReadRetry`.
export function computeBackoffMs(
  attempt: number,
  ceilingMs: number = READ_RETRY_BACKOFF_MS,
): number {
  if (attempt <= 1) return 0;
  return ceilingMs;
}

// Re-run `fn` up to `maxAttempts` times, sleeping per `computeBackoffMs`
// between tries, until `isHit(result)` returns true. Returns the last result
// either way — callers handle the genuine-miss case (surfaces the existing
// "No record" error after the retry budget is spent, same UX as today on a
// real miss).
//
// The retry wraps the full per-type query loop, not each HTTP call: a hit
// in one type cancels further retries, and a real miss across all types
// retries the whole sweep. Mirrors what the smoketest does in bash.
export async function withReadRetry<T>(
  fn: () => Promise<T>,
  isHit: (result: T) => boolean,
  options?: ReadRetryOptions,
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? READ_RETRY_ATTEMPTS;
  const ceilingMs = options?.backoffMs ?? READ_RETRY_BACKOFF_MS;
  const sleep = options?.sleep ?? defaultSleep;
  let result!: T;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const wait = computeBackoffMs(attempt, ceilingMs);
    if (wait > 0) await sleep(wait);
    result = await fn();
    if (isHit(result)) return result;
  }
  return result;
}

// Shared per-type slug lookup used by both the write existence check
// (`findExistingForWrite`) and the read sweep (`resolveBySlug`). Now a keyed
// point-read (see the body) — the former full-scan fast-miss / empty-page-retry
// loop is gone. The `raw` flag mirrors `findBySlug` (tombstone-filtered) vs
// `findBySlugRaw` (tombstoned rows returned; only `delete`'s raw path uses it).
async function findBySlugWithFastMiss(
  node: NodeClient,
  type: RecordType,
  schemaHash: string,
  slug: string,
  raw: boolean,
  _options?: ReadRetryOptions,
): Promise<FbrainRecord | null> {
  // Keyed point-read — no full scan, so none of the fast-miss / empty-page-retry
  // machinery this used to carry is needed: a keyed lookup is unambiguous (found
  // or not) and doesn't hit the full-scan empty-result flake the retry rode out
  // (measured 0/20 flakes; put→read visible ~32ms). `_options` (the retry
  // budget) is now vestigial, kept only for signature compatibility. Read-your-
  // writes safety still lives in `verifyRecordVisible` (put's read-back), which
  // retries a point-read across the mutation-visibility window.
  return raw
    ? findBySlugRaw(node, type, schemaHash, slug)
    : findBySlug(node, type, schemaHash, slug);
}

// Existence check for the WRITE path (`fbrain put`, `<type> new`). The write
// must decide create-vs-update by asking "does this slug already exist?" — but
// unlike a read (`get`/`status`/`delete`), where the user asserts the row
// exists and a `withReadRetry(findBySlug, r => r !== null)` rides out the
// daemon's read flake before surfacing not-found, the write has no such
// assertion: a brand-new slug is *expected* to be absent. Wrapping the write's
// existence check in the same retry made the `r !== null` predicate unreachable
// for every new slug, so each create burned the FULL retry budget (~1.1s of
// pure backoff sleep) before falling through to `createRecord`. Measured
// 2026-06-05: create ~1200 ms vs. update ~95 ms, purely from this.
//
// Follow-up (2026-06-05): the populated-page fast-miss above closed the
// "create with EXISTING siblings in the same type" case (~95 ms), but the
// EMPTY-page branch still burned the full READ_RETRY_ATTEMPTS budget on a
// fresh node — making the first write of every type ~7× slower than every
// subsequent write (~1230 ms vs ~170 ms). The empty branch now caps at
// EMPTY_PAGE_RETRY_ATTEMPTS (default 2) so a fresh-node first-write costs
// ~one extra query (~250 ms worst case) instead of ~1.1 s of backoff, while
// still absorbing a single saturated-daemon flake.
//
// `resolveBySlug` (read sweep) shares the same fix via the same helper —
// `fbrain get <typo>` had the symmetric problem (~1.1s before "No record")
// for the same reason. See `findBySlugWithFastMiss` above for the shared
// loop's contract. Tombstoned rows count as absent, mirroring `findBySlug`,
// so re-creating a soft-deleted slug still lands a fresh record.
export async function findExistingForWrite(
  node: NodeClient,
  type: RecordType,
  schemaHash: string,
  slug: string,
  options?: ReadRetryOptions,
): Promise<FbrainRecord | null> {
  return findBySlugWithFastMiss(node, type, schemaHash, slug, false, options);
}

// Verify-after-write helper. Used by `fbrain put` after `createRecord` /
// `updateRecord` resolves: read the row back with the FULL withReadRetry
// budget (5×250 ms) before reporting "created"/"updated" to the caller. The
// underlying fold_db `/api/mutation` is not read-your-writes consistent —
// the write returns before the row is queryable — so a tight put→get loop
// (especially the MCP-agent path, where get fires in the same warm process
// with no bun cold-start to mask the visibility window) saw the just-
// written row as "No record". The capped `findBySlugFast` short-circuits
// on a populated page that lacks the slug (#174's fix for the typo'd-read
// latency cliff), which is correct for an unknown read but wrong for a
// verify after our own write — we *expect* the row to exist, so spending
// the full budget is the right tradeoff. Self-tuning: on a warm node the
// first read succeeds with no backoff; only when propagation actually lags
// do we burn any of the budget. Mirrors `deleteRecord`'s
// `withReadRetry(findBySlugRaw, ...)` — the existing in-repo precedent for
// "I just wrote it, prove it's visible".
//
// Uses `findBySlug` (tombstone-filtered), not `findBySlugRaw`: a successful
// `put` writes a non-tombstoned row, so a tombstoned read implies either a
// concurrent delete (rare; surfaces as `put_not_visible`, which is honest)
// or a serious daemon bug we should not paper over.
export async function verifyRecordVisible(
  node: NodeClient,
  type: RecordType,
  schemaHash: string,
  slug: string,
  options?: ReadRetryOptions,
): Promise<FbrainRecord | null> {
  return withReadRetry(
    () => findBySlug(node, type, schemaHash, slug),
    (r) => r !== null,
    options,
  );
}

// Vector-index visibility check for the WRITE confirmation path (MCP
// `fbrain_put` only — see mcp/server.ts). `verifyRecordVisible` above proves
// the row is queryable via /api/query (the record-list / BM25 surface that
// `ask` and `list` read), but it says NOTHING about the NATIVE (vector) index
// that `fbrain_search` and `ask`'s vector leg read: fold_db indexes the
// embedding asynchronously AFTER the mutation returns, so a tight
// put→search in one warm process (the MCP-agent loop) lands inside a
// sub-second-to-~1s window where the row is record-list-visible but NOT yet
// in the vector index, and `fbrain_search` returns every OTHER record except
// the one just written. We close that window at the confirmation layer:
// after the put's `verifyRecordVisible` passes, poll the native index until
// the slug appears among the hits for a probe query (the record's own
// title/slug text, scoped to its schema hash) on a SHORT bounded budget.
//
// Returns true once the slug is STABLY in the index — see the consecutive-hit
// rule below — false if the budget is spent without confirming stability (the
// caller reports `indexPending: true` — an honest "your write landed but the
// vector index hasn't caught up yet" signal — and never fails the write).
// Distinct, tighter budget than the record-list retry: the vector index lags by
// a known sub-second window, so a few quick attempts cover the common case
// without adding noticeable latency to a put that has already confirmed
// record-list visibility. Errors from the probe are swallowed (treated as "not
// yet visible" for that attempt) — a flaky search must never fail or block a
// write that already persisted.
//
// CONSECUTIVE-HIT RULE (this is the read-after-write honesty fix): fold_db's
// native-index visibility FLICKERS during the post-mutation indexing window —
// the slug can surface on one probe and then be MISSING on the very next call.
// So a single positive probe is NOT proof the record is stably queryable; the
// old "return on the first hit" criterion made `indexPending: false` a false
// positive (the agent's `put` → immediate `search` loop dropped just-written
// records 6/6 in dogfood run 76, 2026-06-19). We now require the slug to appear
// on `consecutiveHits` probes IN A ROW (default 2) before declaring it visible;
// any miss resets the streak. Only a stable streak — the same signal a real
// user's next `search` will hit — clears `indexPending`. The budget is sized so
// the common warm case (index caught up) still confirms sub-second: the first
// probe + one confirming probe, no backoff burned until propagation actually
// lags.
export const VECTOR_INDEX_VERIFY_ATTEMPTS = 6;
export const VECTOR_INDEX_VERIFY_BACKOFF_MS = 350;
// Consecutive positive probes required to call the slug stably visible.
export const VECTOR_INDEX_VERIFY_CONSECUTIVE = 2;

export async function verifyVectorIndexed(
  node: NodeClient,
  schemaHash: string,
  slug: string,
  query: string,
  options?: ReadRetryOptions,
): Promise<boolean> {
  const maxAttempts = options?.maxAttempts ?? VECTOR_INDEX_VERIFY_ATTEMPTS;
  const ceilingMs = options?.backoffMs ?? VECTOR_INDEX_VERIFY_BACKOFF_MS;
  const needConsecutive = Math.max(1, options?.consecutiveHits ?? VECTOR_INDEX_VERIFY_CONSECUTIVE);
  const sleep = options?.sleep ?? defaultSleep;

  // Dedicated loop (not `withReadRetry`, whose isHit stops at the FIRST hit):
  // we need a running streak of consecutive hits, with any miss resetting it.
  let streak = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const wait = computeBackoffMs(attempt, ceilingMs);
    if (wait > 0) await sleep(wait);
    let hit = false;
    try {
      const hits = await node.search(query, { schemas: [schemaHash], localFallback: false });
      hit = hits.some((h) => h.key_value?.hash === slug);
    } catch {
      // A flaky/unavailable native index must not fail a persisted write —
      // treat the probe error as a miss (resets the streak) so the loop either
      // recovers into a fresh streak or times out into the honest
      // `indexPending` signal.
      hit = false;
    }
    streak = hit ? streak + 1 : 0;
    if (streak >= needConsecutive) return true;
  }
  return false;
}

// CLI write-path read-after-write confirmation, shared by `putCmd` and
// `recordNew`. After the write's record-list verify-read passes, confirm the
// record also landed in the NATIVE (vector) index that `fbrain search` reads —
// closing the same put→search window the MCP path closes (mcp/server.ts), so a
// human's first `fbrain search` after their first create returns the record.
//
// Returns `indexPending`: false once the slug is in the vector index, true if
// the bounded budget is spent without seeing it (the caller appends an honest
// "index still catching up" note). NEVER throws — a flaky/unreachable native
// index, or a non-loopback / remote node, must not fail or block a write that
// already persisted. Specifically:
//   - Non-loopback node → returns false (not pending). The lag only matters for
//     a tight LOCAL create→search; over a remote node the extra round-trips
//     aren't worth it, so we report "indexed" rather than nagging the user.
//   - Any probe/transport error → swallowed exactly like the MCP path; treated
//     as "not yet visible" (indexPending: true) so the honest note appears
//     rather than a thrown error on a write that already succeeded.
//
// `options` threads the same tunables the record-list verify uses, so tests can
// pin the attempt count and inject a no-op sleep (see put.test.ts).
export async function confirmVectorIndexed(
  cfg: Config,
  type: RecordType,
  slug: string,
  title: string,
  options?: ReadRetryOptions,
): Promise<{ indexPending: boolean }> {
  // Gate to local-node writes — the vector-index lag is only a paper cut for a
  // tight local create→search; keep remote writes cheap (no extra round-trips).
  if (!isLoopbackNodeUrl(cfg.nodeUrl)) return { indexPending: false };
  try {
    const node = newReadClientFromCfg(cfg);
    const schemaHash = schemaHashFor(type, cfg);
    const probe = title.trim() || slug;
    const visible = await verifyVectorIndexed(node, schemaHash, slug, probe, options);
    return { indexPending: !visible };
  } catch {
    // A confirmation-probe failure (config/transport) must never fail a write
    // that already persisted — report the index as pending so the user knows
    // an immediate `fbrain search` may miss it and to retry shortly.
    return { indexPending: true };
  }
}

// Read-context alias for the same fast-miss helper. The dangling-reference /
// liveness validators in `new`, `link`, `get`, and `search` previously wrapped
// `findBySlug` in `withReadRetry(fn, r => r !== null)` to ride out the daemon's
// empty-result flake — but on a slug that genuinely does not exist (a typo'd
// `--design`, a stale search hit, a deleted parent), the `r !== null` predicate
// is unreachable and every miss burns the full 5×250 ms retry budget. The
// fast-miss loop short-circuits on a populated-but-missing page (authoritative
// miss) while still spending the budget on an empty page (saturated-daemon
// flake), so it is strictly better than the old pattern: same flake recovery,
// no wasted budget on a real miss, identical behavior on a hit. The `*ForWrite`
// name reads wrong in a validator, so this alias names the read-context
// callers — semantics are identical, so it's a literal reference to the same
// function rather than a re-wrap of `findBySlugWithFastMiss` (which used to
// duplicate the wrapper verbatim and risked the two sides drifting under a
// future tweak to the args).
export const findBySlugFast = findExistingForWrite;

// Batch hydrate for the SEARCH resolver. `fbrain search` resolves N deduped
// hits to their full records; pre-fix it called `findBySlugFast` once per hit,
// and `findBySlugFast` fetches the WHOLE schema page (`listRecords` →
// `queryAll`) and client-filters for one slug. So a 50-hit search that all
// lands on one schema (the common case — Design, Task, and the unified MEMO
// share at most 3 distinct hashes) issued ~50 identical full-schema fetches,
// each ~0.5–2 s, throwing away every row but one. Pure N+1 read amplification;
// the dominant cost of `search` (~25–29 s on the live brain — dogfood run 115).
//
// This collapses the loop to ONE fetch per distinct schema: hydrate the whole
// page once into a `Map<slug, FbrainRecord>` keyed by slug, and the caller
// resolves every hit on that schema by map lookup. Live (non-tombstoned) rows
// only — a tombstoned row is omitted from the map, so a hit whose record was
// soft-deleted since indexing resolves to `undefined` and the caller skips it
// as stale, exactly as `findBySlugFast` returning null did per hit.
//
// Empty-page flake tolerance is preserved, just hoisted from per-hit to
// per-schema: the same EMPTY-page retry the fast-miss helper applies (an empty
// `/api/query` slice on a saturated daemon is ambiguous — flake vs. genuinely
// empty schema — so retry up to `EMPTY_PAGE_RETRY_ATTEMPTS`; a NON-empty page
// is authoritative and stops immediately). A non-empty page missing a given
// slug is an authoritative stale hit for that slug — identical observable
// behavior to the old per-hit path, with the retry budget paid once for the
// schema instead of once per hit on it.
export async function hydrateSchemaBySlug(
  node: NodeClient,
  type: RecordType,
  schemaHash: string,
  options?: ReadRetryOptions,
): Promise<Map<string, FbrainRecord>> {
  const maxAttempts = options?.emptyPageAttempts ?? EMPTY_PAGE_RETRY_ATTEMPTS;
  const ceilingMs = options?.backoffMs ?? READ_RETRY_BACKOFF_MS;
  const sleep = options?.sleep ?? defaultSleep;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const wait = computeBackoffMs(attempt, ceilingMs);
    if (wait > 0) await sleep(wait);
    const list = await listRecords(node, type, schemaHash);
    if (list.length > 0) {
      const bySlug = new Map<string, FbrainRecord>();
      for (const r of list) {
        // Drop tombstones so a soft-deleted slug resolves to `undefined`
        // (stale skip), mirroring `findBySlug`. Last live row wins on the
        // vanishingly-rare duplicate-slug-per-schema case; the write path's
        // per-type uniqueness guard makes that a non-issue in practice.
        if (!isTombstoned(r)) bySlug.set(r.slug, r);
      }
      return bySlug;
    }
    // Empty page ⇒ ambiguous; retry up to EMPTY_PAGE_RETRY_ATTEMPTS to ride
    // out a single saturated-daemon flake before declaring the schema empty.
  }
  return new Map();
}

// Reverse-direction lookup: live (non-tombstoned) tasks whose `design_slug`
// matches the given parent. Mirrors `findBySlugWithFastMiss`'s cost discipline
// — a populated task page is authoritative (return the filtered slice with no
// retry, even if zero rows match), only an EMPTY task page retries (capped at
// `EMPTY_PAGE_RETRY_ATTEMPTS`) to ride out the saturated-daemon empty-result
// flake. Without that cap, every `fbrain get <design>` on a fresh node — where
// the task schema page is legitimately empty until its first task lands —
// would burn the full 5×250 ms read-retry budget just to confirm "no children",
// re-introducing the first-write-of-a-type latency cliff that
// `findBySlugWithFastMiss` fixed for the forward direction.
export async function findChildTasksByDesign(
  node: NodeClient,
  taskSchemaHash: string,
  designSlug: string,
  options?: ReadRetryOptions,
): Promise<FbrainRecord[]> {
  const maxAttempts = options?.emptyPageAttempts ?? EMPTY_PAGE_RETRY_ATTEMPTS;
  const ceilingMs = options?.backoffMs ?? READ_RETRY_BACKOFF_MS;
  const sleep = options?.sleep ?? defaultSleep;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const wait = computeBackoffMs(attempt, ceilingMs);
    if (wait > 0) await sleep(wait);
    const list = await listRecords(node, "task", taskSchemaHash);
    if (list.length > 0) {
      return list.filter(
        (r) => !isTombstoned(r) && r.design_slug === designSlug,
      );
    }
    // Empty page ⇒ ambiguous (fresh node vs. saturated-daemon flake); retry
    // up to EMPTY_PAGE_RETRY_ATTEMPTS before declaring "no children".
  }
  return [];
}

export async function findBacklinks(
  node: NodeClient,
  cfg: { schemaHashes: Record<string, string> },
  targetSlug: string,
  options?: { targetType?: RecordType },
): Promise<Backlink[]> {
  const normalized = normalizeSlug(targetSlug);
  const bySource = new Map<string, Backlink>();

  for (const type of RECORD_TYPES) {
    const schemaHash = cfg.schemaHashes[type];
    if (schemaHash === undefined) continue;
    const records = await listRecords(node, type, schemaHash);
    for (const record of records) {
      if (isTombstoned(record)) continue;
      const via = backlinkVia(record, type, normalized, options?.targetType);
      if (via.length === 0) continue;

      const key = `${type}:${record.slug}`;
      const existing = bySource.get(key);
      if (existing) {
        existing.via = mergeVia(existing.via, via);
      } else {
        bySource.set(key, {
          type,
          slug: record.slug,
          status: record.status,
          via,
          updated_at: record.updated_at,
        });
      }
    }
  }

  return Array.from(bySource.values()).sort(compareBacklinks);
}

function backlinkVia(
  record: FbrainRecord,
  sourceType: RecordType,
  targetSlug: string,
  targetType: RecordType | undefined,
): BacklinkVia[] {
  const via: BacklinkVia[] = [];

  if (
    sourceType === "task" &&
    record.design_slug === targetSlug &&
    (targetType === undefined || targetType === "design")
  ) {
    via.push("explicit");
  }

  for (const tag of record.tags) {
    const parsed = parseGenericLinkTag(tag);
    if (!parsed) continue;
    if (parsed.to_slug !== targetSlug) continue;
    if (targetType !== undefined && parsed.to_type !== targetType) continue;
    via.push("explicit");
    break;
  }

  if (wikiLinkSlugs(record.body).includes(targetSlug)) via.push("body");
  return mergeVia([], via);
}

function mergeVia(existing: BacklinkVia[], incoming: BacklinkVia[]): BacklinkVia[] {
  const out = new Set<BacklinkVia>(existing);
  for (const item of incoming) out.add(item);
  return Array.from(out).sort();
}

function compareBacklinks(a: Backlink, b: Backlink): number {
  const byUpdated = b.updated_at.localeCompare(a.updated_at);
  if (byUpdated !== 0) return byUpdated;
  const byType = a.type.localeCompare(b.type);
  if (byType !== 0) return byType;
  return a.slug.localeCompare(b.slug);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Best-effort cross-type slug collision probe for the CREATE verbs. Slugs are
// unique PER TYPE (the same-type duplicate guard enforces that), but a slug is
// allowed to collide ACROSS types — `task new wire-login` then `design new
// wire-login` both succeed. The catch is that every read/update verb is keyed
// by BARE slug, so after a cross-type collision a bare-slug `get`/`status`/
// `delete` dead-ends with `ambiguous_slug`. This probe lets the create verbs
// warn the developer at the moment they create the collision, instead of
// leaving them to discover the trap later with no breadcrumb back to its cause.
//
// `selfType` is excluded (its own duplicate guard already ran). The remaining
// types are probed in parallel via `findBySlugFast` (the fast-miss helper), so
// this is ~one round-trip's worth of latency, not 7 serial ones. It is STRICTLY
// best-effort: any probe failure/timeout is swallowed and the affected type is
// simply treated as "no collision" — a flaky probe must NEVER block or fail the
// create. Returns the OTHER types that already hold the slug (empty ⇒ no note).
export async function findCrossTypeSlugCollisions(
  node: NodeClient,
  cfg: Config,
  selfType: RecordType,
  slug: string,
): Promise<RecordType[]> {
  const others = RECORD_TYPES.filter((t) => t !== selfType);
  const hits = await Promise.all(
    others.map(async (t): Promise<RecordType | null> => {
      try {
        const hash = schemaHashFor(t, cfg);
        const existing = await findBySlugFast(node, t, hash, slug);
        return existing ? t : null;
      } catch {
        // Best-effort: a probe error/timeout on one type just skips that type.
        return null;
      }
    }),
  );
  return hits.filter((t): t is RecordType => t !== null);
}

// Render the cross-type collision note for the create verbs. Returns null when
// there is no collision (so callers can skip the stderr write entirely). The
// note goes to STDERR only — it must not perturb the `created …` stdout line or
// any `--json` contract. It names the `--type` flag concretely so a new dev
// knows exactly how to disambiguate the bare-slug reads that will now be
// ambiguous.
export function crossTypeSlugNote(
  selfType: RecordType,
  slug: string,
  collisions: readonly RecordType[],
): string | null {
  if (collisions.length === 0) return null;
  const also =
    collisions.length === 1
      ? `a ${collisions[0]}`
      : `${collisions.slice(0, -1).join(", ")} and ${collisions[collisions.length - 1]} records`;
  return (
    `note: slug "${slug}" also exists as ${also} — bare-slug get/status/delete ` +
    `will now need --type (e.g. \`fbrain get ${slug} --type ${selfType}\`).`
  );
}

export type ResolvedRecord = {
  type: RecordType;
  record: FbrainRecord;
};

export const GET_RECORD_TYPE_PRECEDENCE = [
  "reference",
  "project",
  "sop",
  "decision",
  "concept",
  "preference",
  "agent",
  "design",
  "task",
  "spike",
] as const satisfies readonly RecordType[];

// Canonical typed not_found wording shared by `get` and `delete` so the literal
// lives in one place. `resolveBySlug`'s built-in fallback intentionally stays
// the more generic `No record with slug "<s>".` (see record.test.ts).
export const NOT_FOUND_TYPED = {
  typed: (t: RecordType, s: string) => `No ${t}: ${s}`,
} as const;

export interface ResolveBySlugOpts {
  node: NodeClient;
  cfg: Config;
  slug: string;
  // Narrow the sweep to one type. Omit to scan every registered type.
  type?: RecordType;
  // Raw mode bypasses the tombstone filter at the lookup layer (findBySlugRaw)
  // so callers like `fbrain delete` can apply their own row-level logic. The
  // helper still drops tombstones afterward — there is no current caller that
  // wants to see them. Default false (uses tombstone-aware findBySlug).
  raw?: boolean;
  // Extra per-row filter applied after tombstone drop. Returning false skips
  // the row.
  filter?: (r: FbrainRecord, t: RecordType) => boolean;
  // Override the not_found error message. `typed` fires when opts.type is set;
  // `untyped` fires otherwise. Defaults match the pre-refactor strings.
  notFoundMessage?: {
    typed?: (t: RecordType, slug: string) => string;
    untyped?: (slug: string) => string;
  };
  // The CLI verb the caller is implementing. The ambiguous-slug `hint` echoes
  // it so the suggested recovery command is runnable as-is for the command the
  // user actually ran (`fbrain status …`/`fbrain delete …`, not always `get`).
  // Three callers share this sweep; each passes its own verb. Defaults to
  // "get" so the throw stays well-formed for any future caller that omits it.
  recoveryVerb?: "get" | "status" | "delete";
  // Read-only callers can opt into deterministic ambiguity resolution while
  // mutating callers keep the safer default of erroring unless --type is set.
  ambiguousTypePrecedence?: readonly RecordType[];
  // Forwarded to the per-type lookup loop so tests can mock sleep / shrink
  // the budget without paying the real backoff schedule. Production callers
  // leave it unset and inherit the smoketest-tuned defaults.
  retryOptions?: ReadRetryOptions;
}

// Centralized "find a record by slug across record types, retry on
// read-flake, error on not-found / ambiguous" sweep. Three commands (get,
// status, delete) carried near-identical 25–35 line variants of this block
// before consolidation — see commit history for refactor/resolve-by-slug.
export async function resolveBySlug(opts: ResolveBySlugOpts): Promise<ResolvedRecord> {
  const types: readonly RecordType[] = opts.type
    ? [opts.type]
    : RECORD_TYPES.filter((t) => opts.cfg.schemaHashes[t] !== undefined);
  // Per-type retry, run in parallel. The previous shape wrapped one
  // outer withReadRetry around a sequential sweep that returned the
  // FIRST attempt with any hit — but the `/api/query` top-100 page
  // flake nulls a real row out of one schema's slice on the same
  // attempt another schema catches its row. With the outer-retry
  // shape, an untyped lookup of an ambiguous slug then surfaced as a
  // single match: `fbrain get` / `status` / `delete` would silently
  // operate on the one type that caught it and skip the sibling.
  // Giving each type its own retry budget lets the flaked type
  // recover within its own loop, so ambiguity is detected before the
  // helper returns.
  const perType = await Promise.all(
    types.map(async (t): Promise<ResolvedRecord | null> => {
      const hash = schemaHashFor(t, opts.cfg);
      // Same fast-miss + empty-page-retry loop as the write existence check.
      // Pre-fix this was `withReadRetry(findBySlug, r => r !== null)`, which
      // made the `r !== null` predicate unreachable for a typo'd slug —
      // every miss burned the full 5×250 ms retry budget. The shared helper
      // short-circuits on a populated-but-missing page (authoritative) and
      // only retries on an empty page (saturated-daemon flake).
      const row = await findBySlugWithFastMiss(
        opts.node,
        t,
        hash,
        opts.slug,
        opts.raw === true,
        opts.retryOptions,
      );
      if (row === null) return null;
      if (opts.raw && isTombstoned(row)) return null;
      if (opts.filter && !opts.filter(row, t)) return null;
      return { type: t, record: row };
    }),
  );
  const matches: ResolvedRecord[] = perType.filter(
    (m): m is ResolvedRecord => m !== null,
  );

  if (matches.length === 0) {
    const fallback = `No record with slug "${opts.slug}".`;
    const message =
      opts.type !== undefined
        ? (opts.notFoundMessage?.typed?.(opts.type, opts.slug) ?? fallback)
        : (opts.notFoundMessage?.untyped?.(opts.slug) ?? fallback);
    const memoryHint = memoryFilenameStemHint(opts.slug);
    // Mirror the ambiguous-slug throw below: carry a runnable, type-aware
    // recovery hint (+ channel-neutral agentHint) so a slug miss isn't a
    // dead end. Additive only — the `code` and `message` above are unchanged
    // (record.test.ts asserts them); just `hint`/`agentHint` light up.
    const verb = opts.recoveryVerb ?? "get";
    if (opts.type !== undefined) {
      // Typed lookup: the slug may exist under a DIFFERENT type that `--type`
      // hid. Point the dev at dropping the flag to widen the search.
      throw new FbrainError({
        code: "not_found",
        message,
        hint: appendHint(
          `No ${opts.type} with that slug. Drop --type to search every type (\`fbrain ${verb} ${opts.slug}\`), or \`fbrain list\` to see existing slugs.`,
          memoryHint?.hint,
        ),
        agentHint: appendHint(
          `Omit the \`type\` argument to search all record types, or call fbrain_list to see existing slugs.`,
          memoryHint?.agentHint,
        ),
      });
    }
    // Untyped lookup: every type was scanned, so the slug truly doesn't exist
    // anywhere — the recovery is to discover the real slugs.
    throw new FbrainError({
      code: "not_found",
      message,
      hint: appendHint(
        `Run \`fbrain list\` to see existing slugs (slugs are case-sensitive).`,
        memoryHint?.hint,
      ),
      agentHint: appendHint(
        `Call fbrain_list to see existing slugs (slugs are case-sensitive).`,
        memoryHint?.agentHint,
      ),
    });
  }

  if (matches.length > 1) {
    const preferredType = opts.ambiguousTypePrecedence?.find((t) =>
      matches.some((m) => m.type === t),
    );
    if (preferredType !== undefined) {
      return matches.find((m) => m.type === preferredType)!;
    }

    const matchedTypes = matches.map((m) => m.type).join(", ");
    // Name the exact recovery command, not just "Specify a `type`." — a new dev
    // shouldn't have to hunt that the flag is `--type`. The example uses the
    // first matched type so it's a runnable command, not a placeholder. The CLI
    // `hint` names the `--type` FLAG; the MCP server consumes `agentHint`
    // instead (its tools take a `type` ARGUMENT, not a CLI flag — see
    // mcp/server.ts and its test), so the flag spelling never leaks to agents.
    const exampleType = matches[0]!.type;
    throw new FbrainError({
      code: "ambiguous_slug",
      message: `Slug "${opts.slug}" exists in multiple schemas (${matchedTypes}). Specify a \`type\`.`,
      hint: `Re-run with --type, e.g. \`fbrain ${opts.recoveryVerb ?? "get"} ${opts.slug} --type ${exampleType}\`.`,
      agentHint: `Pass the \`type\` argument, e.g. type: "${exampleType}".`,
    });
  }

  return matches[0]!;
}

function appendHint(base: string, extra?: string): string {
  return extra === undefined ? base : `${base} ${extra}`;
}

function memoryFilenameStemHint(
  slug: string,
): { hint: string; agentHint: string } | undefined {
  if (!slug.includes("_")) return undefined;
  const path = `memory/${slug}.md`;
  const text = `MEMORY files are not fbrain slugs; read ${path} instead.`;
  return { hint: text, agentHint: text };
}

// Single source of truth for slug input normalization. Mirrors `put`'s
// silent normalization (put.ts: `resolveSlug` calls `.trim()` on both the
// positional arg and the frontmatter `slug:`), so reads/updates/links keyed
// on `" foo "` resolve the same record `put` stored under `"foo"`.
export function normalizeSlug(slug: string): string {
  return slug.trim();
}

// Shared "newest first, then slug ascending" record comparator. Both
// `fbrain get` (sorting a design's child tasks) and `fbrain list` (sorting
// the global sweep) need the same updated_at-desc + slug-asc ordering — the
// `list` sort additionally splits ties by `type` because (type, slug) is
// globally unique, but the date and final slug comparisons are identical.
// Standardized on `localeCompare` for the slug tie-break — slugs are
// kebab-case ASCII, so the result matches a plain `<`/`>` compare for any
// in-repo input. The function operates on bare records; callers wrapping
// records in `{type, record}` adapt at the call site (see `listCmd`).
export function compareByUpdatedThenSlug(
  a: FbrainRecord,
  b: FbrainRecord,
): number {
  const ts = Date.parse(b.updated_at) - Date.parse(a.updated_at);
  return ts !== 0 ? ts : a.slug.localeCompare(b.slug);
}

export function validateSlug(slug: string): void {
  if (slug.length === 0) {
    throw new FbrainError({
      code: "invalid_slug",
      message: "Slug must be non-empty.",
    });
  }
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(slug)) {
    // First-time-user trap: `fbrain design new "My Title"` lands the title
    // in the slug positional. Spotting spaces or uppercase in an otherwise-
    // free-form input is a strong hint they meant `--title`; surface the
    // exact slug we'd suggest so they can copy-paste.
    const looksLikeTitle = /\s/.test(slug) || /[A-Z]/.test(slug);
    const hint = looksLikeTitle
      ? `the first argument is a slug (identifier); pass your title with --title and use a slug like "${suggestSlug(slug)}".`
      : "Slugs are lowercase, start with a letter or digit, and use [a-z0-9-_].";
    throw new FbrainError({
      code: "invalid_slug",
      message: `Slug "${slug}" is invalid.`,
      hint,
    });
  }
}

// Best-effort conversion of a free-form title to a valid slug for the hint.
// Lowercase, collapse non-slug chars to `-`, trim leading/trailing `-`.
// Falls back to "my-record" if nothing usable survives so the user never
// sees `"".`
function suggestSlug(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "my-record";
}

export function ensureStatus(type: RecordType, status: string): void {
  if (!isValidStatus(type, status)) {
    const valid = statusValuesFor(type).join(" | ");
    throw new FbrainError({
      code: "invalid_status",
      message: `"${status}" is not a valid ${type} status.`,
      hint: `Valid: ${valid}`,
    });
  }
}

// ── Body-shrink guard (data-loss protection on re-put) ───────────────────
// `fbrain put` is a full REPLACE, and the MCP `fbrain_put` body defaults to
// empty. The natural agent loop `fbrain_get` (which WINDOWS a large body at
// ~40K chars) → edit → re-put therefore silently destroys the tail of any
// record larger than one get-window, and a status-only touch-up re-put with
// no body wipes the body entirely (the run132 clobber incident). This guard
// refuses a re-put that would shrink an existing non-empty body past a
// threshold unless the caller explicitly opts in (`--allow-shrink` /
// `allow_shrink: true`). It runs BEFORE any HTTP write, mirroring the
// pre-flight `validateSlug` / `ensureStatus` checks.

// Fraction of the existing body a re-put may drop before the guard trips.
// A re-put that keeps > (1 - THRESHOLD) of the old body is allowed silently
// (ordinary edits trim text); dropping MORE than this fraction — or clearing
// a non-empty body to empty — is treated as probable accidental truncation.
// 0.5 = "losing more than half the body is suspicious"; tuned to catch the
// windowed-get truncation (a 100K body re-put as its first 40K window drops
// 60% > 50%) while not tripping on normal editing.
export const BODY_SHRINK_THRESHOLD = 0.5;

// True when replacing `oldBody` with `newBody` would drop MORE than
// BODY_SHRINK_THRESHOLD of the existing body (including clearing a non-empty
// body to empty). An empty/absent existing body can never shrink — a first
// write or a re-put over an empty record is always fine.
export function wouldShrinkBody(oldBody: string, newBody: string): boolean {
  const oldLen = oldBody.length;
  if (oldLen === 0) return false;
  const dropped = oldLen - newBody.length;
  if (dropped <= 0) return false;
  return dropped / oldLen > BODY_SHRINK_THRESHOLD;
}

// Throw `body_shrink_guard` with an actionable hint when a re-put would
// shrink the existing body past the threshold. No-op when the write is safe,
// or when the caller opted into the shrink via `allowShrink`. The hint names
// the recovery: re-read the FULL body first (paginate a windowed get to the
// end), or pass the allow-shrink escape hatch for a deliberate truncation.
export function ensureNotShrinking(
  type: RecordType,
  slug: string,
  oldBody: string,
  newBody: string,
  allowShrink: boolean,
): void {
  if (allowShrink) return;
  if (!wouldShrinkBody(oldBody, newBody)) return;
  const oldLen = oldBody.length;
  const newLen = newBody.length;
  const pct = Math.round(((oldLen - newLen) / oldLen) * 100);
  const toEmpty = newLen === 0;
  throw new FbrainError({
    code: "body_shrink_guard",
    message:
      `Refusing to re-put ${type} "${slug}": the new body ` +
      (toEmpty
        ? `is EMPTY but the existing record has ${oldLen} chars`
        : `is ${newLen} chars, ${pct}% smaller than the existing ${oldLen}`) +
      ` — this looks like accidental truncation, not an edit.`,
    hint:
      "fbrain_put/`fbrain put` is a FULL REPLACE, not an append. If you did a " +
      "get→edit→re-put, note that `fbrain_get` WINDOWS large bodies (~40K chars) " +
      "— re-read the FULL body first (page a windowed get to the end via " +
      "`body_offset`), or use `fbrain_append` to add to the body without a " +
      "rewrite. To truncate on purpose, pass `--allow-shrink` (CLI) / " +
      "`allow_shrink: true` (MCP).",
    agentHint:
      "fbrain_put is a FULL REPLACE. fbrain_get windows large bodies (~40K " +
      "chars) — page the whole body (body_offset) before re-putting, or use " +
      "fbrain_append to add without a rewrite. Pass allow_shrink: true only to " +
      "truncate on purpose.",
  });
}
