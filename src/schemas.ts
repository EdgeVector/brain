// Schema definitions for fbrain's record types.
//
// Eight schemas are registered:
//
//   - **Design**, **Task** — Phase 1, unchanged.
//   - **Concept**, **Preference**, **Reference**, **Agent**, **Project**,
//     **Spike** — Phase 6 kinds. As of Phase E (the dual-signal
//     canonicalization cutover) each gets its own dedicated schema with
//     a distinct `descriptive_name` + `purpose_statement`. The schema
//     service's dual-signal gate uses the purpose-statement embedding to
//     veto structural collapse, so all six can share the same 7-field
//     shape without colliding onto a single canonical hash.
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

/** Prefix a short schema name with the owning app id → canonical `fbrain/<Name>`. */
export function namespacedSchemaName(shortName: string): string {
  return `${OWNER_APP_ID}/${shortName}`;
}

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
export type DesignStatus = (typeof DESIGN_STATUSES)[number];

export const TASK_STATUSES = [
  "open",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const CONCEPT_STATUSES = ["active", "archived"] as const;
export type ConceptStatus = (typeof CONCEPT_STATUSES)[number];

export const PREFERENCE_STATUSES = ["active", "superseded"] as const;
export type PreferenceStatus = (typeof PREFERENCE_STATUSES)[number];

export const REFERENCE_STATUSES = ["active", "broken", "archived"] as const;
export type ReferenceStatus = (typeof REFERENCE_STATUSES)[number];

export const AGENT_STATUSES = ["active", "archived"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const PROJECT_STATUSES = ["planning", "in_progress", "done", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const SPIKE_STATUSES = ["active", "concluded"] as const;
export type SpikeStatus = (typeof SPIKE_STATUSES)[number];

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

export const designSchema: AddSchemaRequest = {
  schema: {
    name: "Design",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "Design",
    purpose_statement: "Design",
    schema_type: "Hash",
    key: { hash_field: "slug" },
    fields: [
      "slug",
      "title",
      "body",
      "status",
      "tags",
      "created_at",
      "updated_at",
    ],
    field_types: {
      slug: "String",
      title: "String",
      body: "String",
      status: "String",
      tags: { Array: "String" },
      created_at: "String",
      updated_at: "String",
    },
    field_descriptions: {
      slug: "stable url-style id",
      title: "one-line name",
      body: "markdown content",
      status: DESIGN_STATUSES.join("|"),
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
      tags: GENERAL,
      created_at: GENERAL,
      updated_at: GENERAL,
    },
  },
  mutation_mappers: {},
};

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
// solely by descriptive_name + purpose_statement. The purpose-statement
// language is the same family used in the design doc.
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

export const RECORD_TYPES = [
  "design",
  "task",
  "concept",
  "preference",
  "reference",
  "agent",
  "project",
  "spike",
] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export type RecordTypeDef = {
  type: RecordType;
  schema: AddSchemaRequest;
  statuses: readonly string[];
  defaultStatus: string;
  hasDesignSlug: boolean;
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
};

// UNIQUE_SCHEMAS lists every schema `fbrain init` must register. Each
// entry binds a config-key (where `init` writes the canonical hash) to
// the AddSchemaRequest. One entry per RecordType — no legacy alias.
export const UNIQUE_SCHEMAS: Array<{
  key: string;
  schema: AddSchemaRequest;
  types: RecordType[];
}> = [
  { key: "design", schema: designSchema, types: ["design"] },
  { key: "task", schema: taskSchema, types: ["task"] },
  { key: "concept", schema: conceptSchema, types: ["concept"] },
  { key: "preference", schema: preferenceSchema, types: ["preference"] },
  { key: "reference", schema: referenceSchema, types: ["reference"] },
  { key: "agent", schema: agentSchema, types: ["agent"] },
  { key: "project", schema: projectSchema, types: ["project"] },
  { key: "spike", schema: spikeSchema, types: ["spike"] },
];

// Resolve an already-published fbrain schema's canonical hash from the set
// the node loaded out of the schema-service catalog (GET /api/schemas). The
// match key is (descriptive_name, owner_app_id) — exactly the two signals the
// schema service folds into a namespaced identity. This is the fresh-consumer
// path: the 8 `fbrain/*` schemas are pre-published org-wide, so init reads
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
// and the top-level CLI help so a brand-new dev can tell which of the 8
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
   beats a perfect note never.

3. **Pick the right type.** Every record has a type; choose the one whose purpose
   matches what you're recording (\`fbrain_put\` requires a type — there is no
   silent default):

   | Type | Use it for |
   |---|---|
${tableRows}

   Link a \`task\` to its parent \`design\` with \`fbrain_link\`. Slugs are per-type, so
   pass \`type\` to \`fbrain_get\`/\`fbrain_delete\` whenever a slug could be ambiguous.`;
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
