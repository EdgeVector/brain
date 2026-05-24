// Persistent CLI config — `~/.fbrain/config.json` by default.
// Holds the canonical schema hashes (NOT the descriptive_names), per the
// Phase 0 spike finding.
//
// v2 (Phase 6): `schemaHashes` map carries one canonical hash per record
// type. `designSchemaHash` and `taskSchemaHash` are mirrored on disk for
// backward compat with v1 readers. v1 configs are migrated in-memory on
// read; the next `fbrain init` persists v2 to disk.
//
// v3 (this commit): same shape as v2; the version bump signals that the
// default schema-service URL moved from the local `:9102` to the cloud
// Lambda. `runInit` auto-heals v1/v2 configs with the dead local default
// URLs on the next `fbrain init` (preserving any user override).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CONFIG_VERSION = 3;

export type Config = {
  configVersion: number;
  nodeUrl: string;
  schemaServiceUrl: string;
  userHash: string;
  schemaHashes: Record<string, string>;
  // Mirror of schemaHashes.design / schemaHashes.task — present on disk
  // for backward compat with v1 readers. Always kept in sync on write.
  designSchemaHash: string;
  taskSchemaHash: string;
};

export function defaultConfigPath(): string {
  const override = process.env.FBRAIN_CONFIG;
  if (override && override.length > 0) return override;
  return join(homedir(), ".fbrain", "config.json");
}

export class ConfigMissingError extends Error {
  constructor(path: string) {
    super(`Config not found at ${path}. Run \`fbrain init\` first.`);
    this.name = "ConfigMissingError";
  }
}

export class ConfigInvalidError extends Error {
  constructor(path: string, reason: string) {
    super(`Config at ${path} is invalid: ${reason}. Re-run \`fbrain init\`.`);
    this.name = "ConfigInvalidError";
  }
}

export function readConfig(path: string = defaultConfigPath()): Config {
  if (!existsSync(path)) throw new ConfigMissingError(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigInvalidError(path, `not valid JSON (${msg})`);
  }
  return assertConfigShape(path, parsed);
}

export function tryReadConfig(path: string = defaultConfigPath()): Config | null {
  if (!existsSync(path)) return null;
  return readConfig(path);
}

export function writeConfig(
  config: Config,
  path: string = defaultConfigPath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  const synced = syncMirrors(config);
  writeFileSync(path, JSON.stringify(synced, null, 2) + "\n", "utf8");
}

// Keep designSchemaHash/taskSchemaHash mirrored against schemaHashes
// so v1 readers continue to see the legacy fields populated.
function syncMirrors(config: Config): Config {
  return {
    ...config,
    designSchemaHash:
      config.schemaHashes.design ?? config.designSchemaHash ?? "",
    taskSchemaHash:
      config.schemaHashes.task ?? config.taskSchemaHash ?? "",
  };
}

function assertConfigShape(path: string, raw: unknown): Config {
  if (typeof raw !== "object" || raw === null) {
    throw new ConfigInvalidError(path, "not an object");
  }
  const r = raw as Record<string, unknown>;

  for (const key of ["nodeUrl", "schemaServiceUrl", "userHash"] as const) {
    if (!(key in r)) {
      throw new ConfigInvalidError(path, `missing field "${key}"`);
    }
    if (typeof r[key] !== "string" || (r[key] as string).length === 0) {
      throw new ConfigInvalidError(path, `field "${key}" not a non-empty string`);
    }
  }

  const version = r.configVersion;
  if (version === 1) {
    // v1 → current: derive schemaHashes from legacy fields, then bump.
    for (const key of ["designSchemaHash", "taskSchemaHash"] as const) {
      if (typeof r[key] !== "string" || (r[key] as string).length === 0) {
        throw new ConfigInvalidError(path, `field "${key}" not a non-empty string`);
      }
    }
    return {
      configVersion: CONFIG_VERSION,
      nodeUrl: r.nodeUrl as string,
      schemaServiceUrl: r.schemaServiceUrl as string,
      userHash: r.userHash as string,
      schemaHashes: {
        design: r.designSchemaHash as string,
        task: r.taskSchemaHash as string,
      },
      designSchemaHash: r.designSchemaHash as string,
      taskSchemaHash: r.taskSchemaHash as string,
    };
  }

  // v2 → v3 is shape-compatible: same fields, same types. We just bump the
  // in-memory version so the rest of the validator runs the unified path.
  // The URL auto-heal lives in runInit so user overrides survive.
  if (version === 2 || version === CONFIG_VERSION) {
    // fall through to the shared validation + return below
  } else {
    throw new ConfigInvalidError(
      path,
      `configVersion ${String(version)} != ${CONFIG_VERSION}`,
    );
  }

  if (!("schemaHashes" in r)) {
    throw new ConfigInvalidError(path, `missing field "schemaHashes"`);
  }
  const rawHashes = r.schemaHashes;
  if (typeof rawHashes !== "object" || rawHashes === null || Array.isArray(rawHashes)) {
    throw new ConfigInvalidError(path, `field "schemaHashes" must be an object`);
  }
  const schemaHashes: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawHashes as Record<string, unknown>)) {
    if (typeof v !== "string" || v.length === 0) {
      throw new ConfigInvalidError(path, `schemaHashes["${k}"] is not a non-empty string`);
    }
    schemaHashes[k] = v;
  }

  // The two legacy mirror fields must be present (we always write them).
  for (const key of ["designSchemaHash", "taskSchemaHash"] as const) {
    if (typeof r[key] !== "string" || (r[key] as string).length === 0) {
      throw new ConfigInvalidError(path, `field "${key}" not a non-empty string`);
    }
  }

  return {
    configVersion: CONFIG_VERSION,
    nodeUrl: r.nodeUrl as string,
    schemaServiceUrl: r.schemaServiceUrl as string,
    userHash: r.userHash as string,
    schemaHashes,
    designSchemaHash: r.designSchemaHash as string,
    taskSchemaHash: r.taskSchemaHash as string,
  };
}
