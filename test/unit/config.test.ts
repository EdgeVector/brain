import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function tmpPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "fbrain-config-"));
  return { dir, path: join(dir, "config.json") };
}

const sampleConfig: Config = {
  configVersion: CONFIG_VERSION,
  nodeUrl: "http://127.0.0.1:9101",
  schemaServiceUrl: "http://127.0.0.1:9102",
  userHash: "abcd1234",
  designSchemaHash: "d".repeat(64),
  taskSchemaHash: "t".repeat(64),
};

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
      delete partial.designSchemaHash;
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
});
