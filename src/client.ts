// Typed HTTP wrappers for fold_db_node + schema_service.
//
// Every node endpoint sends X-User-Hash (per Phase 0 spike: missing →
// `401 MISSING_USER_CONTEXT`). All errors flow through `mapError` so
// every Error Registry row maps to an actionable message in exactly
// one place.

import { createHash } from "node:crypto";

import type { AddSchemaRequest, RecordType } from "./schemas.ts";

export type Verbose = (msg: string) => void;

const noopVerbose: Verbose = () => {};

// Per-write capability header names (mirror fold_db_node/src/handlers/caller.rs:
// APP_CAPABILITY_HEADER / CAPABILITY_TS_HEADER). Defined here — the lowest
// layer that writes them onto the wire — so capability.ts can import them
// without a circular dependency.
export const APP_CAPABILITY_HEADER = "X-App-Capability";
export const CAPABILITY_TS_HEADER = "X-Capability-Ts";

export type NativeIndexHit = {
  schema_name: string;
  schema_display_name?: string | null;
  field: string;
  key_value: { hash: string | null; range: string | null };
  value: string;
  metadata?: { fragment_idx?: number; match_type?: string; score?: number };
};

export type SearchOptions = {
  exact?: boolean;
  minScore?: number;
  // Schema names to restrict the search to (matched against IndexResult.schema_name).
  // When set + non-empty, fold_db filters EmbeddingIndex entries to this set
  // BEFORE the top-50 cosine cut — so unrelated schemas on a shared daemon
  // (Persona, User Accounts, Contacts, CalendarEvent, …) cannot drown fbrain
  // hits out of the top-K. Empty / omitted ⇒ no filter (unfiltered). Needs
  // fold_db `feat(native-index): schema-scoped search filter` (PR #264); older
  // daemons silently ignore the param so this is safe to send unconditionally.
  //
  // Under app_identity v3.1 this filter is largely REDUNDANT: fbrain's schemas
  // are namespaced under `fbrain/*` (owner_app_id folds into the identity hash),
  // so the hashes fbrain queries no longer collide with other apps' schemas on
  // a shared daemon. The design's optional `X-App-ID` read hint is the eventual
  // replacement. We keep this filter for now — it stays correct (it filters by
  // the app-namespaced hash) and harmless, and it protects search quality
  // during the migration window before every node carries namespaced data.
  schemas?: string[];
};

export type RegisteredSchema = {
  name: string;
  descriptive_name: string;
  schema_type: string;
  fields: string[];
  field_types: Record<string, unknown>;
  identity_hash?: string;
  source?: string;
};

export type RawResponse = {
  status: number;
  headers: Headers;
  body: string;
  json: unknown;
};

export type QueryRow = {
  fields: Record<string, unknown>;
  key: { hash: string | null; range: string | null };
  // The base64-encoded ed25519 public key of whoever wrote the record's
  // head atoms. `pubkeyToUserHash` derives the fold_db user_hash from it
  // for telemetry (G13 `fbrain doctor --usage`).
  author_pub_key?: string;
  // metadata also exists (per-field atom_uuid + writer_pubkey) but only
  // author_pub_key is needed by current code paths.
};

export type QueryResponse = {
  ok: boolean;
  results: QueryRow[];
  total_count?: number;
  returned_count?: number;
  has_more?: boolean;
};

// Single-request page size for the `/api/query` pagination loop. The node
// caps individual page requests at MAX_QUERY_LIMIT (1000); we ride that
// cap directly so a database of N records resolves in ceil(N/1000) round
// trips. The server's INTERNAL_FETCH_CAP (10000) is a separate ceiling
// on the post-filter result set per-request — beyond that the node sets
// `has_more` and we'd need to keep iterating.
export const QUERY_PAGE_SIZE = 1000;

// Safety cap to prevent an infinite pagination loop if the node ever
// returns `has_more: true` together with an empty `results` page. At a
// page size of 1000 this still permits 1,000,000 records before bailing
// — well beyond fbrain's expected scale, but bounded.
export const QUERY_PAGE_LIMIT = 1000;

// Detail fields carried by a capability 403 (the node may include `schema`,
// `capability_id`, or `timestamp_skew_secs` depending on the reason).
export type Capability403Detail = {
  schema?: string;
  capabilityId?: string;
  timestampSkewSecs?: number;
};

