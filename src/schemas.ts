// Schema definitions for fbrain's record types.
//
// Pattern status: fbrain's per-kind, purpose-split schemas are
// grandfathered historical catalog identities. Do not copy this as the
// default pattern for new apps; decision-2026-07-16-schema-identity-system-treatment
// says new apps use starter templates plus an explicit `kind` field for
// app-level meaning.
//
// fbrain registers one schema per record type, plus internal support schemas:
//
//   - **Design**, **Task** — Phase 1, unchanged.
//   - **Concept**, **Preference**, **Reference**, **Agent**, **Project**,
//     **Spike** — Phase 6 kinds. As of Phase E (the dual-signal
//     canonicalization cutover) each gets its own dedicated schema with
//     a distinct `descriptive_name` + `purpose_statement`. The schema
//     service's dual-signal gate uses the purpose-statement embedding to
//     veto structural collapse, so all six can share the same 7-field
//     shape without colliding onto a single canonical hash.
//   - **Sop** — a later addition built on the same 7-field Phase 6 shape
//     (same dedicated-schema + distinct-purpose-statement treatment), for
//     storing standard operating procedures agents follow on recurring tasks.
//
// Why dedicated schemas now? Pre-Phase-E we used one shared
// `FbrainKindNote` schema + a `kind` discriminator + `v1_marker_a/b`
// structural-distinctness markers to defeat fold's structural
// canonicalization. With dual-signal canonicalization default-on,
// the structural collision is solved at the schema-service layer
// (distinct purpose statements veto the merge), so the workaround
// is unnecessary. After the consolidation migration (PR #63) moved
// every pre-Phase-E `FbrainKindNote` row into its per-kind canonical,
// the legacy schema is no longer registered or read from.
//
// `POST /v1/schemas` accepts these bodies; the response's `schema.name`
// IS THE CANONICAL HASH that every subsequent mutation/query MUST pin
// to. The descriptive_name is for human-facing display only.

// The app id that owns every fbrain schema. Under app_identity v3.1,
// `owner_app_id` is part of the schema's identity: the schema_service resolver
// normalizes `name: "Concept"` + `owner_app_id: "fbrain"` to the canonical
// name `fbrain/Concept` (design doc, "owner_app_id participates in
// identity_hash"). So `fbrain/Concept` and `kanban/Concept` are distinct
// identities even with identical fields. The publish path (`folddb-dev app
// publish` / `schema publish --app fbrain`, run by the developer in the
// migration runbook) authorizes this claim with a dev cert; fbrain's own
// schema definitions just declare ownership so re-registration is idempotent
// and the node resolves short names to the fbrain/* namespace at boot.
export const OWNER_APP_ID = "fbrain";

export type FieldType = "String" | "Any" | { Array: "String" };

export type SchemaDefinition = {
  name: string;
  // App-identity ownership. The schema_service folds this into the identity
  // hash and stores the schema under the canonical name `{owner_app_id}/{name}`
  // (= `fbrain/<Name>`). Set on every fbrain schema; optional in the TS type
  // so externally-loaded schema definitions (e.g. legacy fixtures, or future
  // non-fbrain catalogues) can omit it without a TS error.
  owner_app_id?: string;
  descriptive_name: string;
  // Phase A of dual-signal canonicalization (PR #303): the schema service
  // consults this alongside the structural signal at registration time.
  // Defaults to `descriptive_name` server-side when omitted; the Phase 6
  // schemas set it explicitly to distinguish themselves from each other
  // (they all share the same field shape).
  purpose_statement?: string;
  // Every PRODUCT record schema is "Hash" (one row per slug). "HashRange"
  // exists for the index plane — see `recordListEntrySchema`, where the row is
  // addressed (hash_field, range_field) so a put patches one row instead of
  // rewriting a whole-type rollup atom.
  schema_type: "Hash" | "HashRange";
  key: { hash_field: string; range_field?: string };
  fields: string[];
  field_types: Record<string, FieldType>;
  field_descriptions: Record<string, string>;
  field_classifications?: Record<string, string[]>;
  field_data_classifications: Record<
    string,
    { sensitivity_level: number; data_domain: string }
  >;
};

export type AddSchemaRequest = {
  schema: SchemaDefinition;
  mutation_mappers: Record<string, string>;
};

export const DESIGN_STATUSES = [
  "draft",
  "reviewed",
  "approved",
  "implemented",
  "archived",
] as const;

export const TASK_STATUSES = [
  "open",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
] as const;

export const CONCEPT_STATUSES = ["active", "parked", "archived"] as const;

export const PREFERENCE_STATUSES = ["active", "parked", "superseded"] as const;

export const REFERENCE_STATUSES = ["active", "parked", "broken", "archived"] as const;

export const AGENT_STATUSES = ["active", "archived"] as const;

export const PROJECT_STATUSES = [
  "planning",
  "in_progress",
  "done",
  "archived",
] as const;

export const SPIKE_STATUSES = ["active", "concluded"] as const;

export const SOP_STATUSES = ["active", "parked", "superseded", "archived"] as const;

// A `decision` is one call a human made. Status is the OUTCOME, not a
// workflow state: `go` (approved/proceed), `hold` (deferred/parked),
// `done` (decided AND the resulting work has landed), `moot` (the premise
// went away so no action is needed), `superseded` (a later decision
// replaced it). `proposed` is the pre-decision draft state. Replaces the
// single monolithic `decisions-log` reference record — one record per
// decision so appending is a tiny write, not a 19 KB rewrite.
export const DECISION_STATUSES = [
  "proposed",
  "go",
  "hold",
  "done",
  "moot",
  "superseded",
] as const;

// A `papercut` is one observed defect in our own tooling, with its evidence.
// Status is the REPAIR lifecycle, and the split that matters most is
// `fixed` vs `verified`: "merged" is a fact about a repository and is NOT
// evidence the defect is gone. Runs that conflated the two produced the
// measured failure this type exists to end — on 2026-08-04, 40 of 107
// prose-ledger records read OPEN at the top and closed at the bottom,
// because `brain append` cannot rewrite the `Status:` line it follows.
//
//   open       filed, not repaired
//   partial    some of it repaired, some still open (say which in the body)
//   fixed      a change merged that should resolve it — NOT yet re-measured
//   verified   a live check confirmed it gone (terminal)
//   wontfix    deliberately not repairing (terminal)
//   duplicate  superseded by another papercut — see `duplicate_of` (terminal)
export const PAPERCUT_STATUSES = [
  "open",
  "partial",
  "fixed",
  "verified",
  "wontfix",
  "duplicate",
] as const;

// Severity ladder. Kept a plain String column (not an enum type) to match
// every other field on the record; `brain papercut file` validates it.
export const PAPERCUT_SEVERITIES = ["p0", "p1", "p2", "p3"] as const;

// What KIND of thing the record is, which the prose ledger could not say —
// and the reason a fully specified fix sat unread for three days:
// nothing distinguished a finished proposal from a raw complaint.
//
//   complaint      an observation; nobody has worked out the repair yet
//   specified-fix  the repair is worked out and written down — ready to pick up
//   reconfirmed    a previously-closed papercut re-measured as still live
export const PAPERCUT_KINDS = [
  "complaint",
  "specified-fix",
  "reconfirmed",
] as const;

const GENERAL = { sensitivity_level: 0, data_domain: "general" };

// The seven-field shape shared by Design + all six Phase 6 kinds. Building
// each per-kind schema from the same template ensures their structural
// signatures match exactly; the per-kind `descriptive_name` + `purpose_statement`
// is what keeps the dual-signal gate from merging them.
const PHASE_6_FIELDS = [
  "slug",
  "title",
  "body",
  "status",
  "tags",
  "created_at",
  "updated_at",
] as const;

const PHASE_6_FIELD_TYPES: Record<string, FieldType> = {
  slug: "String",
  title: "String",
  body: "String",
  status: "String",
  tags: { Array: "String" },
  created_at: "String",
  updated_at: "String",
};

