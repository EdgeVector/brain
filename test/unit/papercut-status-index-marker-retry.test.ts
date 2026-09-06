// The completeness marker of the status-keyed papercut index is ONE row, read
// by every ledger reader before it reads anything else. Until 2026-09-06 it was
// read once, unretried, so a page flake on that one read turned every census,
// list and dedupe gate into "registered but not marked complete" at once —
// measured three times, each within hours of a LastDB cutover, each clearing
// with no rebuild having run. The marker read now spends the same retry budget
// a keyed point read does.

import { describe, expect, test } from "bun:test";
import {
  papercutStatusIndexMarkerPresent,
  requireCompletePapercutStatusIndex,
} from "../../src/papercut-status-index.ts";
import {
  PAPERCUT_STATUS_INDEX_GLOBAL_HASH,
  PAPERCUT_STATUS_INDEX_MARKER,
  PAPERCUT_STATUS_INDEX_MIGRATED_RANGE,
  PAPERCUT_STATUS_INDEX_SCHEMA_KEY,
} from "../../src/schemas.ts";

const ENTRY_HASH = "psihash";
const CFG = { schemaHashes: { [PAPERCUT_STATUS_INDEX_SCHEMA_KEY]: ENTRY_HASH, papercut: "pc" } };

/** A node whose marker read returns an empty page `flakes` times, then the row. */
function flakyMarkerNode(flakes: number, present = true) {
  let markerReads = 0;
  const node = {
    async queryAll({ schemaHash, filter }: any) {
      const hrk = filter?.HashRangeKey as { hash: string; range: string } | undefined;
      if (
        schemaHash === ENTRY_HASH &&
        hrk?.hash === PAPERCUT_STATUS_INDEX_GLOBAL_HASH &&
        hrk?.range === PAPERCUT_STATUS_INDEX_MIGRATED_RANGE
      ) {
        markerReads += 1;
        if (!present || markerReads <= flakes) return { results: [] };
        return {
          results: [
            {
              fields: {
                psi_h: hrk.hash,
                psi_r: hrk.range,
                psi_payload: "",
                psi_marker: PAPERCUT_STATUS_INDEX_MARKER,
              },
              key: { hash: hrk.hash, range: hrk.range },
            },
          ],
        };
      }
      throw new Error(`unexpected query ${schemaHash} ${JSON.stringify(filter)}`);
    },
  };
  return { node: node as any, reads: () => markerReads };
}

const noSleep = { sleep: async () => {} };

describe("the completeness marker is read with a retry budget", () => {
  test("a marker that is present on the first read costs one read", async () => {
    const { node, reads } = flakyMarkerNode(0);
    expect(await papercutStatusIndexMarkerPresent(node, ENTRY_HASH, noSleep)).toBe(true);
    expect(reads()).toBe(1);
  });

  test("a page flake on the first read is retried, and the marker is found", async () => {
    const { node, reads } = flakyMarkerNode(2);
    expect(await papercutStatusIndexMarkerPresent(node, ENTRY_HASH, { ...noSleep, maxAttempts: 4 })).toBe(true);
    expect(reads()).toBe(3);
  });

  test("a genuinely absent marker still reads absent after the budget", async () => {
    const { node, reads } = flakyMarkerNode(0, false);
    expect(
      await papercutStatusIndexMarkerPresent(node, ENTRY_HASH, { ...noSleep, maxAttempts: 3 }),
    ).toBe(false);
    expect(reads()).toBe(3);
  });

  // The reader every census/list/gate goes through. One flaked page must not
  // become a fleet-wide refusal.
  test("requireCompletePapercutStatusIndex survives one flaked marker read", async () => {
    const { node, reads } = flakyMarkerNode(1);
    expect(await requireCompletePapercutStatusIndex(node, CFG)).toBe(ENTRY_HASH);
    expect(reads()).toBe(2);
  });

  test("an unregistered index still refuses before any node read", async () => {
    const { node, reads } = flakyMarkerNode(0);
    await expect(
      requireCompletePapercutStatusIndex(node, { schemaHashes: { papercut: "pc" } }),
    ).rejects.toMatchObject({ code: "papercut_status_index_incomplete" });
    expect(reads()).toBe(0);
  });
});