export class FbrainError extends Error {
  readonly code: string;
  readonly hint?: string;
  // Channel-neutral alternative to `hint` for non-interactive callers (the
  // MCP server). `hint` carries CLI/brew remediation an agent can't run
  // (`fbrain doctor`, `folddb daemon …`); when an error sets `agentHint` the
  // MCP boundary shows that instead. See errorResult in src/mcp/server.ts.
  readonly agentHint?: string;
  override readonly cause?: unknown;
  // Set when this error is a discriminated capability 403 (app_identity v3.1).
  // The capability layer switches on `capabilityReason` to decide whether to
  // discard the cached token, silently re-acquire, retry once, or surface.
  readonly capabilityReason?: string;
  readonly capabilityDetail?: Capability403Detail;
  constructor(opts: {
    code: string;
    message: string;
    hint?: string;
    agentHint?: string;
    cause?: unknown;
    capabilityReason?: string;
    capabilityDetail?: Capability403Detail;
  }) {
    super(opts.message);
    this.name = "FbrainError";
    this.code = opts.code;
    this.hint = opts.hint;
    this.agentHint = opts.agentHint;
    this.cause = opts.cause;
    this.capabilityReason = opts.capabilityReason;
    this.capabilityDetail = opts.capabilityDetail;
  }
}

// Appended by every node + schema-service error message so non-doctor callers
// (list/put/etc.) point users at `fbrain doctor`. `doctor` itself must strip
// this back off — see stripDoctorTip below.
export const DOCTOR_TIP = "— run `fbrain doctor` for a full diagnosis";

// Strip the trailing " ${DOCTOR_TIP}." that client.ts appends to FbrainError
// messages, preserving the natural trailing period. Used inside `fbrain doctor`
// so its own output doesn't tell the user to run `fbrain doctor`.
export function stripDoctorTip(message: string): string {
  const suffix = ` ${DOCTOR_TIP}.`;
  if (message.endsWith(suffix)) {
    return message.slice(0, -suffix.length) + ".";
  }
  return message;
}

export type SchemaServiceClient = {
  baseUrl: string;
  registerSchema(req: AddSchemaRequest): Promise<{
    canonicalHash: string;
    status: number;
    replacedSchema: string | null;
  }>;
  listSchemas(): Promise<unknown>;
  getSchemaByHash(hash: string): Promise<RegisteredSchema | null>;
  rawCall(method: string, path: string, body?: unknown): Promise<RawResponse>;
};

// Supplies the verbatim base64 CapabilityToken blob attached to every write
// as `X-App-Capability`. Returns null when no capability is held (the node
// then treats the caller as NodeOwner, or — under enforcement — 403s with
// `consent_required`). Resolved per write so a re-acquired token is picked up
// without rebuilding the client.
export type CapabilityProvider = () => string | null;

// One entry of `GET /api/schemas` — a schema loaded into the node's DB.
// `identity_hash` is the canonical (owner-namespaced) hash the node computed;
// `owner_app_id` is present on app-owned schemas (e.g. `"fbrain"`).
export type LoadedSchema = {
  descriptive_name?: string;
  owner_app_id?: string;
  identity_hash?: string;
};

export type NodeClient = {
  baseUrl: string;
  userHash: string;
  autoIdentity(): Promise<
    | { provisioned: true; userHash: string }
    | { provisioned: false; reason: string }
  >;
  bootstrap(name: string): Promise<{ userHash: string }>;
  // App-identity consent handshake (app_identity v3.1). request-consent +
  // consent-status are the two app-driven steps; the owner grants out-of-band
  // via `folddb consent grant`.
  requestConsent(appId: string, scope: string): Promise<{ status: number; body: unknown }>;
  consentStatus(requestId: string): Promise<{ status: number; body: unknown }>;
  loadSchemas(): Promise<{
    available_schemas_loaded: number;
    schemas_loaded_to_db: number;
    failed_schemas: string[];
  }>;
  // GET /api/schemas — the schemas currently loaded into this node's DB,
  // each carrying the authoritative `identity_hash` the node computed. Used
  // by `fbrain init` to RESOLVE an already-published `fbrain/*` schema's
  // canonical hash without a cert-gated re-POST (the fresh-consumer path).
  listLoadedSchemas(): Promise<LoadedSchema[]>;
  createRecord(opts: {
    schemaHash: string;
    fields: Record<string, unknown>;
    keyHash: string;
  }): Promise<void>;
  updateRecord(opts: {
    schemaHash: string;
    fields: Record<string, unknown>;
    keyHash: string;
  }): Promise<void>;
  deleteRecord(opts: { schemaHash: string; keyHash: string }): Promise<void>;
  queryAll(opts: { schemaHash: string; fields: string[] }): Promise<QueryResponse>;
  search(query: string, opts?: SearchOptions): Promise<NativeIndexHit[]>;
  rawCall(method: string, path: string, body?: unknown): Promise<RawResponse>;
};