const PHASE_6_FIELD_DESCRIPTIONS: Record<string, string> = {
  slug: "stable url-style id",
  title: "one-line name",
  body: "markdown content",
  // The per-kind schema below overrides `status` with its own enum string.
  status: "per-kind status enum",
  tags: "array of freeform tags",
  created_at: "RFC 3339 timestamp",
  updated_at: "RFC 3339 timestamp",
};

const PHASE_6_DATA_CLASSIFICATIONS = {
  slug: GENERAL,
  title: GENERAL,
  body: GENERAL,
  status: GENERAL,
  tags: GENERAL,
  created_at: GENERAL,
  updated_at: GENERAL,
};

function phase6Schema(
  descriptive_name: string,
  purpose_statement: string,
  statuses: readonly string[],
): AddSchemaRequest {
  return {
    schema: {
      name: descriptive_name,
      owner_app_id: OWNER_APP_ID,
      descriptive_name,
      purpose_statement,
      schema_type: "Hash",
      key: { hash_field: "slug" },
      fields: [...PHASE_6_FIELDS],
      field_types: { ...PHASE_6_FIELD_TYPES },
      field_descriptions: {
        ...PHASE_6_FIELD_DESCRIPTIONS,
        status: statuses.join("|"),
      },
      field_classifications: { title: ["word"], body: ["word"] },
      field_data_classifications: { ...PHASE_6_DATA_CLASSIFICATIONS },
    },
    mutation_mappers: {},
  };
}

export const designSchema: AddSchemaRequest = phase6Schema(
  "Design",
  "Design",
  DESIGN_STATUSES,
);

export const taskSchema: AddSchemaRequest = {
  schema: {
    name: "Task",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "Task",
    purpose_statement: "Task",
    schema_type: "Hash",
    key: { hash_field: "slug" },
    fields: [
      "slug",
      "title",
      "body",
      "status",
      "design_slug",
      "tags",
      "created_at",
      "updated_at",
    ],
    field_types: {
      slug: "String",
      title: "String",
      body: "String",
      status: "String",
      design_slug: "String",
      tags: { Array: "String" },
      created_at: "String",
      updated_at: "String",
    },
    field_descriptions: {
      slug: "stable url-style id",
      title: "one-line name",
      body: "description/notes",
      status: TASK_STATUSES.join("|"),
      design_slug: "parent Design slug, empty string if none",
      tags: "array of freeform tags",
      created_at: "RFC 3339 timestamp",
      updated_at: "RFC 3339 timestamp",
    },
    field_classifications: { title: ["word"], body: ["word"] },
    field_data_classifications: {
      slug: GENERAL,
      title: GENERAL,
      body: GENERAL,
      status: GENERAL,
      design_slug: GENERAL,
      tags: GENERAL,
      created_at: GENERAL,
      updated_at: GENERAL,
    },
  },
  mutation_mappers: {},
};

// Per-kind schemas, structurally identical (7 fields) and distinguished
// solely by descriptive_name + purpose_statement. This is retained for
// fbrain's existing catalog identities; new apps should use schema starter
// templates plus a `kind` discriminator per
// decision-2026-07-16-schema-identity-system-treatment.
export const conceptSchema: AddSchemaRequest = phase6Schema(
  "Concept",
  "Reusable framework, pattern, or protocol recorded for cross-session reuse",
  CONCEPT_STATUSES,
);
export const preferenceSchema: AddSchemaRequest = phase6Schema(
  "Preference",
  "User-stated directive applied across future decisions",
  PREFERENCE_STATUSES,
);
export const referenceSchema: AddSchemaRequest = phase6Schema(
  "Reference",
  "Pointer to an external resource useful for future lookup",
  REFERENCE_STATUSES,
);
export const agentSchema: AddSchemaRequest = phase6Schema(
  "Agent",
  "Persistent assistant identity with role and behavior conventions",
  AGENT_STATUSES,
);
export const projectSchema: AddSchemaRequest = phase6Schema(
  "Project",
  "Active in-flight feature work tracked over its lifecycle",
  PROJECT_STATUSES,
);
export const spikeSchema: AddSchemaRequest = phase6Schema(
  "Spike",
  "Time-boxed investigation or exploration with a defined conclusion",
  SPIKE_STATUSES,
);
export const sopSchema: AddSchemaRequest = phase6Schema(
  "Sop",
  "Standard operating procedure: a repeatable step-by-step process an agent follows to perform a recurring task",
  SOP_STATUSES,
);
// Decision gets a DEDICATED shape (not the shared 7-field envelope): the
// whole point of promoting decisions out of the monolithic `decisions-log`
// is to make them queryable, so the things you filter/sort by are real
// columns — `program`, `gate_slug`, `decided_by`, `decided_on` — not buried
// in prose or tags. LastDB stores arbitrary schema fields fine; the extra
// columns are plumbed through fbrain's generic record path via
// `RecordTypeDef.extraStringFields`. The distinct field shape also keeps its
// canonical hash separate from every other type without relying on the
// dual-signal purpose gate.
export const decisionSchema: AddSchemaRequest = {
  schema: {
    name: "Decision",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "Decision",
    purpose_statement:
      "A call a human made — the choice, its rationale, and outcome — kept as an auditable trail",
    schema_type: "Hash",
    key: { hash_field: "slug" },
    fields: [
      "slug",
      "title",
      "body",
      "status",
      "program",
      "gate_slug",
      "decided_by",
      "decided_on",
      "tags",
      "created_at",
      "updated_at",
    ],
    field_types: {
      slug: "String",
      title: "String",
      body: "String",
      status: "String",
      program: "String",
      gate_slug: "String",
      decided_by: "String",
      decided_on: "String",
      tags: { Array: "String" },
      created_at: "String",
      updated_at: "String",
    },
    field_descriptions: {
      slug: "stable url-style id",
      title: "one-line decision summary",
      body: "rationale, evidence, and context",
      status: DECISION_STATUSES.join("|"),
      program: "owning program / North Star slug (empty string if none)",
      gate_slug: "open-decisions gate this clears (empty string if none)",
      decided_by: "who made the call (e.g. Tom)",
      decided_on: "RFC 3339 date the decision was made",
      tags: "array of freeform tags",
      created_at: "RFC 3339 timestamp",
      updated_at: "RFC 3339 timestamp",
    },
    field_classifications: { title: ["word"], body: ["word"] },
    field_data_classifications: {
      slug: GENERAL,
      title: GENERAL,
      body: GENERAL,
      status: GENERAL,
      program: GENERAL,
      gate_slug: GENERAL,
      decided_by: GENERAL,
      decided_on: GENERAL,
      tags: GENERAL,
      created_at: GENERAL,
      updated_at: GENERAL,
    },
  },
  mutation_mappers: {},
};

