// Schema definitions for fbrain's record types.
//
// Three schemas are registered: Design + Task (Phase 1, unchanged) plus
// a single shared `FbrainKindNote` schema (Phase 6) that backs six
// logical record types — Concept, Preference, Reference, Agent, Project,
// Spike — discriminated via a `kind` field.
//
// Why one schema for six types?  We tried six individual schemas with
// uniquely-named fields and varying field counts. The fold_db node
// merges schemas with matching positional shapes during
// /api/schemas/load — when two register calls produce schemas that
// overlap by position, the loader keeps the first-loaded names and
// overwrites the second, leaving the second schema's records
// inaccessible by their declared field names. The shared-schema
// approach sidesteps this by registering ONE schema for all six types;
// the `kind` field tells fbrain which logical type a record is. Slugs
// are unique globally across all Phase 6 types (one schema, one hash
// space) — for the gbrain migration that's fine because gbrain page
// slugs are path-prefixed (`concepts/foo` ≠ `projects/foo`) so they
// stay distinct after the / → - transform.
//
// `POST /v1/schemas` accepts these bodies; the response's `schema.name`
// IS THE CANONICAL HASH that every subsequent mutation/query MUST pin
// to. The descriptive_name is for human-facing display only.

export type FieldType = "String" | { Array: "String" };

export type SchemaDefinition = {
  name: string;
  descriptive_name: string;
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

export const designSchema: AddSchemaRequest = {
  schema: {
    name: "Design",
    descriptive_name: "Design",
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
    descriptive_name: "Task",
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

export const NOTE_SCHEMA_DESCRIPTIVE_NAME = "FbrainKindNote";

// 10 fields — distinct count and shape from Design (7) and Task (8),
// keeping fold's positional merge from grabbing them.
export const noteSchema: AddSchemaRequest = {
  schema: {
    name: NOTE_SCHEMA_DESCRIPTIVE_NAME,
    descriptive_name: NOTE_SCHEMA_DESCRIPTIVE_NAME,
    schema_type: "Hash",
    key: { hash_field: "slug" },
    fields: [
      "slug",
      "kind",
      "title",
      "body",
      "status",
      "tags",
      "created_at",
      "updated_at",
      "v1_marker_a",
      "v1_marker_b",
    ],
    field_types: {
      slug: "String",
      kind: "String",
      title: "String",
      body: "String",
      status: "String",
      tags: { Array: "String" },
      created_at: "String",
      updated_at: "String",
      v1_marker_a: "String",
      v1_marker_b: "String",
    },
    field_descriptions: {
      slug: "stable url-style id (globally unique across all kinds)",
      kind: "record kind: concept | preference | reference | agent | project | spike",
      title: "one-line name",
      body: "markdown content",
      status: "per-kind status enum",
      tags: "array of freeform tags",
      created_at: "RFC 3339 timestamp",
      updated_at: "RFC 3339 timestamp",
      v1_marker_a: "fold structural-distinctness marker (always \"fbrain\")",
      v1_marker_b: "fold structural-distinctness marker (always \"v1\")",
    },
    field_classifications: { title: ["word"], body: ["word"] },
    field_data_classifications: {
      slug: GENERAL,
      kind: GENERAL,
      title: GENERAL,
      body: GENERAL,
      status: GENERAL,
      tags: GENERAL,
      created_at: GENERAL,
      updated_at: GENERAL,
      v1_marker_a: GENERAL,
      v1_marker_b: GENERAL,
    },
  },
  mutation_mappers: {},
};

// Aliases — all six Phase 6 types share noteSchema.
export const conceptSchema = noteSchema;
export const preferenceSchema = noteSchema;
export const referenceSchema = noteSchema;
export const agentSchema = noteSchema;
export const projectSchema = noteSchema;
export const spikeSchema = noteSchema;

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
  // For Phase 6 types: the value written to the schema's `kind` field on
  // create, and the filter applied on list/get. null for Design/Task,
  // which use their own dedicated schemas.
  kind: string | null;
};

export const RECORDS: Record<RecordType, RecordTypeDef> = {
  design: {
    type: "design",
    schema: designSchema,
    statuses: DESIGN_STATUSES,
    defaultStatus: "draft",
    hasDesignSlug: false,
    kind: null,
  },
  task: {
    type: "task",
    schema: taskSchema,
    statuses: TASK_STATUSES,
    defaultStatus: "open",
    hasDesignSlug: true,
    kind: null,
  },
  concept: {
    type: "concept",
    schema: noteSchema,
    statuses: CONCEPT_STATUSES,
    defaultStatus: "active",
    hasDesignSlug: false,
    kind: "concept",
  },
  preference: {
    type: "preference",
    schema: noteSchema,
    statuses: PREFERENCE_STATUSES,
    defaultStatus: "active",
    hasDesignSlug: false,
    kind: "preference",
  },
  reference: {
    type: "reference",
    schema: noteSchema,
    statuses: REFERENCE_STATUSES,
    defaultStatus: "active",
    hasDesignSlug: false,
    kind: "reference",
  },
  agent: {
    type: "agent",
    schema: noteSchema,
    statuses: AGENT_STATUSES,
    defaultStatus: "active",
    hasDesignSlug: false,
    kind: "agent",
  },
  project: {
    type: "project",
    schema: noteSchema,
    statuses: PROJECT_STATUSES,
    defaultStatus: "planning",
    hasDesignSlug: false,
    kind: "project",
  },
  spike: {
    type: "spike",
    schema: noteSchema,
    statuses: SPIKE_STATUSES,
    defaultStatus: "active",
    hasDesignSlug: false,
    kind: "spike",
  },
};

// UNIQUE_SCHEMAS lists the schemas init must register — one per distinct
// canonical hash. Phase 6 types all share noteSchema so it's listed once.
export const UNIQUE_SCHEMAS: Array<{ key: string; schema: AddSchemaRequest; types: RecordType[] }> = [
  { key: "design", schema: designSchema, types: ["design"] },
  { key: "task", schema: taskSchema, types: ["task"] },
  {
    key: "note",
    schema: noteSchema,
    types: ["concept", "preference", "reference", "agent", "project", "spike"],
  },
];

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
