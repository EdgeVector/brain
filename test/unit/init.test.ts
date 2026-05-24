// Auto-heal coverage for `runInit`'s URL resolver. The resolver is the
// load-bearing piece behind G1+G2: anyone whose `~/.fbrain/config.json`
// still carries the dead `:9101 / :9102` local-schema defaults gets their
// URLs rewritten on the next `fbrain init`, while explicit user overrides
// (custom host, custom port) survive untouched.

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_NODE_URL,
  DEFAULT_SCHEMA_SERVICE_URL,
  resolveUrls,
} from "../../src/commands/init.ts";
import { buildTestCfg } from "../util.ts";

describe("resolveUrls", () => {
  test("fresh init (no existing config) → new defaults, no heal notice", () => {
    const r = resolveUrls({}, null);
    expect(r.nodeUrl).toBe(DEFAULT_NODE_URL);
    expect(r.schemaServiceUrl).toBe(DEFAULT_SCHEMA_SERVICE_URL);
    expect(r.healed).toEqual([]);
  });

  test("explicit CLI flags always win, even over an existing healed config", () => {
    const existing = buildTestCfg({
      nodeUrl: "http://127.0.0.1:9101",
      schemaServiceUrl: "http://127.0.0.1:9102",
    });
    const r = resolveUrls(
      { nodeUrl: "http://custom:1234", schemaServiceUrl: "https://custom.example/v1" },
      existing,
    );
    expect(r.nodeUrl).toBe("http://custom:1234");
    expect(r.schemaServiceUrl).toBe("https://custom.example/v1");
    expect(r.healed).toEqual([]);
  });

  test("stale 127.0.0.1:9101 / 9102 → both swapped, both reported", () => {
    const existing = buildTestCfg({
      nodeUrl: "http://127.0.0.1:9101",
      schemaServiceUrl: "http://127.0.0.1:9102",
    });
    const r = resolveUrls({}, existing);
    expect(r.nodeUrl).toBe(DEFAULT_NODE_URL);
    expect(r.schemaServiceUrl).toBe(DEFAULT_SCHEMA_SERVICE_URL);
    expect(r.healed).toHaveLength(2);
    expect(r.healed[0]).toContain("nodeUrl");
    expect(r.healed[1]).toContain("schemaServiceUrl");
  });

  test("stale localhost variants also heal", () => {
    const existing = buildTestCfg({
      nodeUrl: "http://localhost:9101",
      schemaServiceUrl: "http://localhost:9102",
    });
    const r = resolveUrls({}, existing);
    expect(r.nodeUrl).toBe(DEFAULT_NODE_URL);
    expect(r.schemaServiceUrl).toBe(DEFAULT_SCHEMA_SERVICE_URL);
    expect(r.healed).toHaveLength(2);
  });

  test("non-default user override is preserved (no heal)", () => {
    const existing = buildTestCfg({
      nodeUrl: "http://192.168.1.5:9001",
      schemaServiceUrl: "https://my-custom-lambda.example.com",
    });
    const r = resolveUrls({}, existing);
    expect(r.nodeUrl).toBe("http://192.168.1.5:9001");
    expect(r.schemaServiceUrl).toBe("https://my-custom-lambda.example.com");
    expect(r.healed).toEqual([]);
  });

  test("only one side stale → only that side heals", () => {
    const existing = buildTestCfg({
      nodeUrl: "http://127.0.0.1:9101", // stale
      schemaServiceUrl: "https://my-custom-lambda.example.com", // user override
    });
    const r = resolveUrls({}, existing);
    expect(r.nodeUrl).toBe(DEFAULT_NODE_URL);
    expect(r.schemaServiceUrl).toBe("https://my-custom-lambda.example.com");
    expect(r.healed).toHaveLength(1);
    expect(r.healed[0]).toContain("nodeUrl");
  });

  test("config already on new defaults → no heal", () => {
    const existing = buildTestCfg({
      nodeUrl: DEFAULT_NODE_URL,
      schemaServiceUrl: DEFAULT_SCHEMA_SERVICE_URL,
    });
    const r = resolveUrls({}, existing);
    expect(r.nodeUrl).toBe(DEFAULT_NODE_URL);
    expect(r.schemaServiceUrl).toBe(DEFAULT_SCHEMA_SERVICE_URL);
    expect(r.healed).toEqual([]);
  });
});
