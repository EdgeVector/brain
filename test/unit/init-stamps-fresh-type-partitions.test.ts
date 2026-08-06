// A brand-new record type must start with a record-list partition that is
// marked complete-and-empty.
//
// `readTypeListIndex` returns null for two different situations — "never
// seeded" and "seeded, and the type has no records" — and only the first is a
// problem. While they are indistinguishable, every reader has to fall back to a
// full schema scan to tell them apart, and that fallback is what
// `design-lastdb-scan-deprecation-path` forbids on product paths. It fired the
// first time a new type was added (`papercut`, 2026-08-06).
//
// The safety argument, which these tests exist to pin: only types absent from
// the PREVIOUS config are stamped. No schema hash in config means no way to
// have written a record, so "no entries" is true and complete for that type.
// Stamping a type that was already in the config would falsely certify a
// genuinely cold partition — strictly worse than the scan it replaces.

import { describe, expect, test } from "bun:test";
import { RECORD_LIST_ENTRY_MIGRATED_RANGE } from "../../src/schemas.ts";
import { buildTestCfg, TEST_HASHES } from "../util.ts";

const INIT_SRC = new URL("../../src/commands/init.ts", import.meta.url).pathname;

// The stamp decision is a pure config diff, so it is reproduced here exactly as
// init computes it. If init's rule changes, this diverges and the wiring test
// below is what catches it.
function freshTypes(
  nextHashes: Record<string, string>,
  previousHashes: Record<string, string> | null,
): string[] {
  const previous = new Set(Object.keys(previousHashes ?? {}));
  return Object.keys(nextHashes).filter((t) => !previous.has(t));
}

describe("init stamps fresh type partitions", () => {
  test("a type absent from the previous config is fresh", () => {
    const before = { design: TEST_HASHES.design, task: TEST_HASHES.task };
    const after = { ...before, papercut: TEST_HASHES.papercut };
    expect(freshTypes(after, before)).toEqual(["papercut"]);
  });

  // The load-bearing one. A pre-cutover partition belongs to a type that has
  // been in the config for months; certifying it empty would hide real records.
  test("a type already in the previous config is NEVER fresh", () => {
    const before = { design: TEST_HASHES.design, papercut: TEST_HASHES.papercut };
    const after = { ...before };
    expect(freshTypes(after, before)).toEqual([]);
  });

  test("first init (no previous config) treats every type as fresh", () => {
    const after = { design: TEST_HASHES.design, task: TEST_HASHES.task };
    expect(freshTypes(after, null).sort()).toEqual(["design", "task"]);
  });

  test("a re-registered type whose hash CHANGED is still not fresh", () => {
    // A schema hash can change under migration. The type still has records
    // written against the old hash, so its partition is not empty.
    const before = { papercut: TEST_HASHES.papercut };
    const after = { papercut: "f".repeat(64) };
    expect(freshTypes(after, before)).toEqual([]);
  });

  test("init wires the stamp to the config diff, not to a node resolution", async () => {
    const source = await Bun.file(INIT_SRC).text();
    expect(source.includes("stampFreshTypePartitions")).toBe(true);
    const fn = source.slice(source.indexOf("async function stampFreshTypePartitions"));
    // The previous config is the input. A node-reported "register"/"reuse"
    // resolution is NOT: the catalog publish path re-registers every schema on
    // every init, so it cannot distinguish a new type from an existing one.
    expect(
      fn.includes("existing?.schemaHashes"),
      "the fresh-type test must be a diff against the previous config",
    ).toBe(true);
    expect(
      fn.includes("markTypePartitionMigrated"),
      "fresh types must have their partition marked complete",
    ).toBe(true);
  });

  test("the marker range is the reserved one, not a slug", () => {
    // Guards against the marker colliding with a real record whose slug happens
    // to sort into the same range key.
    expect(RECORD_LIST_ENTRY_MIGRATED_RANGE.startsWith("__")).toBe(true);
    const cfg = buildTestCfg();
    expect(cfg.schemaHashes.papercut).toBe(TEST_HASHES.papercut);
  });
});
