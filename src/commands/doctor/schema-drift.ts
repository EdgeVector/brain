import type { Config } from "../../config.ts";
import { OWNER_APP_ID, RECORD_TYPES, UNIQUE_SCHEMAS, type RecordType } from "../../schemas.ts";

export function validateConfigShape(cfg: Config): string[] {
  const issues: string[] = [];
  for (const type of RECORD_TYPES as readonly RecordType[]) {
    const h = cfg.schemaHashes[type];
    if (!h || h.length === 0) {
      issues.push(`schemaHashes["${type}"] is missing`);
      continue;
    }
    const schema = UNIQUE_SCHEMAS.find((entry) => entry.key === type);
    const runtimeName = schema ? `${OWNER_APP_ID}/${schema.schema.schema.name}` : "";
    if (!/^[0-9a-f]{64}$/i.test(h) && h !== runtimeName) {
      issues.push(`schemaHashes["${type}"] is neither a definition hash nor its owned schema name`);
    }
  }
  return issues;
}
