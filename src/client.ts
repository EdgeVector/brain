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
};

export class FbrainError extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly cause?: unknown;
  constructor(opts: {
    code: string;
    message: string;
    hint?: string;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = "FbrainError";
    this.code = opts.code;
    this.hint = opts.hint;
    this.cause = opts.cause;
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

export type NodeClient = {
  baseUrl: string;
  userHash: string;
  autoIdentity(): Promise<
    | { provisioned: true; userHash: string }
    | { provisioned: false; reason: string }
  >;
  bootstrap(name: string): Promise<{ userHash: string }>;
  loadSchemas(): Promise<{
    available_schemas_loaded: number;
    schemas_loaded_to_db: number;
    failed_schemas: string[];
  }>;
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
      const res = await callSchemaService(url, path, "POST", req, verbose);
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
      const res = await callSchemaService(url, "/v1/schemas", "GET", undefined, verbose);
      const body = await readJson(res);
      if (res.status !== 200) {
        throw mapSchemaServiceError(res, body, "/v1/schemas");
      }
      return body;
    },
    async getSchemaByHash(hash) {
      const path = `/v1/schema/${encodeURIComponent(hash)}`;
      const res = await callSchemaService(url, path, "GET", undefined, verbose);
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
}): NodeClient {
  const url = stripTrailingSlash(opts.baseUrl);
  const verbose = opts.verbose ?? noopVerbose;
  const userHash = opts.userHash;

  const callJson = async (
    path: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> => {
    const res = await callNode(url, path, method, body, userHash, verbose);
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
    async createRecord({ schemaHash, fields, keyHash }) {
      await mutate("create", schemaHash, fields, keyHash, callJson);
    },
    async updateRecord({ schemaHash, fields, keyHash }) {
      await mutate("update", schemaHash, fields, keyHash, callJson);
    },
    async deleteRecord({ schemaHash, keyHash }) {
      // Empty fields_and_values is the minimal body — see
      // docs/phase-5-delete-spike.md, Probe B. The orchestrator's earlier
      // smoketest passed `{slug: keyHash}` which has the side-effect of
      // writing a no-op atom rewriting the slug field with itself.
      await mutate("delete", schemaHash, {}, keyHash, callJson);
    },
    async queryAll({ schemaHash, fields }) {
      const { status, body } = await callJson("/api/query", "POST", {
        schema_name: schemaHash,
        fields,
      });
      if (status !== 200) throw mapNodeError(status, body, "/api/query");
      const b = body as Record<string, unknown>;
      const results = Array.isArray(b.results) ? (b.results as QueryRow[]) : [];
      return {
        ok: true,
        results,
        total_count: typeof b.total_count === "number" ? b.total_count : results.length,
        returned_count:
          typeof b.returned_count === "number" ? b.returned_count : results.length,
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
  callJson: (path: string, method: "GET" | "POST", body?: unknown) => Promise<{ status: number; body: unknown }>,
): Promise<void> {
  const { status, body } = await callJson("/api/mutation", "POST", {
    type: "mutation",
    schema: schemaHash,
    fields_and_values: fields,
    key_value: { hash: keyHash, range: null },
    mutation_type: kind,
  });
  if (status !== 200) throw mapNodeError(status, body, "/api/mutation");
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

async function callNode(
  baseUrl: string,
  path: string,
  method: "GET" | "POST",
  body: unknown,
  userHash: string,
  verbose: Verbose,
): Promise<Response> {
  return callNodeRaw(baseUrl, path, method, body, userHash, verbose);
}

async function callNodeRaw(
  baseUrl: string,
  path: string,
  method: string,
  body: unknown,
  userHash: string,
  verbose: Verbose,
): Promise<Response> {
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = {
    "X-User-Hash": userHash,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  verbose(`→ NODE ${method} ${url}` + (body !== undefined ? ` body=${typeof body === "string" ? body : JSON.stringify(body)}` : ""));
  try {
    const res = await fetch(url, {
      method,
      headers,
      body:
        body === undefined
          ? undefined
          : typeof body === "string"
            ? body
            : JSON.stringify(body),
    });
    verbose(`← NODE ${method} ${url} status=${res.status}`);
    return res;
  } catch (err) {
    throw connectionError(baseUrl, "node", err);
  }
}

async function callSchemaService(
  baseUrl: string,
  path: string,
  method: "GET" | "POST",
  body: unknown,
  verbose: Verbose,
): Promise<Response> {
  return callSchemaServiceRaw(baseUrl, path, method, body, verbose);
}

async function callSchemaServiceRaw(
  baseUrl: string,
  path: string,
  method: string,
  body: unknown,
  verbose: Verbose,
): Promise<Response> {
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  verbose(`→ SCHEMA ${method} ${url}` + (body !== undefined ? ` body=${typeof body === "string" ? body : JSON.stringify(body)}` : ""));
  try {
    const res = await fetch(url, {
      method,
      headers,
      body:
        body === undefined
          ? undefined
          : typeof body === "string"
            ? body
            : JSON.stringify(body),
    });
    verbose(`← SCHEMA ${method} ${url} status=${res.status}`);
    return res;
  } catch (err) {
    throw connectionError(baseUrl, "schema", err);
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

// Shared recovery hint for `embedding_model_unavailable`. Kept here so
// both client.ts (the search/ask error path) and doctor.ts (the always-on
// probe) print the same instructions — fixing it in two places would
// invite drift.
export const EMBEDDING_MODEL_RECOVERY_HINT =
  "The folddb daemon's fastembed couldn't load the all-MiniLM-L6-v2 ONNX model " +
  "(this is an upstream fold_db / fastembed issue, not a fbrain one). " +
  "Try in order: (1) check the daemon log for the underlying fastembed error — " +
  "`grep -i 'Failed to retrieve' ~/.folddb/observability.jsonl | tail -3`; " +
  "(2) restart the daemon (homebrew: `brew services restart folddb`); " +
  "(3) if still failing, delete the cache and let it redownload on next search — " +
  "`rm -rf ~/.fastembed_cache && brew services restart folddb`; " +
  "(4) if step 3 doesn't fix it, file upstream at fold_db with the log excerpt — " +
  "until then `fbrain` calls that need embeddings (search / ask / writes that index) will fail.";

export function isEmbeddingModelInitFailure(
  status: number,
  msg: string | undefined,
): boolean {
  if (status !== 400 || !msg) return false;
  // The upstream message is built by fold_db's embedding_model.rs as
  // "Failed to init embedding model: {fastembed err}" — fastembed's
  // "Failed to retrieve model.onnx" is the only failure mode observed
  // in dogfood logs, but match both phrases so a future fastembed
  // error string still trips the rewrap.
  return (
    msg.includes("Failed to init embedding model") ||
    msg.includes("Failed to retrieve model.onnx")
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function mapNodeError(status: number, body: unknown, path: string): FbrainError {
  const errCode = bodyError(body);
  const msg = bodyMessage(body);
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
  // Embedding-model init failures: fastembed couldn't load the ONNX model
  // (network down on first call, daemon's cwd points away from its
  // .fastembed_cache, a partial/corrupt download). Surface a fbrain-shaped
  // error pointing at `fbrain doctor` so the user gets a recovery path
  // instead of the raw upstream `Failed to retrieve model.onnx`. fold_db
  // returns this inside body.error (e.g. "Bad request: Schema error:
  // Invalid data: Failed to init embedding model: ..."), not body.message
  // — match on whichever field the substring lands in.
  if (isEmbeddingModelInitFailure(status, msg ?? errCode)) {
    const raw = msg ?? errCode ?? "";
    return new FbrainError({
      code: "embedding_model_unavailable",
      message: `Node ${path} rejected the request — the embedding model is not available (raw: ${truncate(raw, 200)}) ${DOCTOR_TIP}.`,
      hint: EMBEDDING_MODEL_RECOVERY_HINT,
    });
  }
  return new FbrainError({
    code: `node_http_${status}`,
    message: `Node ${path} returned HTTP ${status}${msg ? `: ${msg}` : ""}${errCode ? ` [${errCode}]` : ""}.`,
    hint: status >= 500 ? "Check the node log; this looks like a node-side bug." : undefined,
  });
}

function mapSchemaServiceError(res: Response, body: unknown, path: string): FbrainError {
  const errCode = bodyError(body);
  const msg = bodyMessage(body);
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
