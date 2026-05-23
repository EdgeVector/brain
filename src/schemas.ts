// Schema definitions for fbrain's Design and Task records.
//
// These payloads were captured from the Phase 0 spike (see
// docs/spikes/fbrain-phase-0-spike-notes.md in exemem-workspace).
// `POST /v1/schemas` accepts the body below; the response's `schema.name`
// IS THE CANONICAL HASH that every subsequent mutation/query MUST pin to —
// resolving by `descriptive_name` returns `409 ambiguous_schema_name` the
// moment another agent (or `init` re-run with a different field set)
// registers an expansion.

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

export type RecordType = "design" | "task";

export function statusValuesFor(type: RecordType): readonly string[] {
  return type === "design" ? DESIGN_STATUSES : TASK_STATUSES;
}

export function isValidStatus(type: RecordType, status: string): boolean {
  return (statusValuesFor(type) as readonly string[]).includes(status);
}

export function defaultStatusFor(type: RecordType): string {
  return type === "design" ? "draft" : "open";
}

export function schemaFor(type: RecordType): AddSchemaRequest {
  return type === "design" ? designSchema : taskSchema;
}