// Papercut gets a DEDICATED shape for the same reason `decision` does: the
// things you filter, dedupe and count by have to be real columns. The prose
// ledger this replaces stored all of them in freeform body text, and every
// measured bookkeeping failure traced back to that one fact.
//
// `component` is the load-bearing one. The prose ledger scoped a family by
// SLUG PREFIX — every "independent" enumerator ran `grep -o
// "papercut-lastgit-[a-z0-9-]*"` — so on the axis of the prefix they were one
// reader, and a defect filed under any other slug was invisible to all of
// them. Measured 2026-08-06: at least 9 active LastGit defect records sat
// outside the prefix, including a P1. A queryable column cannot be evaded by
// naming a record badly.
//
// `symptom_hash` is the dedupe key: a content hash over
// (component, normalized symptom), so a second run filing the same observable
// collides on write instead of two hours later in a human's reading.
export const papercutSchema: AddSchemaRequest = {
  schema: {
    name: "Papercut",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "Papercut",
    purpose_statement:
      "One observed defect in our own tooling, with its evidence, repair state and the live check that confirmed it gone",
    schema_type: "Hash",
    key: { hash_field: "slug" },
    fields: [
      "slug",
      "title",
      "body",
      "status",
      "component",
      "repo",
      "severity",
      "kind",
      "symptom_hash",
      "fixed_by",
      "verified_by",
      "duplicate_of",
      "tags",
      "created_at",
      "updated_at",
    ],
    field_types: {
      slug: "String",
      title: "String",
      body: "String",
      status: "String",
      component: "String",
      repo: "String",
      severity: "String",
      kind: "String",
      symptom_hash: "String",
      fixed_by: "String",
      verified_by: "String",
      duplicate_of: "String",
      tags: { Array: "String" },
      created_at: "String",
      updated_at: "String",
    },
    field_descriptions: {
      slug: "stable url-style id",
      title: "one-line statement of the defect",
      body: "symptom, evidence, reproduction, and the proposed or applied repair",
      status: PAPERCUT_STATUSES.join("|"),
      component:
        "subsystem the defect lives in (lastdb | lastgit | kanban | brain | routines | …) — the queryable replacement for the slug-prefix family",
      repo: "owning repo as a bare owner/name token (empty string if none)",
      severity: PAPERCUT_SEVERITIES.join("|"),
      kind: PAPERCUT_KINDS.join("|"),
      symptom_hash:
        "content hash over (component, normalized symptom) — the dedupe key checked on file",
      fixed_by:
        "the change that repaired it, e.g. EdgeVector/lastgit #242 (empty string until fixed)",
      verified_by:
        "the LIVE check that confirmed it gone — never the word 'merged' (empty string until verified)",
      duplicate_of:
        "slug of the papercut this one duplicates (empty string if none)",
      tags: "array of freeform tags",
      created_at: "RFC 3339 timestamp",
      updated_at: "RFC 3339 timestamp",
    },
    field_classifications: { title: ["word"], body: ["word"] },
    field_data_classifications: {
      slug: GENERAL,
      title: GENERAL,
      body: GENERAL,
      status: GENERAL,
      component: GENERAL,
      repo: GENERAL,
      severity: GENERAL,
      kind: GENERAL,
      symptom_hash: GENERAL,
      fixed_by: GENERAL,
      verified_by: GENERAL,
      duplicate_of: GENERAL,
      tags: GENERAL,
      created_at: GENERAL,
      updated_at: GENERAL,
    },
  },
  mutation_mappers: {},
};

export const RECORD_TYPES = [
  "design",
  "task",
  "concept",
  "preference",
  "reference",
  "agent",
  "project",
  "spike",
  "sop",
  "decision",
  "papercut",
] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export function recordTypeList(separator = " | "): string {
  return RECORD_TYPES.join(separator);
}

export function recordTypeCount(): number {
  return RECORD_TYPES.length;
}

// Internal tag secondary index. This is intentionally NOT a RecordType: it is
// registered and stored in config like other fbrain schemas, but never appears
// on user-facing list/get/search surfaces.
export const TAG_INDEX_SCHEMA_KEY = "__tagindex__";
export const ADMIN_SNAPSHOT_SCHEMA_KEY = "__admin_snapshot__";
// File attachments (`fbrain attach` / `attachments` / `detach` /
// `attachment get`). Two internal support schemas, NOT RecordTypes.
// Attachments stay ADDITIVE by design: registering these schemas changes no
// existing schema's identity hash and migrates no existing record — a
// deliberate contrast to `migrate --add-field`, which re-puts every record
// under a new hash. See docs/attachments.md.
export const ATTACHMENT_INDEX_SCHEMA_KEY = "__attachmentindex__";
export const ATTACHMENT_BLOB_SCHEMA_KEY = "__attachmentblob__";
export const ATTACHMENT_FILE_SCHEMA_KEY = "__attachmentfile__";
export const tagIndexSchema: AddSchemaRequest = {
  schema: {
    name: "TagIndex",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "TagIndex",
    purpose_statement:
      "Inverted index mapping a tag to the records that carry it, maintained by fbrain to make tag-filtered reads scale with tag cardinality instead of corpus size",
    schema_type: "Hash",
    key: { hash_field: "slug" },
    fields: ["slug", "tag", "members", "created_at", "updated_at"],
    field_types: {
      slug: "String",
      tag: "String",
      members: { Array: "String" },
      created_at: "String",
      updated_at: "String",
    },
    field_descriptions: {
      slug: "reserved __tagidx__<sha256(tag)> key",
      tag: "the indexed tag value",
      members: "array of type:slug entries carrying this tag",
      created_at: "RFC 3339 timestamp",
      updated_at: "RFC 3339 timestamp",
    },
    // NOT SEARCHABLE — every field, deliberately.
    //
    // TagIndex is brain's own bookkeeping: a machine key
    // (`__tagidx__<sha256>`) pointing at a list of `type:slug` members. Nobody
    // searches for it, and it is not prose.
    //
    // Measured 2026-08-08 on the live semantic plane, an UNSCOPED query
    // returned this and nothing else in its top four:
    //
    //   0.747  TagIndex  __tagidx__8d8ea229865deee0e8e6dec4b3cf6d6e34…
    //   0.744  TagIndex  __tagidx__4d0cf51fab3231323f683f788c36c3f62d…
    //   0.728  TagIndex  __tagidx__b2fc4e7094dad451b55e8059bab659f7db…
    //
    // A bag of tag tokens lands mid-similarity against almost any query, so
    // these crowded the head of every unscoped result. brain's own reads scope
    // by type and were unaffected — but "any app can search its own records"
    // means new callers arrive, and the first thing a new caller does is an
    // unscoped query.
    //
    // Leaving `field_classifications` unset was not neutral: the host emits
    // `searchable_fields: null` for it, which a consumer must read as "legacy,
    // unspecified" rather than as exclusion. Only the owning app can say this,
    // and saying it explicitly is the whole mechanism — so every field is
    // enumerated, and there is deliberately no `word` field. Same shape as the
    // attachment support schemas above.
    field_classifications: {
      slug: ["no_index", "metadata"],
      tag: ["no_index", "metadata"],
      members: ["no_index", "metadata"],
      created_at: ["no_index", "metadata"],
      updated_at: ["no_index", "metadata"],
    },
    field_data_classifications: {
      slug: GENERAL,
      tag: GENERAL,
      members: GENERAL,
      created_at: GENERAL,
      updated_at: GENERAL,
    },
  },
  mutation_mappers: {},
};

export const adminSnapshotSchema: AddSchemaRequest = {
  schema: {
    name: "BrainAdminSnapshot",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "BrainAdminSnapshot",
    purpose_statement:
      "Privacy-safe fbrain admin dashboard rollup for delivery as a LastDB slice; stores counts and short summaries only, never full brain bodies or secrets",
    schema_type: "Hash",
    key: { hash_field: "slug" },
    fields: [
      "slug",
      "source_app",
      "schema_version",
      "captured_at",
      "type_counts_json",
      "open_decisions_json",
      "active_programs_head_json",
      "recent_heartbeats_json",
    ],
    field_types: {
      slug: "String",
      source_app: "String",
      schema_version: "String",
      captured_at: "String",
      type_counts_json: "String",
      open_decisions_json: "String",
      active_programs_head_json: "String",
      recent_heartbeats_json: "String",
    },
    field_descriptions: {
      slug: "stable snapshot record id, normally admin-brain-snapshot",
      source_app: "producer app id",
      schema_version: "snapshot payload schema version",
      captured_at: "RFC 3339 capture timestamp",
      type_counts_json: "JSON object of live record counts by fbrain type",
      open_decisions_json: "JSON array of open decision slugs and titles only",
      active_programs_head_json:
        "JSON array containing a short active-programs rollup head",
      recent_heartbeats_json:
        "JSON array of recent heartbeat ids, timestamps, and outcomes",
    },
    field_data_classifications: {
      slug: GENERAL,
      source_app: GENERAL,
      schema_version: GENERAL,
      captured_at: GENERAL,
      type_counts_json: GENERAL,
      open_decisions_json: GENERAL,
      active_programs_head_json: GENERAL,
      recent_heartbeats_json: GENERAL,
    },
  },
  mutation_mappers: {},
};

