import { profilesFor } from "./canonical-vocabulary.ts";
import { BrainError, type NodeClient } from "./client.ts";
import type { Config } from "./config.ts";
import { MULTI_KEY_MODEL, ownedSchemas } from "./multi-key.ts";
import { ownsValues } from "./runtime.ts";
import { OWNER_APP_ID } from "./schemas.ts";

/** One installed schema, as the node's schema directory reports it. */
type Metadata = {
  name: string;
  identity_hash: string;
  owner_app_id: string;
  descriptive_name: string;
  schema_type: string;
  fields: string[];
  key: Record<string, string>;
  field_types: Record<string, unknown>;
  field_descriptions: Record<string, string>;
  independent_fields?: boolean;
  alternate_keys?: unknown;
};

export async function syncOwnedModel(
  node: NodeClient,
  base: Config,
  existing: Config | null,
  canonicalVocabulary: boolean,
): Promise<Config> {
  const version = await node.rawCall("GET", "/api/version");
  const versionReply = version.json as {
    capabilities?: Record<string, boolean>;
    api_version?: unknown;
  };
  const capabilities = versionReply?.capabilities;
  const apiVersion =
    typeof versionReply?.api_version === "number" ? versionReply.api_version : 0;
  if (
    version.status !== 200 ||
    !capabilities?.compound_alternate_keys_v1 ||
    !capabilities.independent_hash_range_v1
  ) {
    throw new BrainError({
      code: "multi_key_upgrade_required",
      message:
        "This node needs compound alternate keys and independent HashRange schemas.",
    });
  }
  const response = await node.rawCall("GET", "/api/schemas");
  const root = response.json as { data?: unknown };
  const catalog = (root?.data ?? root) as {
    ready?: boolean;
    schemas?: Metadata[];
  };
  if (
    response.status !== 200 ||
    catalog.ready !== true ||
    !Array.isArray(catalog.schemas)
  ) {
    throw new BrainError({
      code: "schema_directory_unavailable",
      message: "The schema directory is not available.",
    });
  }
  const declarations = ownedSchemas();
  if (
    declarations.some((entry) => entry.opaqueHash) &&
    !capabilities.app_schema_opaque_hash_ownership_v1
  )
    throw new BrainError({
      code: "opaque_hash_upgrade_required",
      message:
        "The compact locator needs app_schema_opaque_hash_ownership_v1 before owned setup.",
    });
  const known = declarations;
  const installed = catalog.schemas.filter(
    (schema) => schema.owner_app_id === OWNER_APP_ID,
  );
  if (
    installed.some(
      (schema) =>
        !known.some(
          (entry) => entry.schema.descriptive_name === schema.descriptive_name,
        ),
    )
  )
    throw new BrainError({
      code: "unreviewed_app_schema",
      message:
        "This home contains an unreviewed Brain schema. Init leaves it unchanged.",
    });
  if (
    new Set(installed.map((schema) => schema.descriptive_name)).size !==
    installed.length
  )
    throw new BrainError({
      code: "ambiguous_app_schema",
      message:
        "Several installed schemas claim one app record type. Init leaves them unchanged.",
    });
  if (
    installed.some((schema) => !ownsValues(schema.independent_fields, apiVersion))
  ) {
    throw new BrainError({
      code: "home_copy_required",
      message:
        "This home holds Brain values in the old shared-value layout. Init leaves them unchanged.",
      hint: "Move Brain data to a new home with the home copy. See docs/multi-key-schemas.md.",
    });
  }
  if (
    existing &&
    [
      ...Object.keys(existing.schemaHashes),
      ...Object.keys(existing.schemaIdentities ?? {}),
    ].some((key) => !known.some((entry) => entry.keys.includes(key)))
  )
    throw new BrainError({
      code: "unreviewed_schema_pin",
      message: "The saved config contains an unreviewed schema pin.",
    });
  if (!node.declareAppSchema)
    throw new BrainError({
      code: "schema_declare_unavailable",
      message: "The client cannot declare owned schemas.",
    });
  const resolved = await Promise.all(
    declarations.map(async (entry) => {
      const declaration = await node.declareAppSchema!(
        OWNER_APP_ID,
        entry.schema,
      );
      if (
        !declaration.independentFields ||
        !declaration.identityHash ||
        !/^[a-f0-9]{64}$/.test(declaration.identityHash) ||
        declaration.app_id !== OWNER_APP_ID ||
        declaration.schema !== OWNER_APP_ID + "/" + entry.schema.name ||
        !declaration.canonical
      ) {
        throw new BrainError({
          code: "owned_schema_receipt_invalid",
          message:
            "The declaration did not confirm independent values and a definition identity.",
        });
      }
      return {
        ...entry,
        runtime: declaration.canonical,
        identity: declaration.identityHash,
      };
    }),
  );
  const all = resolved;
  const schemaHashes = Object.fromEntries(
    all.flatMap((entry) => entry.keys.map((key) => [key, entry.runtime])),
  );
  const schemaIdentities = Object.fromEntries(
    all.flatMap((entry) => entry.keys.map((key) => [key, entry.identity])),
  );
  if (
    existing &&
    resolved.some((entry) =>
      entry.keys.some(
        (key) =>
          (existing.schemaHashes[key] &&
            existing.schemaHashes[key] !== entry.identity &&
            existing.schemaHashes[key] !== entry.runtime) ||
          (existing.schemaIdentities?.[key] &&
            existing.schemaIdentities[key] !== entry.identity),
      ),
    )
  ) {
    throw new BrainError({
      code: "schema_pin_changed",
      message: "An owned schema address changed. The config remains unchanged.",
    });
  }
  return {
    ...existing,
    ...base,
    storageModel: MULTI_KEY_MODEL,
    schemaHashes,
    schemaIdentities,
    designSchemaHash: schemaHashes.design!,
    taskSchemaHash: schemaHashes.task!,
    appIdentityEnforce: existing?.appIdentityEnforce ?? false,
    schemaFieldAliases: canonicalVocabulary
      ? Object.assign(
          {},
          existing?.schemaFieldAliases,
          ...all.map((entry) =>
            profilesFor(entry.schema, [
              entry.identity,
              entry.runtime,
              OWNER_APP_ID + "/" + entry.schema.name,
            ]),
          ),
        )
      : existing?.schemaFieldAliases,
  };
}
