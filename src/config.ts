import { writeConfigFile } from "./config-file.ts";
import { parseFieldAliases, type FieldAliasProfiles } from "./field-alias-transport.ts";
// Persistent CLI config — `~/.brain/config.json` by default.
// Holds the canonical schema hashes (NOT the descriptive_names), per the
// Phase 0 spike finding.
//
// v2 (Phase 6): `schemaHashes` map carries one canonical hash per record
// type. `designSchemaHash` and `taskSchemaHash` are mirrored on disk for
// backward compat with v1 readers. v1 configs are migrated in-memory on
// read; the next `brain init` persists v2 to disk.
//
// v3 (Phase D): same shape as v2; the version bump signals that the
// default schema-service URL moved from the local `:9102` to the cloud
// Lambda. `runInit` auto-heals v1/v2 configs with the dead local default
// URLs on the next `brain init` (preserving any user override).
//
// v4 (this commit): legacy BrainKindNote cleanup. The legacy schema and
// its `__legacy_note__` schemaHashes entry are gone. Any v3 config that
// still carries that entry is auto-healed on read by stripping the entry
// — the cleanup is purely shape, not data (consolidation already moved
// every legacy row into the per-kind canonicals).

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { BrainError } from "./client.ts";
// The guarded home resolver + its error live in client.ts (the lowest layer,
// alongside BrainError) so client.ts's `resolveNodeHome` can share the SAME
// guard with no import cycle. Re-exported here so the rest of the codebase
// imports them from `./config.ts` (the conventional home for path resolution).
export { brainHomeBase, validateHomeBase, HomeUnresolvedError } from "./client.ts";
import { brainHomeBase } from "./client.ts";

export const CONFIG_VERSION = 4;

// Legacy BrainKindNote schema-key (pre-v4). Defined here, not in
// schemas.ts, so the config migration can detect + strip it without
// keeping the legacy schema definition alive. Any v3 config that carried
// this key in `schemaHashes` is auto-healed on read (the entry is
// dropped). Records were already moved to per-kind schemas by the
// consolidation migration (PR #63) before this cleanup landed.
const LEGACY_NOTE_SCHEMA_KEY_V3 = "__legacy_note__";

export type Config = {
  storageModel?: "multi-key-v1";
  configVersion: number;
  nodeUrl: string;
  schemaServiceUrl: string;
  userHash: string;
  schemaHashes: Record<string, string>;
  /** Definition identities are separate from runtime addresses. */
  schemaIdentities?: Record<string, string>;
  schemaFieldAliases?: FieldAliasProfiles;
  // Mirror of schemaHashes.design / schemaHashes.task — present on disk
  // for backward compat with v1 readers. Always kept in sync on write.
  designSchemaHash: string;
  taskSchemaHash: string;
  // Optional override for the node's UDS control-socket path, used for
  // owner-session attestation (the app-isolation flip, fold#739). Unset →
  // `<node-home>/data/folddb.sock`, where `<node-home>` resolves to `~/.lastdb`
  // on a current v0.15.1+ node (the FoldDB→LastDB rebrand) or `~/.folddb` on a
  // legacy 0.14.x node — see `resolveNodeHome` in client.ts. Set this (or the
  // `BRAIN_FOLDDB_SOCKET` env) when pointing brain at a node whose data dir
  // is elsewhere (an ephemeral test node). Omitted from disk when unset —
  // backward-compatible with every existing config.
  nodeSocketPath?: string;
  /**
   * When false, the client skips capability acquisition (same effect as
   * `BRAIN_APP_IDENTITY_ENFORCE=off`). Legacy configs may contain false from
   * the retired unregistered-schema bootstrap. New initialization must use
   * Schema Service-registered identities and must not treat this flag as a
   * local-schema option. Omitted when unset → default enforce-on.
   */
  appIdentityEnforce?: boolean;
};

export function brainDataDir(): string {
  return join(brainHomeBase(), ".brain");
}

export function defaultConfigPath(): string {
  const override = process.env.BRAIN_CONFIG;
  if (override && override.length > 0) return override;
  // The BRAIN_CONFIG override (above) wins even with a broken HOME, so a pinned
  // config path still works. Otherwise derive from the guarded home base, which
  // fails loud rather than writing a relative `undefined/.brain/config.json`.
  return join(brainDataDir(), "config.json");
}

