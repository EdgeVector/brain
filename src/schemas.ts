// Schema definitions for fbrain's record types.
// Proteins are deprecated for new designs. The definitions below retain the
// existing layout until an explicit conversion preserves its ordered keys.
// Canonical field aliases describe fields; they do not authorize value aliases.
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

export type FieldType = "String" | "DateTime" | "Any" | { Array: "String" };

export type SchemaDefinition = {
  name: string;
  // App-identity ownership. The schema_service folds this into the identity
  // hash and stores the schema under the canonical name `{owner_app_id}/{name}`
  // (= `fbrain/<Name>`). Set on every fbrain schema; optional in the TS type
  // so externally-loaded schema definitions (e.g. legacy definitions, or future
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
  // exists for a page key. A page row uses a hash and a range.
  schema_type: "Hash" | "HashRange";
  key: { hash_field?: string; range_field?: string };
  /** Reuse canonical field definitions without sharing record values. */
  independent_fields?: boolean;
  alternate_keys?: Record<string, {
    hash_field?: string;
    hash_literal?: string;
    range_field?: string | null;
    range_parts?: Array<{ field: string; format?: "text" | "reverse_time_millis" | { padded_text: { width: number } } }>;
    range_separator?: string;
    omit_empty_hash?: boolean;
    missing?: "reject" | "omit";
  }>;
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
// One sidecar per (record type, slug, field). The pointer is the whole `file` value.
export const BODY_FILE_SCHEMA_KEY = "__bodyfile__";
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

/**
 * Tag membership, one small HashRange row per (tag, member). Replaces the
 * legacy `TagIndex` layout, whose single `members: string[]` field held EVERY
 * member of a tag and was rewritten whole on each add (a 158 KB atom growing
 * 65 bytes an hour on the primary, 2026-10-12). Atoms stay small: add or remove
 * one member is one small write or one delete, never a read-modify-write of a
 * list. Two devices that add different members of one tag write different
 * rows, so nothing conflicts.
 *
 * hash `tmb_h` = `__tagidx__<sha256(tag)>` (the same key the legacy row used),
 * range `tmb_r` = member key `type:slug`. Two reserved ranges sit under the
 * same hash: `TAG_MEMBER_MIGRATED_RANGE` is the per-tag "legacy members were
 * copied" marker and `TAG_MEMBER_COPYING_RANGE` is a short-lived claim that
 * keeps two callers from copying one tag at once. Both carry a small JSON note
 * in `tmb_copy`; see src/tag-index.ts for the dual-read. The legacy `TagIndex`
 * schema stays registered so its rows stay readable; it is never written again.
 *
 * Field names and descriptions are specific on purpose. The schema service
 * unifies fields by identity: a first draft of this schema had a generic
 * "RFC 3339 timestamp" field, the service unified it with another app's
 * `bge_created_at`, and the node then refused every write of the draft's own
 * field name (2026-10-12, dev service). So there is no timestamp field, and no
 * description repeats the wording of a sibling index or of the legacy TagIndex.
 *
 * Register this schema ONLY through `brain init`. The node registers a new
 * schema in the Schema Service of its OWN environment, not the one brain's
 * config names, so no write path may declare it.
 */
export const TAG_MEMBER_SCHEMA_KEY = "__tagmember__";
export const TAG_MEMBER_MIGRATED_RANGE = "__tmb_migrated__";
export const TAG_MEMBER_COPYING_RANGE = "__tmb_copying__";
export const TAG_MEMBER_FIELDS = [
  "tmb_h",
  "tmb_r",
  "tmb_tag",
  "tmb_copy",
] as const;

export const tagMemberSchema: AddSchemaRequest = {
  schema: {
    name: "TagMembership",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "TagMembership_hashrange_v1",
    purpose_statement:
      "Per-member rows of the fbrain tag and backlink membership layout: one row names one record that carries one tag or links to one target, so adding or removing a member is a single small write and a read is a keyed partition read",
    schema_type: "HashRange",
    key: { hash_field: "tmb_h", range_field: "tmb_r" },
    fields: [...TAG_MEMBER_FIELDS],
    field_types: {
      tmb_h: "String",
      tmb_r: "String",
      tmb_tag: "String",
      tmb_copy: "String",
    },
    field_descriptions: {
      tmb_h:
        "partition key of a membership row: the text __tagidx__ followed by the lowercase hex sha-256 of one tag value or one link-target tag",
      tmb_r:
        "entry key inside a membership partition: the member record type, a colon, then the member slug; a reserved key that starts with two underscores marks a copy stamp or a copy claim",
      tmb_tag:
        "display copy of the tag text behind the partition key, cut to its first 1 KiB; informational and never used as a key",
      tmb_copy:
        "small JSON note set only on a reserved row of a partition: a legacy-copy stamp (members copied, digest, time) or a short-lived copy claim (owner id and expiry); never set on a member row",
    },
    // Not searchable, for the reason the legacy TagIndex gives: machine keys
    // crowd the head of every unscoped search.
    field_classifications: {
      tmb_h: ["no_index", "metadata"],
      tmb_r: ["no_index", "metadata"],
      tmb_tag: ["no_index", "metadata"],
      tmb_copy: ["no_index", "metadata"],
    },
    field_data_classifications: {
      tmb_h: GENERAL,
      tmb_r: GENERAL,
      tmb_tag: GENERAL,
      tmb_copy: GENERAL,
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

// One immutable BrainBodyFile per spilled field and content hash. The full text
// is a local file blob. Reads also accept the original per-field sidecar key.
// `file` is type Any and holds the `$lastdb_file` pointer as the whole value.
// A pointer inside a JSON string is not a reference. Knowledge schemas gain no
// field: a new field would re-hash every record. The record keeps a head and a
// marker line that names this sidecar.
export const bodyFileSchema: AddSchemaRequest = {
  schema: {
    name: "BrainBodyFile",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "BrainBodyFile",
    purpose_statement:
      "Pointer to a local CAS file blob that holds the full long text of one fbrain record field (body, papercut evidence); the record keeps only a bounded head and a marker line",
    schema_type: "Hash",
    key: { hash_field: "file_key" },
    fields: [
      "file_key",
      "record_type",
      "record_slug",
      "record_field",
      "content_hash",
      "size",
      "file",
      "created_at",
      "updated_at",
    ],
    field_types: {
      file_key: "String",
      record_type: "String",
      record_slug: "String",
      record_field: "String",
      content_hash: "String",
      size: "String",
      file: "Any",
      created_at: "String",
      updated_at: "String",
    },
    field_descriptions: {
      file_key: "__bodyfile__<sha256(record_type:record_slug:record_field)> (hash key)",
      record_type: "owning record's type",
      record_slug: "owning record's slug",
      record_field: "which text field of the record was spilled (body, verified_by, fixed_by)",
      content_hash: "SHA-256 hex of the full UTF-8 text",
      size: "full text byte length",
      file: "$lastdb_file pointer written by put-blob-local; the whole field value, never indexed",
      created_at: "BrainBodyFile time this sidecar was first stored",
      updated_at: "BrainBodyFile time this sidecar was last replaced",
    },
    field_classifications: {
      file_key: ["no_index", "metadata"],
      record_type: ["no_index", "metadata"],
      record_slug: ["no_index", "metadata"],
      record_field: ["no_index", "metadata"],
      content_hash: ["no_index", "metadata"],
      size: ["no_index", "metadata"],
      file: ["no_index", "metadata"],
      created_at: ["no_index", "metadata"],
      updated_at: ["no_index", "metadata"],
    },
    field_data_classifications: {
      file_key: GENERAL,
      record_type: GENERAL,
      record_slug: GENERAL,
      record_field: GENERAL,
      content_hash: GENERAL,
      size: GENERAL,
      file: { sensitivity_level: 0, data_domain: "file-reference" },
      created_at: GENERAL,
      updated_at: GENERAL,
    },
  },
  mutation_mappers: {},
};


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
};

// Thin list plane. `brain init` is the only registrar. A write path must not
// declare these. Field names stay opaque so a shared description cannot bind
// them to an older field (the 2026-10-12 `bge_created_at` refusal).
export const BRAIN_LIST_PAGE_SCHEMA_KEY = "__brainlistpage__";
export const BRAIN_LIST_LOCATOR_SCHEMA_KEY = "__brainlistlocator__";
export const BRAIN_COMPACT_LOCATOR_SCHEMA_KEY = "__braincompactlocator__";
export const BRAIN_TYPE_DIRECTORY_SCHEMA_KEY = "__braintypedirectory__";
export const BRAIN_LIST_COUNT_SCHEMA_KEY = "__brainlistcount__";
export const BRAIN_EDGE_SET_SCHEMA_KEY = "__brainedgeset__";
export const BRAIN_TOKEN_SET_SCHEMA_KEY = "__braintokenset__";
export const BRAIN_BACKFILL_CURSOR_SCHEMA_KEY = "__brainbackfillcursor__";

function supportSchema(opts: {
  name: string;
  purpose: string;
  schemaType: "Hash" | "HashRange";
  hashField: string;
  rangeField?: string;
  fields: ReadonlyArray<{ name: string; description: string }>;
}): AddSchemaRequest {
  const field_types: Record<string, FieldType> = {};
  const field_descriptions: Record<string, string> = {};
  const field_classifications: Record<string, string[]> = {};
  const field_data_classifications: SchemaDefinition["field_data_classifications"] = {};
  for (const field of opts.fields) {
    field_types[field.name] = "String";
    field_descriptions[field.name] = field.description;
    field_classifications[field.name] = ["no_index", "metadata"];
    field_data_classifications[field.name] = GENERAL;
  }
  return {
    schema: {
      name: opts.name,
      owner_app_id: OWNER_APP_ID,
      descriptive_name: opts.name,
      purpose_statement: opts.purpose,
      schema_type: opts.schemaType,
      key: opts.rangeField
        ? { hash_field: opts.hashField, range_field: opts.rangeField }
        : { hash_field: opts.hashField },
      fields: opts.fields.map((field) => field.name),
      field_types,
      field_descriptions,
      field_classifications,
      field_data_classifications,
    },
    mutation_mappers: {},
  };
}

export const brainListPageSchema = supportSchema({
  name: "BrainListPage",
  purpose:
    "One thin list page for brain list, addressed by a list hash and a page id, holding card ids and a short title and no body",
  schemaType: "HashRange",
  hashField: "blp_h",
  rangeField: "blp_r",
  fields: [
    {
      name: "blp_h",
      description:
        "BrainListPage hash token: all, a type name, a type and status, a tag, a child design, a link target, or a symptom",
    },
    {
      name: "blp_r",
      description:
        "BrainListPage range token: the head marker __head__ or a page id of p plus eight digits, never a time",
    },
    {
      name: "blp_page",
      description:
        "BrainListPage JSON atom: a card list and the older page id, with no record body",
    },
  ],
});

export const brainListLocatorSchema = supportSchema({
  name: "BrainListLocator",
  purpose:
    "One locator that names the single list page holding one brain card, so a put rewrites that page without walking the chain",
  schemaType: "HashRange",
  hashField: "bll_h",
  rangeField: "bll_r",
  fields: [
    {
      name: "bll_h",
      description: "BrainListLocator hash token: loc# plus the list hash",
    },
    {
      name: "bll_r",
      description: "BrainListLocator range token: type#slug of the card",
    },
    {
      name: "bll_page",
      description:
        "BrainListLocator atom: the page id of the card, either __head__ or p plus eight digits",
    },
  ],
});

export const brainCompactLocatorSchema: AddSchemaRequest = {
  schema: {
    name: "BrainCompactListLocator_v1",
    descriptive_name: "BrainCompactListLocator_v1",
    owner_app_id: OWNER_APP_ID,
    purpose_statement: "One exact compact list-locator value addressed by the digest of its list and card identity; no ordered range",
    schema_type: "Hash",
    // Explicit request coordinates address the sole field's molecule. There
    // are no redundant hash/range fields for Mini to materialize and store.
    key: {},
    fields: ["bcl_page"],
    field_types: { bcl_page: "String" },
    field_descriptions: { bcl_page: "Compact Brain list-locator v1 value: the current page id for the tuple digest" },
    field_classifications: { bcl_page: ["no_index", "metadata"] },
    field_data_classifications: { bcl_page: GENERAL },
  },
  mutation_mappers: {},
};

export const brainTypeDirectorySchema = supportSchema({
  name: "BrainTypeDirectory",
  purpose:
    "One directory atom per slug that lists which brain record types use that slug",
  schemaType: "HashRange",
  hashField: "btd_h",
  rangeField: "btd_r",
  fields: [
    {
      name: "btd_h",
      description: "BrainTypeDirectory hash token: the record slug",
    },
    {
      name: "btd_r",
      description: "BrainTypeDirectory range token: the fixed marker __types__",
    },
    {
      name: "btd_types",
      description: "BrainTypeDirectory JSON list of type names for that slug",
    },
  ],
});

export const brainListCountSchema = supportSchema({
  name: "BrainListCount",
  purpose:
    "One decimal counter for the whole brain list or for one record type, not for a status, a tag, or a time window",
  schemaType: "Hash",
  hashField: "bln_h",
  fields: [
    {
      name: "bln_h",
      description: "BrainListCount hash token: all, or one type name",
    },
    {
      name: "bln_n",
      description: "BrainListCount decimal text for that hash",
    },
  ],
});

export const brainEdgeSetSchema = supportSchema({
  name: "BrainEdgeSet",
  purpose:
    "One capped set of graph-edge ids for a brain record, so a neighbor read does not range-read the out edge schema",
  schemaType: "HashRange",
  hashField: "bes_h",
  rangeField: "bes_r",
  fields: [
    {
      name: "bes_h",
      description: "BrainEdgeSet hash token: es# plus the record type and slug",
    },
    {
      name: "bes_r",
      description: "BrainEdgeSet range token: the fixed marker __head__",
    },
    {
      name: "bes_ids",
      description:
        "BrainEdgeSet JSON list of type#destination values, at most sixteen",
    },
  ],
});

export const brainTokenSetSchema = supportSchema({
  name: "BrainTokenSet",
  purpose:
    "One capped token list for a brain record. An absent atom reads as an empty token list. Keyword pages are a later write",
  schemaType: "HashRange",
  hashField: "bts_h",
  rangeField: "bts_r",
  fields: [
    {
      name: "bts_h",
      description: "BrainTokenSet hash token: ts# plus the record type and slug",
    },
    {
      name: "bts_r",
      description: "BrainTokenSet range token: the fixed marker __head__",
    },
    {
      name: "bts_tokens",
      description:
        "BrainTokenSet JSON list of tokens this record wrote, at most eight",
    },
  ],
});

export const brainBackfillCursorSchema = supportSchema({
  name: "BrainBackfillCursor",
  purpose:
    "One cursor for a named-slug list backfill. The atom stores the last source slug and the count added for that slug",
  schemaType: "HashRange",
  hashField: "bfc_h",
  rangeField: "bfc_r",
  fields: [
    {
      name: "bfc_h",
      description:
        "BrainBackfillCursor hash token: bf# plus the target list hash and the source type",
    },
    {
      name: "bfc_r",
      description: "BrainBackfillCursor range token: the fixed marker __cursor__",
    },
    {
      name: "bfc_state",
      description:
        "BrainBackfillCursor JSON atom with the last source slug and the count added for that slug",
    },
  ],
});

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
    key: TAG_MEMBER_SCHEMA_KEY,
    schema: tagMemberSchema,
    types: [],
    extraKeys: [TAG_MEMBER_SCHEMA_KEY],
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
    key: BODY_FILE_SCHEMA_KEY,
    schema: bodyFileSchema,
    types: [],
    extraKeys: [BODY_FILE_SCHEMA_KEY],
  },
  {
    key: BRAIN_LIST_PAGE_SCHEMA_KEY,
    schema: brainListPageSchema,
    types: [],
    extraKeys: [BRAIN_LIST_PAGE_SCHEMA_KEY],
  },
  {
    key: BRAIN_LIST_LOCATOR_SCHEMA_KEY,
    schema: brainListLocatorSchema,
    types: [],
    extraKeys: [BRAIN_LIST_LOCATOR_SCHEMA_KEY],
  },
  {
    key: BRAIN_COMPACT_LOCATOR_SCHEMA_KEY,
    schema: brainCompactLocatorSchema,
    types: [],
    extraKeys: [BRAIN_COMPACT_LOCATOR_SCHEMA_KEY],
  },
  {
    key: BRAIN_TYPE_DIRECTORY_SCHEMA_KEY,
    schema: brainTypeDirectorySchema,
    types: [],
    extraKeys: [BRAIN_TYPE_DIRECTORY_SCHEMA_KEY],
  },
  {
    key: BRAIN_LIST_COUNT_SCHEMA_KEY,
    schema: brainListCountSchema,
    types: [],
    extraKeys: [BRAIN_LIST_COUNT_SCHEMA_KEY],
  },
  {
    key: BRAIN_EDGE_SET_SCHEMA_KEY,
    schema: brainEdgeSetSchema,
    types: [],
    extraKeys: [BRAIN_EDGE_SET_SCHEMA_KEY],
  },
  {
    key: BRAIN_TOKEN_SET_SCHEMA_KEY,
    schema: brainTokenSetSchema,
    types: [],
    extraKeys: [BRAIN_TOKEN_SET_SCHEMA_KEY],
  },
  {
    key: BRAIN_BACKFILL_CURSOR_SCHEMA_KEY,
    schema: brainBackfillCursorSchema,
    types: [],
    extraKeys: [BRAIN_BACKFILL_CURSOR_SCHEMA_KEY],
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
    fields?: string[];
    field_types?: Record<string,unknown>;
  }>,
  canonicalVocabulary = false,
): string | null {
  const expected = req.schema;
  const wantName = req.schema.descriptive_name;
  const wantOwner = req.schema.owner_app_id;
  for (const s of loaded) {
    if (
      s.descriptive_name === wantName &&
      s.owner_app_id === wantOwner &&
      typeof s.identity_hash === "string" &&
      s.identity_hash.length > 0 &&
      (!canonicalVocabulary || (expected.fields.every((field) => s.fields?.includes(field) &&
        JSON.stringify(s.field_types?.[field]) === JSON.stringify(expected.field_types[field])) &&
        s.fields?.every((field) => expected.fields.includes(field))))
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
};

// Every record type has a `<type> new` verb.
export const TYPES_WITHOUT_NEW_VERB: ReadonlySet<RecordType> = new Set();

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
   non-default explicit links. \`fbrain_get\`'s \`linked_from\` field lists the
   type and slug of every record that links here (one index read, cheap to
   crawl); call \`fbrain_backlinks\` when you also need each source's status
   and whether it links by explicit edge or body \`[[slug]]\` reference.
   Slugs are per-type, so pass \`type\` to \`fbrain_get\`/\`fbrain_delete\`
   whenever a slug could be ambiguous; without it, the type named by the
   slug prefix (\`design-…\`, \`decision-…\`) is tried first.

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
