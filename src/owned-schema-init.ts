import { profilesFor } from "./canonical-vocabulary.ts";
import { FbrainError, type NodeClient } from "./client.ts";
import type { Config } from "./config.ts";
import { MULTI_KEY_MODEL, ownedSchemas } from "./multi-key.ts";
import { OWNER_APP_ID } from "./schemas.ts";
import { type Metadata } from "./schema-conversion.ts";

export async function syncOwnedModel(
  node: NodeClient,
  base: Config,
  existing: Config | null,
  canonicalVocabulary: boolean,
): Promise<Config> {
  const version = await node.rawCall("GET", "/api/version");
  const capabilities = (
    version.json as { capabilities?: Record<string, boolean> }
  )?.capabilities;
  if (
    version.status !== 200 ||
    !capabilities?.compound_alternate_keys_v1 ||
    !capabilities.independent_hash_range_v1
  ) {
    throw new FbrainError({
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
    throw new FbrainError({
      code: "schema_directory_unavailable",
      message: "The schema directory is not available.",
    });
  }
  const declarations = ownedSchemas();
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
    throw new FbrainError({
      code: "unreviewed_app_schema",
      message:
        "This home contains an unreviewed Brain schema. Init leaves it unchanged.",
    });
  if (
    new Set(installed.map((schema) => schema.descriptive_name)).size !==
    installed.length
  )
    throw new FbrainError({
      code: "ambiguous_app_schema",
      message:
        "Several installed schemas claim one app record type. Init leaves them unchanged.",
    });
  if (installed.some((schema) => schema.independent_fields !== true)) {
    throw new FbrainError({
      code: "multi_key_conversion_required",
      message:
        "Existing Brain values need the explicit multi-key conversion. Init leaves them unchanged.",
    });
  }
  if (
    existing &&
    [
      ...Object.keys(existing.schemaHashes),
      ...Object.keys(existing.schemaIdentities ?? {}),
    ].some((key) => !known.some((entry) => entry.keys.includes(key)))
  )
    throw new FbrainError({
      code: "unreviewed_schema_pin",
      message: "The saved config contains an unreviewed schema pin.",
    });
  if (!node.declareAppSchema)
    throw new FbrainError({
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
        throw new FbrainError({
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
    throw new FbrainError({
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
