// `brain doctor` names the papercut status index's two failure states, each
// with its own fix, instead of reporting all-PASS on a node whose whole typed
// ledger refuses to read.

import { describe, expect, test } from "bun:test";
import {
  PAPERCUT_STATUS_INDEX_CHECK,
  runPapercutStatusIndexProbe,
} from "../../src/commands/doctor/papercut-status-index.ts";
import {
  PAPERCUT_STATUS_INDEX_GLOBAL_HASH,
  PAPERCUT_STATUS_INDEX_MARKER,
  PAPERCUT_STATUS_INDEX_MIGRATED_RANGE,
  PAPERCUT_STATUS_INDEX_SCHEMA_KEY,
} from "../../src/schemas.ts";
import type { Config } from "../../src/config.ts";

const ENTRY_HASH = "psihash";

function cfgWith(schemaHashes: Record<string, string>): Config {
  return { schemaHashes } as unknown as Config;
}

function nodeWithMarker(present: boolean, fail?: Error) {
  return {
    async queryAll({ filter }: any) {
      if (fail) throw fail;
      const hrk = filter?.HashRangeKey;
      const hit =
        present &&
        hrk?.hash === PAPERCUT_STATUS_INDEX_GLOBAL_HASH &&
        hrk?.range === PAPERCUT_STATUS_INDEX_MIGRATED_RANGE;
      return {
        results: hit
          ? [
              {
                fields: {
                  psi_h: hrk.hash,
                  psi_r: hrk.range,
                  psi_payload: "",
                  psi_marker: PAPERCUT_STATUS_INDEX_MARKER,
                },
                key: { hash: hrk.hash, range: hrk.range },
              },
            ]
          : [],
      };
    },
  } as any;
}

describe("doctor: papercut-status-index", () => {
  test("SKIPs on a node without the papercut type", async () => {
    const r = await runPapercutStatusIndexProbe(nodeWithMarker(true), cfgWith({}));
    expect(r.name).toBe(PAPERCUT_STATUS_INDEX_CHECK);
    expect(r.ok).toBe(true);
    expect(r.tag).toBe("SKIP");
  });

  test("FAILs, naming `brain init`, when the index is not registered", async () => {
    const r = await runPapercutStatusIndexProbe(nodeWithMarker(true), cfgWith({ papercut: "pc" }));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("NOT registered");
    expect(r.fix).toContain("brain init");
  });

  test("FAILs, naming the reindex, when the marker is absent", async () => {
    const r = await runPapercutStatusIndexProbe(
      nodeWithMarker(false),
      cfgWith({ papercut: "pc", [PAPERCUT_STATUS_INDEX_SCHEMA_KEY]: ENTRY_HASH }),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("marker is absent");
    expect(r.fix).toContain("reindex --papercut-status-index");
  });

  test("WARNs, not PASSes, when the marker cannot be read", async () => {
    const r = await runPapercutStatusIndexProbe(
      nodeWithMarker(true, new Error("socket closed")),
      cfgWith({ papercut: "pc", [PAPERCUT_STATUS_INDEX_SCHEMA_KEY]: ENTRY_HASH }),
    );
    expect(r.ok).toBe(false);
    expect(r.tag).toBe("WARN");
    expect(r.detail).toContain("socket closed");
  });

  test("PASSes when registered and marked complete", async () => {
    const r = await runPapercutStatusIndexProbe(
      nodeWithMarker(true),
      cfgWith({ papercut: "pc", [PAPERCUT_STATUS_INDEX_SCHEMA_KEY]: ENTRY_HASH }),
    );
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("marked complete");
  });
});