// One BrainAttachmentIndex record per (record_type, record_slug) that has
// attachments — the same shape of internal secondary index as TagIndex.
// `filenames` is the ONLY searchable surface (classified ["word"]); the
// `attachments_json` entries carry blob refs + metadata and are explicitly
// no_index, so nothing about attachment content leaks into BM25/vector search.
export const attachmentIndexSchema: AddSchemaRequest = {
  schema: {
    name: "BrainAttachmentIndex",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "BrainAttachmentIndex",
    purpose_statement:
      "Per-record list of file attachments on an fbrain knowledge record; filename metadata is searchable, attachment content is not",
    schema_type: "Hash",
    key: { hash_field: "slug" },
    fields: [
      "slug",
      "record_type",
      "record_slug",
      "filenames",
      "attachments_json",
      "created_at",
      "updated_at",
    ],
    field_types: {
      slug: "String",
      record_type: "String",
      record_slug: "String",
      filenames: { Array: "String" },
      attachments_json: "String",
      created_at: "String",
      updated_at: "String",
    },
    field_descriptions: {
      slug: "reserved __attidx__<sha256(type:slug)> key",
      record_type: "fbrain record type the attachments belong to",
      record_slug: "fbrain record slug the attachments belong to",
      filenames: "attachment filenames — the only word-indexed surface",
      attachments_json:
        "JSON array of {name, blob_ref, size, media_type, added_at} entries",
      created_at: "RFC 3339 timestamp",
      updated_at: "RFC 3339 timestamp",
    },
    // Explicit classifications for EVERY field: when field_classifications is
    // non-empty the node indexes ONLY fields classified "word" (and never
    // secret/no_index ones) — fold_db mutation_manager
    // `searchable_native_index_fields`. Filenames in, everything else out.
    field_classifications: {
      slug: ["no_index", "metadata"],
      record_type: ["no_index", "metadata"],
      record_slug: ["no_index", "metadata"],
      filenames: ["word"],
      attachments_json: ["no_index", "metadata"],
      created_at: ["no_index", "metadata"],
      updated_at: ["no_index", "metadata"],
    },
    field_data_classifications: {
      slug: GENERAL,
      record_type: GENERAL,
      record_slug: GENERAL,
      filenames: GENERAL,
      attachments_json: GENERAL,
      created_at: GENERAL,
      updated_at: GENERAL,
    },
  },
  mutation_mappers: {},
};

// Content-addressed attachment bytes, keyed by SHA-256 of the raw file. This
// is the same "dev-node stand-in for the app-scoped CAS blob plane" pattern
// lastgit uses (LastgitPackBlob): Mini/lastdbd's `/api/app/blob/cas/sha256/*`
// routes are structurally absent (content-free 404), so v1 stores base64
// bytes in a no_index record field. The blob plane is a storage detail hidden
// behind src/attachments.ts — when the node grows real CAS routes (fold
// docs/designs/cloud-file-blobs-on-demand-sync.md P1/P2), only that module
// changes. `embedding: "never"` + no_index/binary keep the bytes out of every
// search index by construction.
export const attachmentBlobSchema: AddSchemaRequest = {
  schema: {
    name: "BrainAttachmentBlob",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "BrainAttachmentBlob",
    purpose_statement:
      "Content-addressed file bytes backing fbrain attachments; binary payload intentionally excluded from all search indexes",
    schema_type: "Hash",
    key: { hash_field: "content_hash" },
    fields: ["content_hash", "size", "media_type", "data", "created_at"],
    field_types: {
      content_hash: "String",
      size: "String",
      media_type: "String",
      data: "String",
      created_at: "String",
    },
    field_descriptions: {
      content_hash: "SHA-256 hex of the raw file bytes (CAS key)",
      size: "raw file byte length",
      media_type: "MIME type inferred at attach time",
      data: "base64 file bytes; never indexed, never embedded",
      created_at: "RFC 3339 timestamp",
    },
    field_classifications: {
      content_hash: ["no_index", "metadata"],
      size: ["no_index", "metadata"],
      media_type: ["no_index", "metadata"],
      data: ["no_index", "binary"],
      created_at: ["no_index", "metadata"],
    },
    field_data_classifications: {
      content_hash: GENERAL,
      size: GENERAL,
      media_type: GENERAL,
      data: { sensitivity_level: 0, data_domain: "binary" },
      created_at: GENERAL,
    },
  },
  mutation_mappers: {},
};

// v2 attachment storage: one BrainAttachmentFile record per unique content
// hash. The raw bytes do not live in this record; the node's file-blob plane
// stores the encrypted CAS blob and returns a $lastdb_file pointer in `file`.
export const attachmentFileSchema: AddSchemaRequest = {
  schema: {
    name: "BrainAttachmentFile",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "BrainAttachmentFile",
    purpose_statement:
      "Content-addressed $lastdb_file pointer backing an fbrain attachment; bytes live in the encrypted B2 CAS file plane, never in this record",
    schema_type: "Hash",
    key: { hash_field: "content_hash" },
    fields: ["content_hash", "size", "media_type", "file", "created_at"],
    field_types: {
      content_hash: "String",
      size: "String",
      media_type: "String",
      file: "Any",
      created_at: "String",
    },
    field_descriptions: {
      content_hash: "SHA-256 hex of the raw file bytes (CAS key)",
      size: "raw file byte length",
      media_type: "MIME type inferred at attach time",
      file: "$lastdb_file pointer written by the node's file-blob plane; never indexed",
      created_at: "RFC 3339 timestamp",
    },
    field_classifications: {
      content_hash: ["no_index", "metadata"],
      size: ["no_index", "metadata"],
      media_type: ["no_index", "metadata"],
      file: ["no_index", "metadata"],
      created_at: ["no_index", "metadata"],
    },
    field_data_classifications: {
      content_hash: GENERAL,
      size: GENERAL,
      media_type: GENERAL,
      file: { sensitivity_level: 0, data_domain: "file-reference" },
      created_at: GENERAL,
    },
  },
  mutation_mappers: {},
};

/**
 * One fbrain record as a single HashRange row: (rle_h = record type) ×
 * (rle_r = slug). This is the PRODUCT shape for list / BM25 corpus loading.
 *
 * Why: the legacy rollup holds every record of a type — bodies included — in
 * ONE atom, read-modify-written in full on every put. Measured on the primary
 * 2026-07-28 at 446,262 B (6.8× the 64 KiB product default, 85% of the raised
 * ceiling). Crossing the ceiling does not fail the oversized write cleanly —
 * it half-commits: the record lands and the index patch is rejected, which is
 * how `situations notices` silently staled for hours on 2026-07-27. One row
 * per record makes a put O(1) bytes and bounds each atom by ONE record.
 *
 * Field names MUST stay opaque (`rle_*`). Schema Service field-unifies
 * semantic names (slug/title/body/status/…) into an existing record identity;
 * opaque keys plus one payload string mint a novel HashRange identity. Proved
 * for `LastgitPackInventory` 2026-07-25 — see
 * `reference-lastgit-pack-inventory-hashrange-cutover`. The
 * `_hashrange_v2` descriptive-name suffix and the `layout` marker are part of
 * that novelty; do not "tidy" them away.
 */
export const RECORD_LIST_ENTRY_SCHEMA_KEY = "__recordlistentry__";
export const RECORD_LIST_ENTRY_MARKER = "fbrain_record_list_entry_v1";
export const RECORD_LIST_ENTRY_LAYOUT =
  "RecordListEntry novel hashrange rle_h x rle_r";
