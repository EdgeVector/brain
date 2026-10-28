// Opt-in storage spike. These schemas never join normal Brain initialization.
import type { SchemaDefinition } from "../schemas.ts";

const descriptions: Record<string, string> = {
  br2_id: "Brain v2 typed record identity, version 1",
  br2_type: "Brain v2 public record type",
  br2_scope: "Brain v2 recent-record scope",
  br2_status: "Brain v2 typed status scope",
  br2_order: "Brain v2 reverse update time and typed identity digest",
  br2_revision: "Brain v2 compare-and-set record revision",
};

function definition(name: string, fields: string[], hash: string, range?: string): SchemaDefinition {
  return {
    name, descriptive_name: name, owner_app_id: "fbrain",
    purpose_statement: "Experimental Brain v2 storage layout; explicit opt-in only",
    schema_type: range ? "HashRange" : "Hash",
    key: { hash_field: hash, ...(range ? { range_field: range } : {}) },
    fields,
    field_types: Object.fromEntries(fields.map(field => [field, field === "tags" ? { Array: "String" } : "String"])),
    field_descriptions: Object.fromEntries(fields.map(field => [field, descriptions[field] ?? `Brain v2 record ${field}`])),
    field_classifications: Object.fromEntries(fields.map(field => [field,
      name === "BrainV2Record" && (field === "title" || field === "body") ? ["word"] : ["no_index", "metadata"]])),
    field_data_classifications: Object.fromEntries(fields.map(field => [field, { sensitivity_level: 0, data_domain: "general" }])),
  };
}

export const V2_RECORD_FIELDS = [
  "br2_id", "br2_type", "br2_scope", "br2_status", "br2_order", "br2_revision",
  "slug", "title", "body", "status", "tags", "created_at", "updated_at",
  "design_slug", "program", "gate_slug", "decided_by", "decided_on",
];
export const V2_SUMMARY_FIELDS = ["br2_id", "br2_type", "slug", "title", "status", "tags", "updated_at"];
export const V2_SCHEMAS = {
  record: definition("BrainV2Record", V2_RECORD_FIELDS, "br2_id"),
  recent: definition("BrainV2Recent", ["br2_scope", "br2_order", "br2_id"], "br2_scope", "br2_order"),
  type: definition("BrainV2ByType", ["br2_type", "br2_order", "br2_id"], "br2_type", "br2_order"),
  status: definition("BrainV2ByStatus", ["br2_status", "br2_order", "br2_id"], "br2_status", "br2_order"),
  // A tag membership is a different product. Distinct field identities prevent
  // automatic scalar coherence from treating an array as one tag coordinate.
  tag: definition("BrainV2TagMember", ["bt2_tag", "bt2_order", "bt2_id"], "bt2_tag", "bt2_order"),
};
export type V2SchemaMap = Record<keyof typeof V2_SCHEMAS, string>;
