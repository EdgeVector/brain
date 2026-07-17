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

export type FieldType = "String" | { Array: "String" };

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
  schema_type: "Hash";
  key: { hash_field: string };
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

export const CONCEPT_STATUSES = ["active", "archived"] as const;

export const PREFERENCE_STATUSES = ["active", "superseded"] as const;

export const REFERENCE_STATUSES = ["active", "broken", "archived"] as const;

export const AGENT_STATUSES = ["active", "archived"] as const;

export const PROJECT_STATUSES = ["planning", "in_progress", "done", "archived"] as const;

export const SPIKE_STATUSES = ["active", "concluded"] as const;

export const SOP_STATUSES = ["active", "superseded", "archived"] as const;

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
      active_programs_head_json: "JSON array containing a short active-programs rollup head",
      recent_heartbeats_json: "JSON array of recent heartbeat ids, timestamps, and outcomes",
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
  loaded: ReadonlyArray<{ descriptive_name?: string; owner_app_id?: string; identity_hash?: string }>,
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
};

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
  return RECORD_TYPES.map((type) => `${type} = ${RECORDS[type].statuses.join("|")}`).join("; ");
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