/**
 * Reserved range key marking "this type's partition holds every record of the
 * type" — i.e. legacy has been drained into it. A slug can never collide with
 * it: record slugs are kebab-case and never contain `__`.
 *
 * Without this marker a non-empty partition is AMBIGUOUS — fully migrated, or
 * one freshly-put row while the other 300 records still sit in legacy. Reading
 * "HashRange wins whenever non-empty" resolves that ambiguity the wrong way and
 * silently truncates the type to the records written since the cutover, which
 * hits `brain list` AND the BM25 corpus behind `brain ask`.
 */
export const RECORD_LIST_ENTRY_MIGRATED_RANGE = "__rle_migrated__";
export const RECORD_LIST_ENTRY_FIELDS = [
  "rle_h",
  "rle_r",
  "rle_payload",
  "rle_marker",
  "layout",
] as const;

export const recordListEntrySchema: AddSchemaRequest = {
  schema: {
    name: "RecordListEntry",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "RecordListEntry_hashrange_v2",
    purpose_statement:
      "One fbrain record per HashRange row (type partition x slug) so list and BM25 read a keyed partition instead of a single full-corpus rollup atom that is rewritten on every put",
    schema_type: "HashRange",
    key: { hash_field: "rle_h", range_field: "rle_r" },
    fields: [...RECORD_LIST_ENTRY_FIELDS],
    field_types: {
      rle_h: "String",
      rle_r: "String",
      rle_payload: "String",
      rle_marker: "String",
      layout: "String",
    },
    field_descriptions: {
      rle_h: "opaque list partition token (record type name value)",
      rle_r: "opaque list range token (record slug value)",
      rle_payload: "json object of ONE fbrain record (not an array of records)",
      rle_marker: "constant token fbrain_record_list_entry_v1",
      layout: RECORD_LIST_ENTRY_LAYOUT,
    },
    field_classifications: {
      rle_h: ["no_index", "metadata"],
      rle_r: ["no_index", "metadata"],
      rle_payload: ["no_index", "metadata"],
      rle_marker: ["no_index", "metadata"],
      layout: ["no_index", "metadata"],
    },
    field_data_classifications: {
      rle_h: GENERAL,
      rle_r: GENERAL,
      rle_payload: GENERAL,
      rle_marker: GENERAL,
      layout: GENERAL,
    },
  },
  mutation_mappers: {},
};

/**
 * One live task per HashRange row, addressed by (ctd_h = design_slug) x
 * (ctd_r = task slug). Lets `findChildTasksByDesign` / the delete cascade
 * guard point-read one design's children (`{HashKey: designSlug}`) instead
 * of reading the WHOLE task partition via `listRecords` and filtering by
 * `design_slug` in the client — the same "list everything, filter locally"
 * shape RecordListEntry replaced, one layer up: task partition size no
 * longer bounds a single-design lookup.
 *
 * Same opaque-field-names shape as `recordListEntrySchema` (`ctd_*` instead
 * of `rle_*`) so Schema Service mints a novel HashRange identity instead of
 * field-unifying into an existing one — see the comment on
 * `recordListEntrySchema` for why that matters.
 *
 * A single reserved GLOBAL marker row (`CHILD_TASK_INDEX_GLOBAL_HASH` /
 * `CHILD_TASK_INDEX_MIGRATED_RANGE`) — not a per-design marker — records
 * "this index reflects every live task's design_slug". One marker suffices
 * because every write path patches its OWN row incrementally from the
 * moment the schema is registered; only the historical backfill (every task
 * that existed before registration) needs the bulk `fbrain reindex
 * --child-task-index` rebuild, and that rebuild covers all designs in one
 * pass and stamps one marker when done.
 */
export const CHILD_TASK_INDEX_SCHEMA_KEY = "__childtaskindex__";
export const CHILD_TASK_INDEX_MARKER = "fbrain_child_task_index_v1";
/**
 * Reserved hash partition for the global completeness marker. Design slugs
 * are kebab-case and never contain `__`, so this can never collide with a
 * real design's partition.
 */
export const CHILD_TASK_INDEX_GLOBAL_HASH = "__ctd_global__";
export const CHILD_TASK_INDEX_MIGRATED_RANGE = "__ctd_migrated__";
export const CHILD_TASK_INDEX_FIELDS = [
  "ctd_h",
  "ctd_r",
  "ctd_payload",
  "ctd_marker",
] as const;

export const childTaskIndexSchema: AddSchemaRequest = {
  schema: {
    name: "ChildTaskIndex",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "ChildTaskIndex_hashrange_v1",
    purpose_statement:
      "One live task per HashRange row (design_slug partition x task slug) so a design's children resolve via a keyed partition read instead of listing every task and filtering by design_slug in the client",
    schema_type: "HashRange",
    key: { hash_field: "ctd_h", range_field: "ctd_r" },
    fields: [...CHILD_TASK_INDEX_FIELDS],
    field_types: {
      ctd_h: "String",
      ctd_r: "String",
      ctd_payload: "String",
      ctd_marker: "String",
    },
    field_descriptions: {
      ctd_h:
        "opaque partition token (parent design slug value, or the reserved global-marker hash)",
      ctd_r:
        "opaque range token (child task slug value, or the reserved migrated-marker range)",
      ctd_payload:
        "json object of ONE fbrain task record (not an array), empty for the marker row",
      ctd_marker: "constant token fbrain_child_task_index_v1",
    },
    field_classifications: {
      ctd_h: ["no_index", "metadata"],
      ctd_r: ["no_index", "metadata"],
      ctd_payload: ["no_index", "metadata"],
      ctd_marker: ["no_index", "metadata"],
    },
    field_data_classifications: {
      ctd_h: GENERAL,
      ctd_r: GENERAL,
      ctd_payload: GENERAL,
      ctd_marker: GENERAL,
    },
  },
  mutation_mappers: {},
};

/**
 * One live papercut per HashRange row, addressed by (status, slug). Product
 * ledger reads query one named status partition (or the six fixed status
 * partitions) rather than the whole papercut type-list partition.
 */
export const PAPERCUT_STATUS_INDEX_SCHEMA_KEY = "__papercutstatusindex__";
export const PAPERCUT_STATUS_INDEX_MARKER = "fbrain_papercut_status_index_v1";
export const PAPERCUT_STATUS_INDEX_GLOBAL_HASH = "__psi_global__";
export const PAPERCUT_STATUS_INDEX_MIGRATED_RANGE = "__psi_migrated__";
export const PAPERCUT_STATUS_INDEX_FIELDS = [
  "psi_h",
  "psi_r",
  "psi_payload",
  "psi_marker",
] as const;

export const papercutStatusIndexSchema: AddSchemaRequest = {
  schema: {
    name: "PapercutStatusIndex",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "PapercutStatusIndex_hashrange_v1",
    purpose_statement:
      "One live papercut per HashRange row (status partition x slug) so filtered ledger reads never enumerate the whole papercut partition",
    schema_type: "HashRange",
    key: { hash_field: "psi_h", range_field: "psi_r" },
    fields: [...PAPERCUT_STATUS_INDEX_FIELDS],
    field_types: {
      psi_h: "String",
      psi_r: "String",
      psi_payload: "String",
      psi_marker: "String",
    },
    field_descriptions: {
      psi_h: "papercut status value, or the reserved global-marker hash",
      psi_r: "papercut slug, or the reserved migrated-marker range",
      psi_payload:
        "json object of one papercut record, empty for the marker row",
      psi_marker: "constant token fbrain_papercut_status_index_v1",
    },
    field_classifications: {
      psi_h: ["no_index", "metadata"],
      psi_r: ["no_index", "metadata"],
      psi_payload: ["no_index", "metadata"],
      psi_marker: ["no_index", "metadata"],
    },
    field_data_classifications: {
      psi_h: GENERAL,
      psi_r: GENERAL,
      psi_payload: GENERAL,
      psi_marker: GENERAL,
    },
  },
  mutation_mappers: {},
};

/**
 * Keep-set membership: one HashRange row per live record, addressed by
 * (type, slug). Default ask reads this partition. Presence is liveness.
 */
