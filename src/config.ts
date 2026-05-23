// Persistent CLI config — `~/.fbrain/config.json` by default.
// Holds the canonical schema hashes (NOT the descriptive_names), per the
// Phase 0 spike finding.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CONFIG_VERSION = 1;

export type Config = {
  configVersion: number;
  nodeUrl: string;
  schemaServiceUrl: string;
  userHash: string;
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
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function assertConfigShape(path: string, raw: unknown): Config {
  if (typeof raw !== "object" || raw === null) {
    throw new ConfigInvalidError(path, "not an object");
  }
  const r = raw as Record<string, unknown>;
  const required: (keyof Config)[] = [
    "configVersion",
    "nodeUrl",
    "schemaServiceUrl",
    "userHash",
    "designSchemaHash",
    "taskSchemaHash",
  ];
  for (const key of required) {
    if (!(key in r)) {
      throw new ConfigInvalidError(path, `missing field "${key}"`);
    }
  }
  if (r.configVersion !== CONFIG_VERSION) {
    throw new ConfigInvalidError(
      path,
      `configVersion ${String(r.configVersion)} != ${CONFIG_VERSION}`,
    );
  }
  for (const key of [
    "nodeUrl",
    "schemaServiceUrl",
    "userHash",
    "designSchemaHash",
    "taskSchemaHash",
  ] as const) {
    if (typeof r[key] !== "string" || (r[key] as string).length === 0) {
      throw new ConfigInvalidError(path, `field "${key}" not a non-empty string`);
    }
  }
  return {
    configVersion: CONFIG_VERSION,
    nodeUrl: r.nodeUrl as string,
    schemaServiceUrl: r.schemaServiceUrl as string,
    userHash: r.userHash as string,
    designSchemaHash: r.designSchemaHash as string,
    taskSchemaHash: r.taskSchemaHash as string,
  };
}
