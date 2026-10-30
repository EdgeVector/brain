import { profilesFor } from "./canonical-vocabulary.ts";
import { FbrainError, type NodeClient } from "./client.ts";
import type { Config } from "./config.ts";
import { MULTI_KEY_MODEL, ownedSchemas } from "./multi-key.ts";
import { OWNER_APP_ID } from "./schemas.ts";

export async function syncOwnedModel(node: NodeClient, base: Config, existing: Config | null, canonicalVocabulary: boolean): Promise<Config> {
  const version = await node.rawCall("GET", "/api/version");
  const capabilities = (version.json as { capabilities?: Record<string, boolean> })?.capabilities;
  if (version.status !== 200 || !capabilities?.compound_alternate_keys_v1 || !capabilities.independent_hash_range_v1) {
    throw new FbrainError({ code: "multi_key_upgrade_required", message: "This node needs compound alternate keys and independent HashRange schemas." });
  }
  const response = await node.rawCall("GET", "/api/schemas");
  const root = response.json as { data?: unknown };
  const catalog = (root?.data ?? root) as { schemas?: Array<{ owner_app_id?: string; descriptive_name?:string; independent_fields?: boolean }> };
  if (response.status !== 200 || !Array.isArray(catalog?.schemas)) {
    throw new FbrainError({ code: "schema_directory_unavailable", message: "The schema directory is not available." });
  }
  const declarations = ownedSchemas();
  const names=new Set(declarations.map((entry)=>entry.schema.descriptive_name));
  if (catalog.schemas.some((schema) => schema.owner_app_id === OWNER_APP_ID && names.has(schema.descriptive_name ?? "") && !schema.independent_fields)) {
    throw new FbrainError({ code: "multi_key_conversion_required", message: "Existing Brain values need the explicit multi-key conversion. Init leaves them unchanged." });
  }
  if (!node.declareAppSchema) throw new FbrainError({ code: "schema_declare_unavailable", message: "The client cannot declare owned schemas." });
  const resolved = await Promise.all(declarations.map(async (entry) => {
    const declaration = await node.declareAppSchema!(OWNER_APP_ID, entry.schema);
    if (!declaration.independentFields || !declaration.identityHash || !/^[a-f0-9]{64}$/.test(declaration.identityHash)) {
      throw new FbrainError({ code: "owned_schema_receipt_invalid", message: "The declaration did not confirm independent values and a definition identity." });
    }
    return { ...entry, runtime: declaration.canonical, identity: declaration.identityHash };
  }));
  const schemaHashes = Object.fromEntries(resolved.flatMap((entry) => entry.keys.map((key) => [key, entry.identity])));
  if (existing && Object.entries(schemaHashes).some(([key, value]) => existing.schemaHashes[key] !== value)) {
    throw new FbrainError({ code: "schema_pin_changed", message: "An owned schema address changed. The config remains unchanged." });
  }
  return { ...existing, ...base, storageModel: MULTI_KEY_MODEL, schemaHashes,
    designSchemaHash: schemaHashes.design!, taskSchemaHash: schemaHashes.task!, appIdentityEnforce: existing?.appIdentityEnforce ?? false,
    schemaFieldAliases: canonicalVocabulary ? Object.assign({}, ...resolved.map((entry) => profilesFor(entry.schema, [entry.identity, entry.runtime]))) : undefined,
  };
}