// The two first-touch config errors a brand-new developer hits when running
// any verb before `brain init`. They extend BrainError so they carry a
// stable `code` and a structured `hint` (the recovery action), exactly like
// every operational error (node-down, capability, write-timeout). The
// message states only the *condition*; the recovery lives in `hint` so the
// two don't duplicate, and `--json` / the human `hint:` line both surface it.
// Their codes are NOT in USAGE_ERROR_CODES, so they stay exit 1 (operational).
export class ConfigMissingError extends BrainError {
  constructor(path: string) {
    super({
      code: "config_missing",
      message: `Config not found at ${path}.`,
      hint: "Run `brain init` to create it.",
    });
    this.name = "ConfigMissingError";
  }
}

export class ConfigInvalidError extends BrainError {
  constructor(path: string, reason: string) {
    super({
      code: "config_invalid",
      message: `Config at ${path} is invalid: ${reason}.`,
      hint: "Re-run `brain init` to regenerate it (or edit the file).",
    });
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
  expected?: string | null,
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeConfigFile(path, configBytes(config), expected);
}

export function configBytes(config: Config): string {
  const ordered = (value: unknown): unknown => Array.isArray(value)
    ? value.map(ordered)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, ordered(item)]))
      : value;
  return JSON.stringify(ordered(syncMirrors(config)), null, 2) + "\n";
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
  if (r.storageModel !== undefined && r.storageModel !== "multi-key-v1") {
    throw new ConfigInvalidError(path, "unsupported storageModel");
  }

  for (const key of ["nodeUrl", "schemaServiceUrl", "userHash"] as const) {
    if (!(key in r)) {
      throw new ConfigInvalidError(path, `missing field "${key}"`);
    }
    if (typeof r[key] !== "string" || (r[key] as string).length === 0) {
      throw new ConfigInvalidError(path, `field "${key}" not a non-empty string`);
    }
  }

  const version = r.configVersion;
  if (version !== 1 && version !== 2 && version !== 3 && version !== CONFIG_VERSION) {
    throw new ConfigInvalidError(
      path,
      `configVersion ${String(version)} != ${CONFIG_VERSION}`,
    );
  }

  // The two legacy mirror fields must be present on every supported
  // version. For v1 they additionally seed schemaHashes; for v2+ they
  // exist as a redundant on-disk mirror that v1 readers still consult.
  // The URL auto-heal (v2→v3) lives in runInit so user overrides
  // survive; the v3→v4 legacy-key strip happens in the schemaHashes
  // loop below.
  for (const key of ["designSchemaHash", "taskSchemaHash"] as const) {
    if (typeof r[key] !== "string" || (r[key] as string).length === 0) {
      throw new ConfigInvalidError(path, `field "${key}" not a non-empty string`);
    }
  }

  // v1 → current: synthesize schemaHashes from the legacy mirror fields
  // so the shared validation + return below runs unmodified for v1.
  if (version === 1) {
    r.schemaHashes = {
      design: r.designSchemaHash as string,
      task: r.taskSchemaHash as string,
    };
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
    // v3 → v4: drop the now-defunct legacy BrainKindNote entry. Records
    // were migrated into per-kind canonicals by `brain consolidate`
    // before this cleanup landed; keeping the key would route reads at
    // an unregistered hash.
    if (k === LEGACY_NOTE_SCHEMA_KEY_V3) continue;
    schemaHashes[k] = v;
  }

  const config: Config = {
    ...(r.storageModel === "multi-key-v1" ? { storageModel: "multi-key-v1" as const } : {}),
    configVersion: CONFIG_VERSION,
    nodeUrl: r.nodeUrl as string,
    schemaServiceUrl: r.schemaServiceUrl as string,
    userHash: r.userHash as string,
    schemaHashes,
    designSchemaHash: r.designSchemaHash as string,
    taskSchemaHash: r.taskSchemaHash as string,
  };
  const identities = r.schemaIdentities;
  if (identities !== undefined) {
    if (!identities || typeof identities !== "object" || Array.isArray(identities)
      || Object.values(identities).some((value) => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) {
      throw new ConfigInvalidError(path, "schemaIdentities must contain exact definition identities");
    }
    config.schemaIdentities = { ...identities } as Record<string, string>;
  }
  // Optional owner-session socket override — only carried when present and a
  // non-empty string, so existing configs (which never wrote it) round-trip
  // unchanged.
  if (typeof r.nodeSocketPath === "string" && r.nodeSocketPath.length > 0) {
    config.nodeSocketPath = r.nodeSocketPath;
  }
  if (typeof r.appIdentityEnforce === "boolean") {
    config.appIdentityEnforce = r.appIdentityEnforce;
  }
  const aliases = parseFieldAliases(r.schemaFieldAliases);
  if (aliases) config.schemaFieldAliases = aliases;
  return config;
}