export const LIVE_INDEX_SCHEMA_KEY = "__liveindex__";
export const LIVE_INDEX_MARKER = "fbrain_live_index_v1";
export const LIVE_INDEX_FIELDS = [
  "liv_h",
  "liv_r",
  "liv_payload",
  "liv_marker",
] as const;

export const liveIndexSchema: AddSchemaRequest = {
  schema: {
    name: "LiveIndex",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "LiveIndex_hashrange_v1",
    purpose_statement:
      "One live fbrain record per HashRange row (type partition x slug) so default ask never enumerates parked or deleted rows",
    schema_type: "HashRange",
    key: { hash_field: "liv_h", range_field: "liv_r" },
    fields: [...LIVE_INDEX_FIELDS],
    field_types: {
      liv_h: "String",
      liv_r: "String",
      liv_payload: "String",
      liv_marker: "String",
    },
    field_descriptions: {
      liv_h: "opaque partition token (record type name)",
      liv_r: "opaque range token (record slug)",
      liv_payload: "json object of ONE fbrain record",
      liv_marker: "constant token fbrain_live_index_v1",
    },
    field_classifications: {
      liv_h: ["no_index", "metadata"],
      liv_r: ["no_index", "metadata"],
      liv_payload: ["no_index", "metadata"],
      liv_marker: ["no_index", "metadata"],
    },
    field_data_classifications: {
      liv_h: GENERAL,
      liv_r: GENERAL,
      liv_payload: GENERAL,
      liv_marker: GENERAL,
    },
  },
  mutation_mappers: {},
};

/**
 * Topic cluster membership: hash = topic, range = slug. Canonical and
 * parked losers share a partition. The consolidator range-reads one topic.
 */
export const CLUSTER_INDEX_SCHEMA_KEY = "__clusterindex__";
export const CLUSTER_INDEX_MARKER = "fbrain_cluster_index_v1";
export const CLUSTER_INDEX_FIELDS = [
  "clu_h",
  "clu_r",
  "clu_payload",
  "clu_marker",
] as const;

export const clusterIndexSchema: AddSchemaRequest = {
  schema: {
    name: "ClusterIndex",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "ClusterIndex_hashrange_v1",
    purpose_statement:
      "One cluster member per HashRange row (topic partition x slug) so consolidate range-reads one named topic instead of listing every record",
    schema_type: "HashRange",
    key: { hash_field: "clu_h", range_field: "clu_r" },
    fields: [...CLUSTER_INDEX_FIELDS],
    field_types: {
      clu_h: "String",
      clu_r: "String",
      clu_payload: "String",
      clu_marker: "String",
    },
    field_descriptions: {
      clu_h: "opaque partition token (topic slug)",
      clu_r: "opaque range token (record slug)",
      clu_payload: "json object of ONE fbrain record",
      clu_marker: "constant token fbrain_cluster_index_v1",
    },
    field_classifications: {
      clu_h: ["no_index", "metadata"],
      clu_r: ["no_index", "metadata"],
      clu_payload: ["no_index", "metadata"],
      clu_marker: ["no_index", "metadata"],
    },
    field_data_classifications: {
      clu_h: GENERAL,
      clu_r: GENERAL,
      clu_payload: GENERAL,
      clu_marker: GENERAL,
    },
  },
  mutation_mappers: {},
};

/**
 * Parked membership, symmetric with live. A parked row stays gettable and
 * is absent from default ask.
 */
export const PARKED_INDEX_SCHEMA_KEY = "__parkedindex__";
export const PARKED_INDEX_MARKER = "fbrain_parked_index_v1";
export const PARKED_INDEX_FIELDS = [
  "prk_h",
  "prk_r",
  "prk_payload",
  "prk_marker",
] as const;

export const parkedIndexSchema: AddSchemaRequest = {
  schema: {
    name: "ParkedIndex",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "ParkedIndex_hashrange_v1",
    purpose_statement:
      "One parked fbrain record per HashRange row (type partition x slug) so a parked row stays keyed-reachable after it leaves the live keep set",
    schema_type: "HashRange",
    key: { hash_field: "prk_h", range_field: "prk_r" },
    fields: [...PARKED_INDEX_FIELDS],
    field_types: {
      prk_h: "String",
      prk_r: "String",
      prk_payload: "String",
      prk_marker: "String",
    },
    field_descriptions: {
      prk_h: "opaque partition token (record type name)",
      prk_r: "opaque range token (record slug)",
      prk_payload: "json object of ONE fbrain record",
      prk_marker: "constant token fbrain_parked_index_v1",
    },
    field_classifications: {
      prk_h: ["no_index", "metadata"],
      prk_r: ["no_index", "metadata"],
      prk_payload: ["no_index", "metadata"],
      prk_marker: ["no_index", "metadata"],
    },
    field_data_classifications: {
      prk_h: GENERAL,
      prk_r: GENERAL,
      prk_payload: GENERAL,
      prk_marker: GENERAL,
    },
  },
  mutation_mappers: {},
};

/**
 * Ephemeral day membership. Hash = series:yyyy-mm-dd. The reaper names
 * expired day hashes and deletes those primaries.
 */
export const EPH_INDEX_SCHEMA_KEY = "__ephindex__";
export const EPH_INDEX_MARKER = "fbrain_eph_index_v1";
export const EPH_INDEX_FIELDS = [
  "eph_h",
  "eph_r",
  "eph_payload",
  "eph_marker",
] as const;

export const ephIndexSchema: AddSchemaRequest = {
  schema: {
    name: "EphIndex",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "EphIndex_hashrange_v1",
    purpose_statement:
      "One ephemeral record per HashRange row (series-day partition x slug) so a reaper names expired day hashes instead of listing every record",
    schema_type: "HashRange",
    key: { hash_field: "eph_h", range_field: "eph_r" },
    fields: [...EPH_INDEX_FIELDS],
    field_types: {
      eph_h: "String",
      eph_r: "String",
      eph_payload: "String",
      eph_marker: "String",
    },
    field_descriptions: {
      eph_h: "opaque partition token (series colon UTC day)",
      eph_r: "opaque range token (record slug)",
      eph_payload: "json object of ONE fbrain record",
      eph_marker: "constant token fbrain_eph_index_v1",
    },
    field_classifications: {
      eph_h: ["no_index", "metadata"],
      eph_r: ["no_index", "metadata"],
      eph_payload: ["no_index", "metadata"],
      eph_marker: ["no_index", "metadata"],
    },
    field_data_classifications: {
      eph_h: GENERAL,
      eph_r: GENERAL,
      eph_payload: GENERAL,
      eph_marker: GENERAL,
    },
  },
  mutation_mappers: {},
};

// Typed knowledge-graph edges are one product with two access patterns. Both
// schemas expose the same field set and differ only in key layout, allowing
// Mini to protein-bind the fields and fold one source-keyed write into the
// destination-keyed member without app-level payload dual-write.
export const GRAPH_EDGE_OUT_SCHEMA_KEY = "__graphedgeout__";
export const GRAPH_EDGE_IN_SCHEMA_KEY = "__graphedgein__";
export const GRAPH_EDGE_FIELDS = [
  "bge_src",
  "bge_dst",
  "bge_type",
  "bge_provenance",
  "bge_created_at",
  "bge_out_r",
  "bge_in_r",
] as const;

/** Neighbor / path / query / lint / adjacency. Omits range keys and created_at. */
export const GRAPH_EDGE_NEIGHBOR_FIELDS = [
  "bge_src",
  "bge_dst",
  "bge_type",
  "bge_provenance",
] as const;

/** Reconcile must keep created_at so a second put does not reset the timestamp. */
export const GRAPH_EDGE_RECONCILE_FIELDS = [
  ...GRAPH_EDGE_NEIGHBOR_FIELDS,
  "bge_created_at",
] as const;

