// Guard for a footgun that has already bitten once.
//
// TEST_HASHES assigns each RecordType a synthetic 64-hex schema hash, and the
// internal index schemas (tag index, record-list entry, attachments, admin
// snapshot) have their own. Adding the `papercut` type initially reused
// "7".repeat(64) — the tag index's hash. Nothing said so. `rebuildTagIndex`
// walks RECORD_TYPES, resolved `papercut` to the tag-index hash, read the tag
// index's own rows as if they were records, and died on `r.tags.includes` of
// undefined — a stack trace three modules away from the one-character cause.
//
// The fix for that class is not "remember to pick a fresh hash". It is a check
// that cannot pass while the collision exists.

import { describe, expect, test } from "bun:test";
import {
  TEST_HASHES,
  TEST_TAG_INDEX_HASH,
  TEST_RECORD_LIST_ENTRY_HASH,
} from "../util.ts";
import { RECORD_TYPES } from "../../src/schemas.ts";

describe("TEST_HASHES uniqueness", () => {
  test("covers every RecordType", () => {
    expect(Object.keys(TEST_HASHES).sort()).toEqual([...RECORD_TYPES].sort());
  });

  test("no two record types share a synthetic hash", () => {
    const seen = new Map<string, string>();
    for (const [type, hash] of Object.entries(TEST_HASHES)) {
      const prior = seen.get(hash);
      expect(prior, `${type} reuses the hash already assigned to ${prior}`).toBeUndefined();
      seen.set(hash, type);
    }
  });

  test("no record type collides with an internal index schema hash", () => {
    const reserved = new Map<string, string>([
      [TEST_TAG_INDEX_HASH, "TEST_TAG_INDEX_HASH"],
      [TEST_RECORD_LIST_ENTRY_HASH, "TEST_RECORD_LIST_ENTRY_HASH"],
    ]);
    for (const [type, hash] of Object.entries(TEST_HASHES)) {
      const clash = reserved.get(hash);
      expect(
        clash,
        `TEST_HASHES.${type} collides with ${clash} — pick an unused value`,
      ).toBeUndefined();
    }
  });

  test("every synthetic hash is 64 hex characters", () => {
    for (const [type, hash] of Object.entries(TEST_HASHES)) {
      expect(hash, `TEST_HASHES.${type}`).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