export function newSchemaServiceClient(
  baseUrl: string,
  verbose: Verbose = noopVerbose,
): SchemaServiceClient {
  const url = stripTrailingSlash(baseUrl);
  return {
    baseUrl: url,
    async registerSchema(req) {
      const path = "/v1/schemas";
      const res = await callSchemaServiceRaw(url, path, "POST", req, verbose);
      const body = await readJson(res);
      if (res.status !== 200 && res.status !== 201) {
        throw mapSchemaServiceError(res, body, path);
      }
      const schemaObj =
        body && typeof body === "object"
          ? ((body as Record<string, unknown>).schema as Record<string, unknown> | undefined)
          : undefined;
      const canonicalHash =
        schemaObj && typeof schemaObj.name === "string" ? (schemaObj.name as string) : null;
      if (!canonicalHash) {
        throw new FbrainError({
          code: "schema_register_no_hash",
          message: `Schema service did not return a canonical hash for ${req.schema.descriptive_name}.`,
          hint: "Inspect the schema service response — fbrain expects `schema.name` to carry the identity hash.",
        });
      }
      const replacedSchema =
        body && typeof body === "object" && "replaced_schema" in body
          ? ((body.replaced_schema as string | null | undefined) ?? null)
          : null;
      return { canonicalHash, status: res.status, replacedSchema };
    },
    async listSchemas() {
      const res = await callSchemaServiceRaw(url, "/v1/schemas", "GET", undefined, verbose);
      const body = await readJson(res);
      if (res.status !== 200) {
        throw mapSchemaServiceError(res, body, "/v1/schemas");
      }
      return body;
    },
    async getSchemaByHash(hash) {
      const path = `/v1/schema/${encodeURIComponent(hash)}`;
      const res = await callSchemaServiceRaw(url, path, "GET", undefined, verbose);
      if (res.status === 404) {
        await res.text();
        return null;
      }
      const body = await readJson(res);
      if (res.status !== 200) {
        throw mapSchemaServiceError(res, body, path);
      }
      // Two response shapes have been observed:
      //   - {schema: {...}, system: bool}  (SchemaEnvelope, current server)
      //   - {...schema fields...}          (older or simpler responses)
      // Prefer the envelope; fall back to treating the body as the schema.
      const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
      if (!obj) {
        throw new FbrainError({
          code: "schema_lookup_bad_response",
          message: `Schema service ${path} returned a non-JSON or non-object body: ${JSON.stringify(body).slice(0, 200)}`,
        });
      }
      const wrapped = obj.schema as Record<string, unknown> | undefined;
      const schemaObj = wrapped && typeof wrapped === "object" ? wrapped : obj;
      if (!schemaObj.fields && !schemaObj.field_types && !schemaObj.descriptive_name) {
        throw new FbrainError({
          code: "schema_lookup_no_schema",
          message: `Schema service ${path} returned unrecognised body: ${JSON.stringify(body).slice(0, 200)}`,
        });
      }
      return {
        name: stringProp(schemaObj, "name"),
        descriptive_name: stringProp(schemaObj, "descriptive_name"),
        schema_type: stringProp(schemaObj, "schema_type"),
        fields: Array.isArray(schemaObj.fields)
          ? (schemaObj.fields as unknown[]).filter((v): v is string => typeof v === "string")
          : [],
        field_types:
          schemaObj.field_types && typeof schemaObj.field_types === "object"
            ? (schemaObj.field_types as Record<string, unknown>)
            : {},
        identity_hash:
          typeof schemaObj.identity_hash === "string" ? (schemaObj.identity_hash as string) : undefined,
        source: typeof schemaObj.source === "string" ? (schemaObj.source as string) : undefined,
      };
    },
    async rawCall(method, path, body) {
      const res = await callSchemaServiceRaw(url, path, method, body, verbose);
      const text = await res.text();
      const json = parseJsonSafe(text);
      return { status: res.status, headers: res.headers, body: text, json };
    },
  };
}

function stringProp(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === "string" ? v : "";
}

