// The schema names Brain can pass to `lastseek query --schema`.
//
// `lastSeekScope` passes `uniqueSchemaHashes` for the record types a query
// walks, then drops types that hold no record. This returns every record-type
// pin before that drop, so an index of this list covers every query. Init
// stores each pin as `brain/<Name>` (`brain/Design`, `brain/Task`, and the
// other record types). Search passes those same strings. Internal schemas,
// including the attachment index, are not search scopes and are not included.

import { uniqueSchemaHashes } from "./record.ts";
import { RECORD_TYPES } from "./schemas.ts";

/** The command that registers this list with LastSeek. */
export const BRAIN_INDEX_COMMAND = "brain index";

export function lastSeekSchemaNames(cfg: {
  schemaHashes: Record<string, string>;
}): string[] {
  return uniqueSchemaHashes(cfg, RECORD_TYPES);
}