function graphEdgeSchema(
  name: string,
  hashField: "bge_src" | "bge_dst",
  rangeField: "bge_out_r" | "bge_in_r",
): AddSchemaRequest {
  return {
    schema: {
      name,
      owner_app_id: OWNER_APP_ID,
      descriptive_name: name,
      purpose_statement:
        "One typed fbrain knowledge-graph edge, protein-folded between source and destination HashRange access patterns",
      schema_type: "HashRange",
      key: { hash_field: hashField, range_field: rangeField },
      fields: [...GRAPH_EDGE_FIELDS],
      field_types: Object.fromEntries(
        GRAPH_EDGE_FIELDS.map((field) => [field, "String"]),
      ) as Record<string, FieldType>,
      field_descriptions: {
        bge_src: "source record slug",
        bge_dst: "destination record slug",
        bge_type: "curated edge type, or mentions fallback",
        bge_provenance: "explicit|wikilink|frontmatter",
        bge_created_at: "RFC 3339 timestamp",
        bge_out_r: "source range key type#destination",
        bge_in_r: "destination range key type#source",
      },
      field_classifications: Object.fromEntries(
        GRAPH_EDGE_FIELDS.map((field) => [field, ["no_index", "metadata"]]),
      ),
      field_data_classifications: Object.fromEntries(
        GRAPH_EDGE_FIELDS.map((field) => [field, GENERAL]),
      ),
    },
    mutation_mappers: {},
  };
}

export const graphEdgeOutSchema = graphEdgeSchema(
  "BrainGraphEdgeBySource_hashrange_v1",
  "bge_src",
  "bge_out_r",
);
export const graphEdgeInSchema = graphEdgeSchema(
  "BrainGraphEdgeByDestination_hashrange_v1",
  "bge_dst",
  "bge_in_r",
);

export type RecordTypeDef = {
  type: RecordType;
  schema: AddSchemaRequest;
  statuses: readonly string[];
  defaultStatus: string;
  hasDesignSlug: boolean;
  // Type-specific String columns beyond the shared envelope
  // (slug/title/body/status/tags/created_at/updated_at). The generic record
  // read path (rowToRecord) and write path (buildFields) carry these through
  // from the schema + frontmatter so a dedicated-shape type like `decision`
  // needs no per-field special-casing. `design_slug` predates this and stays
  // on its own `hasDesignSlug` flag.
  extraStringFields?: readonly string[];
};

export const RECORDS: Record<RecordType, RecordTypeDef> = {
  design: {
    type: "design",
    schema: designSchema,
    statuses: DESIGN_STATUSES,
    defaultStatus: "draft",
    hasDesignSlug: false,
  },
  task: {
    type: "task",
    schema: taskSchema,
    statuses: TASK_STATUSES,
    defaultStatus: "open",
    hasDesignSlug: true,
  },
  concept: {
    type: "concept",
    schema: conceptSchema,
    statuses: CONCEPT_STATUSES,
    defaultStatus: "active",
    hasDesignSlug: false,
  },
  preference: {
    type: "preference",
    schema: preferenceSchema,
    statuses: PREFERENCE_STATUSES,
    defaultStatus: "active",
    hasDesignSlug: false,
  },
  reference: {
    type: "reference",
    schema: referenceSchema,
    statuses: REFERENCE_STATUSES,
    defaultStatus: "active",
    hasDesignSlug: false,
  },
  agent: {
    type: "agent",
    schema: agentSchema,
    statuses: AGENT_STATUSES,
    defaultStatus: "active",
    hasDesignSlug: false,
  },
  project: {
    type: "project",
    schema: projectSchema,
    statuses: PROJECT_STATUSES,
    defaultStatus: "planning",
    hasDesignSlug: false,
  },
  spike: {
    type: "spike",
    schema: spikeSchema,
    statuses: SPIKE_STATUSES,
    defaultStatus: "active",
    hasDesignSlug: false,
  },
  sop: {
    type: "sop",
    schema: sopSchema,
    statuses: SOP_STATUSES,
    defaultStatus: "active",
    hasDesignSlug: false,
  },
  decision: {
    type: "decision",
    schema: decisionSchema,
    statuses: DECISION_STATUSES,
    defaultStatus: "go",
    hasDesignSlug: false,
    extraStringFields: ["program", "gate_slug", "decided_by", "decided_on"],
  },
  papercut: {
    type: "papercut",
    schema: papercutSchema,
    statuses: PAPERCUT_STATUSES,
    defaultStatus: "open",
    hasDesignSlug: false,
    extraStringFields: [
      "component",
      "repo",
      "severity",
      "kind",
      "symptom_hash",
      "fixed_by",
      "verified_by",
      "duplicate_of",
    ],
  },
};

// UNIQUE_SCHEMAS lists every schema `fbrain init` must register. Each
// entry binds a config-key (where `init` writes the canonical hash) to
// the AddSchemaRequest. One entry per RecordType — no legacy alias.
export type UniqueSchemaEntry = {
  key: string;
  schema: AddSchemaRequest;
  types: RecordType[];
  extraKeys?: string[];
};

export const UNIQUE_SCHEMAS: UniqueSchemaEntry[] = [
  ...RECORD_TYPES.map(
    (type): UniqueSchemaEntry => ({
      key: type,
      schema: RECORDS[type].schema,
      types: [type],
    }),
  ),
  {
    key: TAG_INDEX_SCHEMA_KEY,
    schema: tagIndexSchema,
    types: [],
    extraKeys: [TAG_INDEX_SCHEMA_KEY],
  },
  {
    key: ADMIN_SNAPSHOT_SCHEMA_KEY,
    schema: adminSnapshotSchema,
    types: [],
    extraKeys: [ADMIN_SNAPSHOT_SCHEMA_KEY],
  },
  {
    key: ATTACHMENT_INDEX_SCHEMA_KEY,
    schema: attachmentIndexSchema,
    types: [],
    extraKeys: [ATTACHMENT_INDEX_SCHEMA_KEY],
  },
  {
    key: ATTACHMENT_BLOB_SCHEMA_KEY,
    schema: attachmentBlobSchema,
    types: [],
    extraKeys: [ATTACHMENT_BLOB_SCHEMA_KEY],
  },
  {
    key: ATTACHMENT_FILE_SCHEMA_KEY,
    schema: attachmentFileSchema,
    types: [],
    extraKeys: [ATTACHMENT_FILE_SCHEMA_KEY],
  },
  {
    key: RECORD_LIST_ENTRY_SCHEMA_KEY,
    schema: recordListEntrySchema,
    types: [],
    extraKeys: [RECORD_LIST_ENTRY_SCHEMA_KEY],
  },
  {
    key: CHILD_TASK_INDEX_SCHEMA_KEY,
    schema: childTaskIndexSchema,
    types: [],
    extraKeys: [CHILD_TASK_INDEX_SCHEMA_KEY],
  },
  {
    key: PAPERCUT_STATUS_INDEX_SCHEMA_KEY,
    schema: papercutStatusIndexSchema,
    types: [],
    extraKeys: [PAPERCUT_STATUS_INDEX_SCHEMA_KEY],
  },
  {
    key: LIVE_INDEX_SCHEMA_KEY,
    schema: liveIndexSchema,
    types: [],
    extraKeys: [LIVE_INDEX_SCHEMA_KEY],
  },
  {
    key: CLUSTER_INDEX_SCHEMA_KEY,
    schema: clusterIndexSchema,
    types: [],
    extraKeys: [CLUSTER_INDEX_SCHEMA_KEY],
  },
  {
    key: PARKED_INDEX_SCHEMA_KEY,
    schema: parkedIndexSchema,
    types: [],
    extraKeys: [PARKED_INDEX_SCHEMA_KEY],
  },
  {
    key: EPH_INDEX_SCHEMA_KEY,
    schema: ephIndexSchema,
    types: [],
    extraKeys: [EPH_INDEX_SCHEMA_KEY],
  },
  {
    key: GRAPH_EDGE_OUT_SCHEMA_KEY,
    schema: graphEdgeOutSchema,
    types: [],
    extraKeys: [GRAPH_EDGE_OUT_SCHEMA_KEY],
  },
  {
    key: GRAPH_EDGE_IN_SCHEMA_KEY,
    schema: graphEdgeInSchema,
    types: [],
    extraKeys: [GRAPH_EDGE_IN_SCHEMA_KEY],
  },
];

