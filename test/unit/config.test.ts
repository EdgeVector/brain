import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONFIG_VERSION,
  ConfigInvalidError,
  ConfigMissingError,
  readConfig,
  tryReadConfig,
  writeConfig,
  type Config,
} from "../../src/config.ts";
import { buildTestCfg } from "../util.ts";

function tmpPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "fbrain-config-"));
  return { dir, path: join(dir, "config.json") };
}

const sampleConfig: Config = buildTestCfg();

describe("config", () => {
  test("writeConfig + readConfig round-trips", () => {
    const { dir, path } = tmpPath();
    try {
      writeConfig(sampleConfig, path);
      const got = readConfig(path);
      expect(got).toEqual(sampleConfig);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readConfig throws ConfigMissingError when absent", () => {
    const { dir, path } = tmpPath();
    try {
      expect(() => readConfig(path)).toThrow(ConfigMissingError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tryReadConfig returns null when missing", () => {
    const { dir, path } = tmpPath();
    try {
      expect(tryReadConfig(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("invalid JSON → ConfigInvalidError", () => {
    const { dir, path } = tmpPath();
    try {
      writeFileSync(path, "{not json");
      expect(() => readConfig(path)).toThrow(ConfigInvalidError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing required field → ConfigInvalidError", () => {
    const { dir, path } = tmpPath();
    try {
      const partial = { ...sampleConfig } as Partial<Config>;
      delete partial.schemaHashes;
      writeFileSync(path, JSON.stringify(partial));
      expect(() => readConfig(path)).toThrow(ConfigInvalidError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("configVersion mismatch → ConfigInvalidError", () => {
    const { dir, path } = tmpPath();
    try {
      const bad = { ...sampleConfig, configVersion: 999 };
      writeFileSync(path, JSON.stringify(bad));
      expect(() => readConfig(path)).toThrow(ConfigInvalidError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("v1 config is migrated in-memory to v2", () => {
    const { dir, path } = tmpPath();
    try {
      const v1 = {
        configVersion: 1,
        nodeUrl: "http://127.0.0.1:9101",
        schemaServiceUrl: "http://127.0.0.1:9102",
        userHash: "uh-v1",
        designSchemaHash: "d".repeat(64),
        taskSchemaHash: "t".repeat(64),
      };
      writeFileSync(path, JSON.stringify(v1));
      const got = readConfig(path);
      expect(got.configVersion).toBe(CONFIG_VERSION);
      expect(got.schemaHashes).toEqual({
        design: "d".repeat(64),
        task: "t".repeat(64),
      });
      expect(got.designSchemaHash).toBe("d".repeat(64));
      expect(got.taskSchemaHash).toBe("t".repeat(64));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("v2 config is migrated in-memory to current — URLs preserved verbatim", () => {
    const { dir, path } = tmpPath();
    try {
      // v2 carries schemaHashes + the mirror fields, same shape as current
      // — only configVersion changes. URLs (including the dead local-schema
      // defaults) flow through unchanged; the auto-heal lives in runInit,
      // not readConfig, so reads stay stable for non-init code paths.
      const v2 = {
        configVersion: 2,
        nodeUrl: "http://127.0.0.1:9101",
        schemaServiceUrl: "http://127.0.0.1:9102",
        userHash: "uh-v2",
        schemaHashes: { design: "d".repeat(64), task: "t".repeat(64) },
        designSchemaHash: "d".repeat(64),
        taskSchemaHash: "t".repeat(64),
      };
      writeFileSync(path, JSON.stringify(v2));
      const got = readConfig(path);
      expect(got.configVersion).toBe(CONFIG_VERSION);
      expect(got.nodeUrl).toBe("http://127.0.0.1:9101");
      expect(got.schemaServiceUrl).toBe("http://127.0.0.1:9102");
      expect(got.schemaHashes).toEqual({
        design: "d".repeat(64),
        task: "t".repeat(64),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("v1 missing designSchemaHash → ConfigInvalidError on migration", () => {
    const { dir, path } = tmpPath();
    try {
      const broken = {
        configVersion: 1,
        nodeUrl: "http://127.0.0.1:9101",
        schemaServiceUrl: "http://127.0.0.1:9102",
        userHash: "uh-v1",
        taskSchemaHash: "t".repeat(64),
      };
      writeFileSync(path, JSON.stringify(broken));
      expect(() => readConfig(path)).toThrow(ConfigInvalidError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("v3 → v4: __legacy_note__ schemaHash entry is auto-stripped on read", () => {
    // v3 configs registered FbrainKindNote alongside the per-kind canonicals.
    // v4 drops the legacy schema entirely; the entry is silently removed so
    // a stale v3 config on disk reads cleanly without a forced re-init.
    const { dir, path } = tmpPath();
    try {
      const v3 = {
        configVersion: 3,
        nodeUrl: "http://127.0.0.1:9001",
        schemaServiceUrl: "https://axo709qs11.execute-api.us-east-1.amazonaws.com",
        userHash: "uh-v3",
        schemaHashes: {
          design: "d".repeat(64),
          task: "t".repeat(64),
          concept: "c".repeat(64),
          preference: "f".repeat(64),
          reference: "e".repeat(64),
          agent: "a".repeat(64),
          project: "9".repeat(64),
          spike: "5".repeat(64),
          __legacy_note__: "b".repeat(64),
        },
        designSchemaHash: "d".repeat(64),
        taskSchemaHash: "t".repeat(64),
      };
      writeFileSync(path, JSON.stringify(v3));
      const got = readConfig(path);
      expect(got.configVersion).toBe(CONFIG_VERSION);
      expect(got.schemaHashes.__legacy_note__).toBeUndefined();
      expect(got.schemaHashes.concept).toBe("c".repeat(64));
      // Re-writing the upgraded config persists the stripped shape.
      writeConfig(got, path);
      const raw = JSON.parse(readFileSync(path, "utf8"));
      expect(raw.schemaHashes.__legacy_note__).toBeUndefined();
      expect(raw.configVersion).toBe(CONFIG_VERSION);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writeConfig keeps designSchemaHash/taskSchemaHash mirrored against schemaHashes", () => {
    const { dir, path } = tmpPath();
    try {
      const newDesign = "9".repeat(64);
      const cfg: Config = {
        ...sampleConfig,
        schemaHashes: { ...sampleConfig.schemaHashes, design: newDesign },
      };
      writeConfig(cfg, path);
      const raw = JSON.parse(readFileSync(path, "utf8"));
      expect(raw.designSchemaHash).toBe(newDesign);
      expect(raw.schemaHashes.design).toBe(newDesign);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
