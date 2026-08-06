// Guard: every product write path must maintain the type-list index.
//
// This exists because `papercut file` shipped without it. The command called
// `node.createRecord` directly — correct as far as SOT is concerned — and the
// record landed and was readable with `brain get`. But `brain list --type
// papercut` and `papercut census` both read the type-list index, so both
// reported ZERO while the record existed. The first papercut ever filed
// produced a census that said "no papercuts".
//
// That is the same failure `papercut-brain-list-under-reports…` records — 68
// `papercut-lastgit-*` rows invisible to every list/search while `brain get`
// still resolved them — reproduced inside the ledger built to end it.
//
// A source-level guard is the right shape here, matching the repo's other
// drift guards (TOP_HELP<->COMMANDS, README<->RECORD_PURPOSES): the failure is
// "a writer forgot a call", which no unit test of the writer's output can see,
// because the record it returns is perfectly correct.

import { describe, expect, test } from "bun:test";

const WRITE_PATHS = [
  "src/commands/put.ts",
  "src/commands/papercut.ts",
] as const;

describe("write paths maintain the type-list index", () => {
  for (const path of WRITE_PATHS) {
    test(`${path} calls maintainTypeListIndex`, async () => {
      const source = await Bun.file(new URL(`../../${path}`, import.meta.url)).text();
      expect(
        source.includes("maintainTypeListIndex"),
        `${path} creates or updates records but never calls maintainTypeListIndex — ` +
          "the rows will be invisible to list/census/BM25 while `brain get` still resolves them",
      ).toBe(true);
    });

    test(`${path} does not patch the list index by hand`, async () => {
      const source = await Bun.file(new URL(`../../${path}`, import.meta.url)).text();
      // patchTypeListIndex is the low-level primitive. Calling it directly skips
      // the unmark-on-failure self-heal, which is the half that stops one failed
      // dual-write from under-reporting a type forever.
      expect(
        source.includes("patchTypeListIndex"),
        `${path} should call maintainTypeListIndex, not patchTypeListIndex directly — ` +
          "the wrapper carries the unmark-on-failure self-heal",
      ).toBe(false);
    });
  }

  // NOT asserted here, deliberately: that every module calling createRecord /
  // updateRecord maintains the index. Twelve do write records — append, new,
  // delete, link, gate, migrate, reindex, admin-snapshot among them — and
  // whether each NEEDS the index patched depends on which fields the index
  // carries versus which the write changes. That is a real question and it is
  // not this change's question; asserting it here would pin a policy nobody
  // has established. Recorded as `papercut-brain-list-index-maintenance-is-
  // per-writer-opt-in` rather than guessed at.
});
