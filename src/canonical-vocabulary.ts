/** Standard vocabulary for publication. Local aliases never become canonical fields. */
import vocabulary from "./canonical-fields.json" with { type: "json" };
import { UNIQUE_SCHEMAS, schemaConfigKeys, type SchemaDefinition } from "./schemas.ts";
import type { FieldAliasProfiles } from "./field-alias-transport.ts";

type Definition = { description: string; field_type: unknown; version: number; classification: unknown };
const definitions = vocabulary.fields as Record<string, Definition>;
const bindings = vocabulary.schemas as Record<string, Record<string, string>>;

export function aliasesFor(schema: SchemaDefinition): Record<string, string> {
  const aliases = Object.hasOwn(bindings, schema.descriptive_name) ? bindings[schema.descriptive_name] : undefined;
  if (!aliases || schema.fields.some((field) => !aliases[field])) {
    throw new Error(`No reviewed canonical vocabulary for ${schema.descriptive_name}`);
  }
  if (new Set(Object.values(aliases)).size !== schema.fields.length) {
    throw new Error(`Canonical field aliases must be one-to-one for ${schema.descriptive_name}`);
  }
  return aliases;
}

export function canonicalSchema(schema: SchemaDefinition): SchemaDefinition {
  const aliases = aliasesFor(schema);
  const rename = (name: string) => {
    const [root, ...path] = name.split(".");
    const canonical = root && aliases[root];
    if (!canonical) throw new Error(`No canonical field map for ${schema.descriptive_name}.${name}`);
    return [canonical, ...path].join(".");
  };
  const result = structuredClone(schema) as unknown as Record<string, unknown>;
  result.fields = schema.fields.map(rename);
  result.key = Object.fromEntries(Object.entries(schema.key ?? {}).filter(([,field]) => typeof field === "string").map(([role, field]) => [role, rename(field)]));
  for (const property of ["field_classifications", "field_interest_categories", "ref_fields", "transform_fields"]) {
    const map = result[property];
    if (map && typeof map === "object" && !Array.isArray(map)) {
      result[property] = Object.fromEntries(Object.entries(map).map(([name, value]) => [rename(name), value]));
    }
  }
  const fields = schema.fields.map((alias) => {
    const name = rename(alias);
    const field = definitions[name];
    if (!field) throw new Error(`Missing canonical definition ${name}`);
    return { name, field };
  });
  result.field_types = Object.fromEntries(fields.map(({name, field}) => [name, field.field_type]));
  result.field_descriptions = Object.fromEntries(fields.map(({name, field}) => [name, field.description]));
  result.field_versions = Object.fromEntries(fields.map(({name, field}) => [name, field.version]));
  result.field_data_classifications = Object.fromEntries(fields.map(({name, field}) => [name, field.classification]));
  // A renamed definition receives new identities. Never reuse old identities.
  delete result.identity_hash;
  delete result.field_hashes;
  delete result.field_molecule_uuids;
  return result as unknown as SchemaDefinition;
}

export function profilesFor(schema: SchemaDefinition, ids: string[]): FieldAliasProfiles {
  const aliases = aliasesFor(schema);
  return Object.fromEntries(ids.filter(Boolean).map((id) => [id, aliases]));
}

export function canonicalProfilesForHashes(hashes: Record<string,string>): FieldAliasProfiles {
  const profiles: FieldAliasProfiles = {};
  for (const entry of UNIQUE_SCHEMAS) {
    const aliases = aliasesFor(entry.schema.schema);
    for (const key of schemaConfigKeys(entry)) {
      const hash = hashes[key];
      if (!hash) continue;
      const existing = profiles[hash];
      if (existing && JSON.stringify(existing) !== JSON.stringify(aliases)) {
        throw new Error(`Canonical schema ${hash} requires incompatible local field aliases`);
      }
      profiles[hash] = aliases;
    }
    const schema = entry.schema.schema;
    const name = schema.name.includes("/") ? schema.name : `${schema.owner_app_id}/${schema.name}`;
    profiles[name] = aliases;
  }
  return profiles;
}
