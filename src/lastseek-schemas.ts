// The schema names Brain passes to LastSeek.
//
// `lastseek index --schema` and `lastseek search --schema` must see the same
// strings. Init stores each pin as `brain/<Name>` (`brain/Design`,
// `brain/Task`, and the other record types). Search passes those strings,
// or a subset when the caller names `--type`. Internal schemas, including
// the attachment index, are not search scopes and are not included.

import { uniqueSchemaHashes } from "./record.ts";
import { RECORD_TYPES } from "./schemas.ts";

/** The command that names this list to LastSeek. */
export const BRAIN_INDEX_COMMAND = "brain index";

/** LastSeek addresses the index by app name. Brain never names the directory. */
export const LASTSEEK_APP_NAME = "brain";

export function lastSeekSchemaNames(cfg: {
  schemaHashes: Record<string, string>;
}): string[] {
  return uniqueSchemaHashes(cfg, RECORD_TYPES);
}