export function newNodeClient(opts: {
  baseUrl: string;
  userHash: string;
  verbose?: Verbose;
  // When set, every MUTATION (create/update/delete) attaches the returned
  // base64 capability blob as `X-App-Capability` plus a fresh `X-Capability-Ts`.
  // Reads are NOT gated (design: reads bypass capability enforcement), so the
  // provider is only consulted on the mutation path. Returning null sends no
  // capability headers (NodeOwner fallback / enforcement off).
  capability?: CapabilityProvider;
}): NodeClient {
  const url = stripTrailingSlash(opts.baseUrl);
  const verbose = opts.verbose ?? noopVerbose;
  const userHash = opts.userHash;
  const capability = opts.capability;

  const callJson = async (
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<{ status: number; body: unknown }> => {
    const res = await callNodeRaw(url, path, method, body, userHash, verbose, extraHeaders);
    const parsed = await readJson(res);
    return { status: res.status, body: parsed };
  };

  return {
    baseUrl: url,
    userHash,
    async autoIdentity() {
      const { status, body } = await callJson("/api/system/auto-identity", "GET");
      if (status === 200) {
        const uh = body && typeof body === "object" ? (body as Record<string, unknown>).user_hash : undefined;
        return {
          provisioned: true,
          userHash: typeof uh === "string" ? uh : userHash,
        };
      }
      if (status === 503) {
        return {
          provisioned: false,
          reason: bodyError(body) ?? "node_not_provisioned",
        };
      }
      throw mapNodeError(status, body, "/api/system/auto-identity");
    },
    async bootstrap(name) {
      const { status, body } = await callJson("/api/setup/bootstrap", "POST", { name });
      if (status === 200) {
        const uh = body && typeof body === "object" ? (body as Record<string, unknown>).user_hash : undefined;
        if (typeof uh !== "string" || uh.length === 0) {
          throw new FbrainError({
            code: "bootstrap_no_user_hash",
            message: "Bootstrap succeeded but the node did not return a user_hash.",
            hint: "Inspect the response from POST /api/setup/bootstrap.",
          });
        }
        return { userHash: uh };
      }
      if (status === 410) {
        // The node and auto-identity disagree: auto-identity says
        // "not provisioned", bootstrap says "already provisioned". Surface
        // the node's own message field (typically a pointer to
        // POST /api/auth/restore) — the caller (init.ts) decides whether
        // to recover from an existing ~/.fbrain/config.json or rethrow.
        const nodeMsg = bodyMessage(body);
        throw new FbrainError({
          code: "onboarding_already_complete",
          message:
            `Node rejected POST /api/setup/bootstrap with 410 — already provisioned` +
            (nodeMsg ? `: ${nodeMsg}` : ".") +
            ` (auto-identity simultaneously reports the node as not provisioned — a contradictory state from the daemon).`,
          hint:
            "Recovery: (a) if ~/.fbrain/config.json from this node still exists, re-run `fbrain init` so it reuses the saved userHash; " +
            "(b) follow the node's own instruction above (typically `POST /api/auth/restore` with the recovery phrase); " +
            "(c) to start fresh, stop the daemon and clear its onboarding state (homebrew default: `rm -rf ~/.folddb/config/`), then re-run `fbrain init`.",
        });
      }
      throw mapNodeError(status, body, "/api/setup/bootstrap");
    },
    async requestConsent(appId, scope) {
      // Returns the raw {status, body} so the capability layer can branch on
      // 202 / 404 / 400 per the consent contract.
      return callJson("/api/apps/request-consent", "POST", { app_id: appId, scope });
    },
    async consentStatus(requestId) {
      return callJson(
        `/api/apps/consent-status/${encodeURIComponent(requestId)}`,
        "GET",
      );
    },
    async loadSchemas() {
      const { status, body } = await callJson("/api/schemas/load", "POST");
      if (status !== 200) throw mapNodeError(status, body, "/api/schemas/load");
      const b = body as Record<string, unknown>;
      const failed = Array.isArray(b.failed_schemas) ? (b.failed_schemas as string[]) : [];
      return {
        available_schemas_loaded: numField(b, "available_schemas_loaded"),
        schemas_loaded_to_db: numField(b, "schemas_loaded_to_db"),
        failed_schemas: failed,
      };
    },
    async listLoadedSchemas() {
      const { status, body } = await callJson("/api/schemas", "GET");
      if (status !== 200) throw mapNodeError(status, body, "/api/schemas");
      const arr =
        body && typeof body === "object" && Array.isArray((body as Record<string, unknown>).schemas)
          ? ((body as Record<string, unknown>).schemas as unknown[])
          : [];
      return arr
        .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
        .map((s) => ({
          descriptive_name:
            typeof s.descriptive_name === "string" ? s.descriptive_name : undefined,
          owner_app_id: typeof s.owner_app_id === "string" ? s.owner_app_id : undefined,
          identity_hash: typeof s.identity_hash === "string" ? s.identity_hash : undefined,
        }));
    },
    async createRecord({ schemaHash, fields, keyHash }) {
      await mutate("create", schemaHash, fields, keyHash, callJson, capability);
    },
    async updateRecord({ schemaHash, fields, keyHash }) {
      await mutate("update", schemaHash, fields, keyHash, callJson, capability);
    },
    async deleteRecord({ schemaHash, keyHash }) {
      // Empty fields_and_values is the minimal body — see
      // docs/phase-5-delete-spike.md, Probe B. The orchestrator's earlier
      // smoketest passed `{slug: keyHash}` which has the side-effect of
      // writing a no-op atom rewriting the slug field with itself.
      await mutate("delete", schemaHash, {}, keyHash, callJson, capability);
    },
    async queryAll({ schemaHash, fields }) {
      // The node's /api/query handler silently defaults to limit=100
      // (`DEFAULT_QUERY_LIMIT` in fold_db_node/src/handlers/query.rs) and
      // does NOT support a body-side tag/status filter — so any caller
      // that wants to filter by a record field has to fetch everything
      // and filter in-memory. We paginate up to QUERY_PAGE_SIZE rows per
      // request and stop once the node reports `has_more: false`.
      //
      // CLIENT-SIDE GUARDS — fold_db_node's offset pagination is broken
      // (handler `fold_db_node/src/handlers/query.rs`: `.skip(offset)
      // .take(limit)` over an unstably-ordered result set). Verified
      // 2026-05-30: paging a 177-row schema by 100 returns 177 rows but
      // only 134 unique — ~43 dups + ~43 silently dropped. fbrain is
      // safe today only because QUERY_PAGE_SIZE (1000) exceeds every
      // current schema's row count, so the second page is never
      // requested. To stay safe once any schema grows past the page
      // size, we never trust offset-paged results blindly:
      //   1. Dedupe rows by record key across pages — so a stable-
      //      ordering future node fix transparently keeps working,
      //      and an unstable node can never inflate the set with
      //      duplicates.
      //   2. If a follow-up page returns ONLY already-seen keys but
      //      claims has_more=true, throw — pagination is stalled
      //      mid-table and looping further would either spin to the
      //      QUERY_PAGE_LIMIT cap or return a silently-truncated set.
      //   3. After the loop terminates (has_more=false), if the
      //      node's own total_count is greater than our deduped row
      //      count, throw — the node dropped rows we cannot recover.
      // The proper root-cause fix lives in fold_db_node/query.rs
      // (stable ordering); this guard lets fbrain land independently.
      const allResults: QueryRow[] = [];
      const seenKeys = new Set<string>();
      let offset = 0;
      let lastTotalCount: number | null = null;
      for (let page = 0; page < QUERY_PAGE_LIMIT; page++) {
        const { status, body } = await callJson("/api/query", "POST", {
          schema_name: schemaHash,
          fields,
          limit: QUERY_PAGE_SIZE,
          offset,
        });
        if (status !== 200) throw mapNodeError(status, body, "/api/query");
        const b = body as Record<string, unknown>;
        const pageResults = Array.isArray(b.results) ? (b.results as QueryRow[]) : [];
        if (typeof b.total_count === "number") lastTotalCount = b.total_count;
        let newOnPage = 0;
        for (const row of pageResults) {
          const k = recordDedupKey(row);
          if (seenKeys.has(k)) continue;
          seenKeys.add(k);
          allResults.push(row);
          newOnPage++;
        }
        // Stop on explicit `has_more: false`. Absent `has_more` (older
        // node, or a stub) is treated as "done" — a single non-paginated
        // response is then equivalent to the pre-pagination contract.
        const hasMore = b.has_more === true;
        if (!hasMore) break;
        if (newOnPage === 0) {
          throw new FbrainError({
            code: "query_pagination_stalled",
            message:
              `Node /api/query returned page ${page + 1} at offset=${offset} ` +
              `with only previously-seen record keys but reported has_more=true — ` +
              `fold_db_node's offset pagination is unstable on schemas larger than ` +
              `QUERY_PAGE_SIZE (${QUERY_PAGE_SIZE}) and would loop or truncate ${DOCTOR_TIP}.`,
            hint:
              "Upgrade the fold_db_node to a version with stable /api/query ordering, " +
              "or temporarily reduce the schema's row count below QUERY_PAGE_SIZE.",
          });
        }
        // Defensive: a node that returns has_more=true with an empty
        // results array would spin without progress. The stalled-page
        // guard above already covers this (0 new keys), but keep an
        // explicit break for clarity and so the throw above can only
        // ever fire on a real overlap.
        if (pageResults.length === 0) break;
        offset += pageResults.length;
      }
      if (lastTotalCount !== null && allResults.length < lastTotalCount) {
        throw new FbrainError({
          code: "query_pagination_incomplete",
          message:
            `Node /api/query finished with has_more=false but only ${allResults.length} ` +
            `unique records were collected across pages — the node's reported total_count ` +
            `was ${lastTotalCount}. fold_db_node's offset pagination silently dropped rows ` +
            `via overlapping pages ${DOCTOR_TIP}.`,
          hint:
            "Upgrade the fold_db_node to a version with stable /api/query ordering, " +
            "or temporarily reduce the schema's row count below QUERY_PAGE_SIZE.",
        });
      }
      return {
        ok: true,
        results: allResults,
        total_count: lastTotalCount ?? allResults.length,
        returned_count: allResults.length,
      };
    },
    async search(query, searchOpts) {
      const params = new URLSearchParams();
      params.set("q", query);
      if (searchOpts?.exact) params.set("exact", "true");
      if (typeof searchOpts?.minScore === "number") {
        params.set("min_score", String(searchOpts.minScore));
      }
      if (searchOpts?.schemas && searchOpts.schemas.length > 0) {
        params.set("schemas", searchOpts.schemas.join(","));
      }
      const path = `/api/native-index/search?${params.toString()}`;
      const { status, body } = await callJson(path, "GET");
      if (status !== 200) throw mapNodeError(status, body, "/api/native-index/search");
      const b = body as Record<string, unknown>;
      const hits = Array.isArray(b.results) ? (b.results as NativeIndexHit[]) : [];
      return hits;
    },
    async rawCall(method, path, body) {
      const res = await callNodeRaw(url, path, method, body, userHash, verbose);
      const text = await res.text();
      const json = parseJsonSafe(text);
      return { status: res.status, headers: res.headers, body: text, json };
    },
  };
}

async function mutate(
  kind: "create" | "update" | "delete",
  schemaHash: string,
  fields: Record<string, unknown>,
  keyHash: string,
  callJson: (
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ) => Promise<{ status: number; body: unknown }>,
  capability: CapabilityProvider | undefined,
): Promise<void> {
  // App-identity v3.1: attach the verbatim base64 capability blob plus a fresh
  // unix-epoch-seconds timestamp on every mutation. The timestamp is recomputed
  // per call so a token cached for hours still lands inside the node's ±60s
  // replay window. No capability provider, or a provider returning null, sends
  // neither header — the node treats the caller as NodeOwner (or, under
  // enforcement, 403s with `consent_required`).
  const extraHeaders: Record<string, string> = {};
  const blob = capability?.() ?? null;
  if (blob !== null) {
    extraHeaders[APP_CAPABILITY_HEADER] = blob;
    extraHeaders[CAPABILITY_TS_HEADER] = String(Math.floor(Date.now() / 1000));
  }
  const { status, body } = await callJson("/api/mutation", "POST", {
    type: "mutation",
    schema: schemaHash,
    fields_and_values: fields,
    key_value: { hash: keyHash, range: null },
    mutation_type: kind,
  }, extraHeaders);
  if (status !== 200) throw mapNodeError(status, body, "/api/mutation");
}

// String identity for a QueryRow's record key, used by queryAll to
// dedupe across pages. fold_db keys are either hash-typed (range null)
// or range-typed (hash null); either field alone is not unique across
// schemas with mixed keys, so we combine both with a separator that
// cannot appear in a hex hash or range string.
function recordDedupKey(row: QueryRow): string {
  const key = row.key;
  if (!key || typeof key !== "object") {
    // No key at all — fall back to JSON of the fields so rows still
    // dedupe deterministically. A node returning rows with no key is
    // already broken, but the dedupe contract must still hold.
    return `__no_key__|${JSON.stringify(row.fields ?? null)}`;
  }
  return `h:${key.hash ?? ""}|r:${key.range ?? ""}`;
}

function numField(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  return typeof v === "number" ? v : 0;
}

function bodyError(body: unknown): string | undefined {
  if (body && typeof body === "object" && "error" in body) {
    const e = (body as Record<string, unknown>).error;
    if (typeof e === "string") return e;
  }
  return undefined;
}

function bodyMessage(body: unknown): string | undefined {
  if (body && typeof body === "object" && "message" in body) {
    const m = (body as Record<string, unknown>).message;
    if (typeof m === "string") return m;
  }
  return undefined;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

async function callNodeRaw(
  baseUrl: string,
  path: string,
  method: string,
  body: unknown,
  userHash: string,
  verbose: Verbose,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  return verboseFetch({
    baseUrl,
    path,
    method,
    body,
    verbose,
    service: "node",
    headers: { "X-User-Hash": userHash, ...(extraHeaders ?? {}) },
  });
}

async function callSchemaServiceRaw(
  baseUrl: string,
  path: string,
  method: string,
  body: unknown,
  verbose: Verbose,
): Promise<Response> {
  return verboseFetch({ baseUrl, path, method, body, verbose, service: "schema", headers: {} });
}

// Shared inner fetch for both service clients. Differs only by the verbose
// log tag (NODE vs SCHEMA), the service-specific headers passed in (the node
// always sends X-User-Hash), and the connectionError service param. Same
// shape and intent as the per-flag helpers in PRs #87/#88/#89/#97.
async function verboseFetch(opts: {
  baseUrl: string;
  path: string;
  method: string;
  body: unknown;
  verbose: Verbose;
  service: "node" | "schema";
  headers: Record<string, string>;
}): Promise<Response> {
  const url = `${opts.baseUrl}${opts.path}`;
  const tag = opts.service === "node" ? "NODE" : "SCHEMA";
  const headers = { ...opts.headers };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const bodyStr =
    opts.body === undefined
      ? undefined
      : typeof opts.body === "string"
        ? opts.body
        : JSON.stringify(opts.body);
  opts.verbose(
    `→ ${tag} ${opts.method} ${url}` + (bodyStr !== undefined ? ` body=${bodyStr}` : ""),
  );
  try {
    const res = await fetch(url, { method: opts.method, headers, body: bodyStr });
    opts.verbose(`← ${tag} ${opts.method} ${url} status=${res.status}`);
    return res;
  } catch (err) {
    throw connectionError(opts.baseUrl, opts.service, err);
  }
}

function parseJsonSafe(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function connectionError(baseUrl: string, service: "node" | "schema", cause: unknown): FbrainError {
  const which = service === "node" ? "node" : "schema service";
  return new FbrainError({
    code: "service_unreachable",
    message: `${which} not reachable at ${baseUrl} ${DOCTOR_TIP}.`,
    hint:
      service === "node"
        ? "Start a fold node, e.g. `cd fold/fold_db_node && ./run.sh --local --local-schema`."
        : "Start fold's schema service (`./run.sh --local --local-schema` runs both).",
    cause,
  });
}

function mapNodeError(status: number, body: unknown, path: string): FbrainError {
  const errCode = bodyError(body);
  const msg = bodyMessage(body);
  // Discriminated capability 403 (app_identity v3.1). The body is verbatim
  // `{"status":403,"reason":"<reason>", ...}`. Carry the reason + any detail
  // on the FbrainError so the capability layer can apply the contract behavior
  // (discard / re-acquire / retry-once / surface). A 403 without a recognised
  // `reason` falls through to the generic mapping below.
  if (status === 403) {
    const reason = bodyStringField(body, "reason");
    if (reason !== undefined) {
      const detail: Capability403Detail = {};
      const schema = bodyStringField(body, "schema");
      if (schema !== undefined) detail.schema = schema;
      const capabilityId = bodyStringField(body, "capability_id");
      if (capabilityId !== undefined) detail.capabilityId = capabilityId;
      const skew = bodyNumberField(body, "timestamp_skew_secs");
      if (skew !== undefined) detail.timestampSkewSecs = skew;
      return new FbrainError({
        code: `capability_403_${reason}`,
        message: `Node rejected ${path}: capability denied (${reason}).`,
        capabilityReason: reason,
        capabilityDetail: detail,
      });
    }
  }
  if (status === 401 && (errCode === "MISSING_USER_CONTEXT" || msg?.includes("Authentication"))) {
    return new FbrainError({
      code: "missing_user_context",
      message: `Node rejected ${path}: missing X-User-Hash ${DOCTOR_TIP}.`,
      hint: "Re-run `fbrain init` so the config's userHash is regenerated.",
    });
  }
  if (status === 503 && errCode === "node_not_provisioned") {
    return new FbrainError({
      code: "node_not_provisioned",
      message: `Node not set up ${DOCTOR_TIP}.`,
      hint: "Run `fbrain init` to bootstrap the node.",
    });
  }
  if (status === 409 && errCode === "ambiguous_schema_name") {
    const candidates = bodyAmbiguous(body);
    return new FbrainError({
      code: "ambiguous_schema_name",
      message:
        `Node rejected ${path}: schema collision (canonical hashes ${candidates.join(", ")}); ` +
        `fbrain config out of date — run \`fbrain init\` ${DOCTOR_TIP}.`,
      hint: "Re-run `fbrain init` — config will pick up the current canonical hash.",
    });
  }
  if (status === 400 && (errCode === "unknown_fields" || msg?.includes("unknown"))) {
    return new FbrainError({
      code: "unknown_fields",
      message: `Node rejected ${path}: ${msg ?? "unknown field name"} ${DOCTOR_TIP}.`,
      hint: "Compare fbrain's schemas.ts against the registered schema; re-run `fbrain init` after editing.",
    });
  }
  // The fold_db_node's embedding subsystem lazily loads `model.onnx` from a
  // local cache on the first semantic-search call. After certain restarts
  // (notably `brew upgrade folddb`) the cache can be partially
  // populated, and the node returns a 400 whose body carries
  // "...Failed to init embedding model: Failed to retrieve model.onnx"
  // — sometimes under `message`, sometimes under `error` (the homebrew
  // daemon currently puts the full text in `error`). Without translation
  // the user sees an opaque error on `fbrain search` / `fbrain ask`;
  // with translation they get a single, actionable recovery command.
  const onnxBlob = [msg, errCode].filter((s): s is string => typeof s === "string").join(" ");
  if (status === 400 && /Failed to (init embedding model|retrieve model\.onnx)/i.test(onnxBlob)) {
    return new FbrainError({
      code: "embedding_model_unavailable",
      message:
        `Semantic search is unavailable — the fold_db node failed to load its embedding model ` +
        `(${onnxBlob.trim()}) ${DOCTOR_TIP}.`,
      hint:
        "Restart the node so it re-fetches the ONNX file from the embedding cache " +
        "(homebrew: `folddb daemon stop && folddb daemon start`). " +
        "If the failure persists, run `fbrain doctor --freshness` and capture " +
        "the node log (the latest file under ~/Library/Logs/Homebrew/folddb/).",
      agentHint:
        "This is a node-side issue, not something this tool can fix — ask the " +
        "operator to restart the fold_db node, then retry.",
    });
  }
  return new FbrainError({
    code: `node_http_${status}`,
    message: `Node ${path} returned HTTP ${status}${msg ? `: ${msg}` : ""}${errCode ? ` [${errCode}]` : ""}.`,
    hint: status >= 500 ? "Check the node log; this looks like a node-side bug." : undefined,
  });
}

// Shared explanation + remedy text for the schema-service publish gate, used
// from both `mapSchemaServiceError` (init's step 3 raw error) and
// `runSchemaPublishGateProbe` (doctor's stand-alone diagnosis). Keeping a
// single source so the two surfaces never drift.
export const CERT_REQUIRED_HINT =
  "fbrain's 8 schemas under `fbrain/*` are namespaced — POSTing them to the " +
  "schema service requires a DevCert held by a maintainer (per app_identity v3.1). " +
  "A fresh consumer is expected to skip publishing entirely; this is filed upstream as " +
  "fold task #254c4 (idempotent re-POST should be cert-free). " +
  "Remedies, any one of: " +
  "(a) wait for / pull the fold fix above so re-POST is cert-free; " +
  "(b) ask a maintainer with a DevCert to run `fbrain init` once against this schema service so the canonical hashes are published; " +
  "(c) for a local/dev stack, set FBRAIN_APP_IDENTITY_ENFORCE=off and re-run `fbrain init` against a node + schema service that ALSO have app-identity disabled (no APP_IDENTITY_ROOT_PUBKEYS) — fbrain then publishes bare un-owned variants of its schemas, bypassing the cert gate. Bare hashes won't match production fbrain/* hashes, so this is a dev-only escape hatch.";

export function mapSchemaServiceError(res: Response, body: unknown, path: string): FbrainError {
  const errCode = bodyError(body);
  const msg = bodyMessage(body);
  const reason = bodyStringField(body, "reason");
  // App-identity v3.1 publish gate. The schema service rejects an
  // `owner_app_id`-tagged schema POST from a caller without a DevCert with
  // `401 {"reason":"cert_required"}`. For fbrain — whose 8 schemas under
  // `fbrain/*` are pre-published org-wide — this is the canonical "fresh
  // consumer following the documented path" failure: re-POSTing canonical
  // hashes requires publish authority the consumer doesn't (and shouldn't) have.
  // Surface a discriminated code + actionable remedy instead of a raw
  // "HTTP 401" that gives the user nothing to act on.
  if (res.status === 401 && reason === "cert_required") {
    return new FbrainError({
      code: "schema_cert_required",
      message:
        `Schema service ${path} rejected publish with 401 cert_required — ` +
        `registering fbrain's namespaced schemas requires a one-time DevCert publish ` +
        `by a maintainer (this is expected for a fresh consumer) ${DOCTOR_TIP}.`,
      hint: CERT_REQUIRED_HINT,
    });
  }
  return new FbrainError({
    code: `schema_http_${res.status}`,
    message: `Schema service ${path} returned HTTP ${res.status}${msg ? `: ${msg}` : ""}${errCode ? ` [${errCode}]` : ""} ${DOCTOR_TIP}.`,
  });
}

function bodyAmbiguous(body: unknown): string[] {
  if (body && typeof body === "object" && "ambiguous_schemas" in body) {
    const a = (body as Record<string, unknown>).ambiguous_schemas;
    if (Array.isArray(a)) return a.filter((v): v is string => typeof v === "string");
  }
  return [];
}

export function bodyStringField(body: unknown, key: string): string | undefined {
  if (body && typeof body === "object" && key in body) {
    const v = (body as Record<string, unknown>)[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function bodyNumberField(body: unknown, key: string): number | undefined {
  if (body && typeof body === "object" && key in body) {
    const v = (body as Record<string, unknown>)[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

export function recordTypeForHash(
  hash: string,
  schemaHashes: Record<string, string>,
): RecordType | null {
  for (const [type, h] of Object.entries(schemaHashes)) {
    if (h === hash) return type as RecordType;
  }
  return null;
}

// fold_db's user_hash is the first 32 hex chars of sha256(raw pubkey).
// Verified against `auto-identity`: for our local node, sha256 of the
// base64-decoded `public_key` truncated to 16 bytes matches the
// `user_hash` field. Used by `fbrain doctor --usage` to partition writes
// across teammates without leaking the full pubkey.
export function pubkeyToUserHash(pubkey: string): string {
  const raw = Buffer.from(pubkey, "base64");
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}