export function schemaConfigKeys(entry: {
  types: RecordType[];
  extraKeys?: string[];
}): string[] {
  return [...entry.types, ...(entry.extraKeys ?? [])];
}

// Resolve an already-published fbrain schema's canonical hash from the set
// the node loaded out of the schema-service catalog (GET /api/schemas). The
// match key is (descriptive_name, owner_app_id) — exactly the two signals the
// schema service folds into a namespaced identity. This is the fresh-consumer
// path: the `fbrain/*` record schemas are pre-published org-wide, so init reads
// their canonical hashes here instead of re-POSTing (which needs a DevCert).
export function resolveOwnedSchemaHash(
  req: AddSchemaRequest,
  loaded: ReadonlyArray<{
    descriptive_name?: string;
    owner_app_id?: string;
    identity_hash?: string;
  }>,
): string | null {
  const wantName = req.schema.descriptive_name;
  const wantOwner = req.schema.owner_app_id;
  for (const s of loaded) {
    if (
      s.descriptive_name === wantName &&
      s.owner_app_id === wantOwner &&
      typeof s.identity_hash === "string" &&
      s.identity_hash.length > 0
    ) {
      return s.identity_hash;
    }
  }
  return null;
}

// Human-facing "what is this type for" one-liners, surfaced in the README
// and the top-level CLI help so a brand-new dev can tell which record type
// record types to reach for. SINGLE SHARED SOURCE — both surfaces read this
// map, so they cannot drift.
//
// For the six Phase 6 types the string IS the canonical `purpose_statement`
// the dual-signal gate keys on (derived below, not re-typed). `design` and
// `task` carry the bare descriptive_name as their wire `purpose_statement`
// ("Design"/"Task"), which is not a usable sentence, so they get a short
// hand-written one-liner here. This is presentation only — it never changes a
// schema definition, hash, or wire `purpose_statement`.
const HANDWRITTEN_PURPOSES: Partial<Record<RecordType, string>> = {
  design: "An architecture or plan you intend to build",
  task: "A unit of work; links to a parent design",
  papercut: "A defect in our own tooling — file with `brain papercut file`",
};

// Record types with NO `<type> new` verb. `papercut` is created only through
// `brain papercut file`, which is the surface that enforces the dedupe gate;
// a generic `papercut new` would be a documented way around it.
export const TYPES_WITHOUT_NEW_VERB: ReadonlySet<RecordType> = new Set([
  "papercut",
]);

export const RECORD_PURPOSES: Record<RecordType, string> = Object.fromEntries(
  RECORD_TYPES.map((t) => [
    t,
    HANDWRITTEN_PURPOSES[t] ?? RECORDS[t].schema.schema.purpose_statement ?? t,
  ]),
) as Record<RecordType, string>;

export function purposeFor(type: RecordType): string {
  return RECORD_PURPOSES[type];
}

export function recordStatusLines(): string {
  return RECORD_TYPES.map(
    (type) => `${type} = ${RECORDS[type].statuses.join("|")}`,
  ).join("; ");
}

// The single copy-paste CLAUDE.md block that teaches an agent *when* and *why*
// to reach for the fbrain MCP tools — the agent usage-loop plus the record-type
// table. SINGLE SOURCE: `fbrain mcp instructions` prints exactly this, and the
// fenced block in `docs/agent-instructions.md` is asserted equal to it by a
// drift test, so the on-ramp command and the doc can never diverge. The table's
// "Use it for" column renders from RECORD_PURPOSES (above), so it also can't
// drift from the README / bare-`fbrain` help. Output is plain markdown — no
// ANSI, pipe-safe, paste-ready (the caller appends a trailing newline).
export function buildAgentInstructionsBlock(): string {
  const tableRows = RECORD_TYPES.map(
    (t) => `   | \`${t}\` | ${RECORD_PURPOSES[t]} |`,
  ).join("\n");
  return `## fbrain (persistent memory)

You have an \`fbrain\` MCP brain — a searchable store of prior decisions, learnings,
and context that survives across sessions. Use it as a loop, not a filing cabinet:

1. **Recall first.** Before answering a non-trivial question or starting a task,
   call \`fbrain_ask\` (hybrid BM25 + vector recall — the strongest retrieval) to
   pull relevant prior context. Don't answer from memory alone when the brain may
   already hold the answer. Use \`fbrain_search\` for a pure-semantic lookup,
   \`fbrain_get\`/\`fbrain_list\` when you know the slug or want to browse a type.

2. **Checkpoint as you go.** When a decision, learning, or durable fact is
   settled, write it with \`fbrain_put\` *then* — don't wait to be asked, and don't
   batch it all to the end of the session where it gets lost. A one-line note now
   beats a perfect note never. Unless the body is a short single line, stage it
   to a file and pass \`body_path\` (or pass \`body_b64\`) instead of inlining
   \`body\` — an inline \`body\` with newlines, quotes, or emoji can fail to parse
   (an opaque \`could not be parsed as JSON\` error) or be dropped in transit at
   ANY size, so this is not size-gated; a short path/base64 always survives. To
   UPDATE an existing record, reach for the
   right-sized tool instead of a full \`fbrain_put\`: \`fbrain_status\` changes only
   the status, and \`fbrain_append\` adds to the body without a rewrite. This
   matters because \`fbrain_put\` is a FULL REPLACE whose body defaults to empty —
   a status-only re-put wipes the body, and a get-then-re-put truncates any
   record bigger than one \`fbrain_get\` window. \`fbrain_put\` guards against that
   (it refuses a re-put that would shrink the body dramatically), so let the
   guard route you to \`fbrain_append\`/\`fbrain_status\` rather than overriding it.

3. **Pick the right type.** Every record has a type; choose the one whose purpose
   matches what you're recording (\`fbrain_put\` requires a type — there is no
   silent default):

   | Type | Use it for |
   |---|---|
${tableRows}

   Link records with \`fbrain_link\`. Passing only \`from_slug\` and \`to_slug\`
   preserves the legacy task → design default; pass \`from_type\`/\`to_type\` for
   non-default explicit links. Use \`fbrain_backlinks\` or \`fbrain_get\`'s
   \`linked_from\` field to see both explicit edges and body \`[[slug]]\`
   references. Slugs are per-type, so pass \`type\` to
   \`fbrain_get\`/\`fbrain_delete\` whenever a slug could be ambiguous.

4. **It scales — call it liberally.** Point lookups (\`fbrain_get\`, a filtered
   \`fbrain_list\`) are index-backed and stay flat, well under a millisecond, from
   a thousand records to well past a hundred thousand — recalling a known slug
   never gets slower as the brain grows. \`fbrain_ask\`/\`fbrain_search\` run over
   an ANN-indexed vector store, around 4ms at 120K embedded fragments versus
   around 46ms for an exhaustive scan — fast enough to call before every
   non-trivial answer, not just the hard ones. The one call whose cost tracks
   corpus size is an unfiltered \`fbrain_list\` with no type, tag, or status — it
   returns every live record, so scope it when browsing a large brain.`;
}

export function isRecordType(s: string): s is RecordType {
  return (RECORD_TYPES as readonly string[]).includes(s);
}

export function statusValuesFor(type: RecordType): readonly string[] {
  return RECORDS[type].statuses;
}

export function isValidStatus(type: RecordType, status: string): boolean {
  return (RECORDS[type].statuses as readonly string[]).includes(status);
}

export function defaultStatusFor(type: RecordType): string {
  return RECORDS[type].defaultStatus;
}

export function schemaFor(type: RecordType): AddSchemaRequest {
  return RECORDS[type].schema;
}
