// Pin every owned schema to its exact app name. The installer places the
// schemas. Init does not declare, list, or read them.
import { canonicalProfilesForHashes } from "./canonical-vocabulary.ts";
import { BrainError } from "./client.ts";
import type { Config } from "./config.ts";
import { MULTI_KEY_MODEL, ownedSchemas } from "./multi-key.ts";

export function syncOwnedModel(
  base: Omit<Config, "storageModel" | "schemaFieldAliases">,
  existing: Config | null,
): Config {
  const declarations = ownedSchemas();
  if (
    existing &&
    [
      ...Object.keys(existing.schemaHashes),
      ...Object.keys(existing.schemaIdentities ?? {}),
    ].some((key) => !declarations.some((entry) => entry.keys.includes(key)))
  ) {
    throw new BrainError({
      code: "unreviewed_schema_pin",
      message: "The saved config contains an unreviewed schema pin.",
    });
  }
  const schemaHashes = Object.fromEntries(
    declarations.flatMap((entry) =>
      entry.keys.map((key) => [key, `brain/${entry.schema.name}`]),
    ),
  );
  const next: Config = {
    ...existing,
    ...base,
    storageModel: MULTI_KEY_MODEL,
    schemaHashes,
    appIdentityEnforce: false,
    schemaFieldAliases: canonicalProfilesForHashes(schemaHashes),
  };
  delete next.schemaIdentities;
  return next;
}
