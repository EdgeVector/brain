// Integration test — the tag secondary index end-to-end against the real
// fold_db_node harness. Skipped when no harness is available
// (FBRAIN_SKIP_INTEGRATION=1 or FOLD_NODE_DIR unreachable).
//
// This exercises the parts a mock can't prove:
//   - `fbrain init` actually registers + loads the `fbrain/TagIndex` schema and
//     writes its canonical hash to `cfg.schemaHashes.__tagindex__`.
//   - The node's `HashKey` query filter (fold #905) that `queryByKey` relies on
//     really point-reads a single row — the flat-cost primitive.
//   - A create indexes its tags, `list --tag` resolves THROUGH the index, a
//     delete unindexes, and `reindex --tags` rebuilds — all over the real wire.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isHarnessAvailable, startHarness, type Harness } from "../harness.ts";
import { readConfig, type Config } from "../../src/config.ts";
import { recordNew } from "../../src/commands/new.ts";
import { listCmd } from "../../src/commands/list.ts";
import { deleteRecord } from "../../src/commands/delete.ts";
import { reindexCmd } from "../../src/commands/reindex.ts";
import { newReadClientFromCfg } from "../../src/client.ts";
import { readTagIndex, tagIndexAvailable } from "../../src/tag-index.ts";

// Run `list --tag <tag> --json` and return the parsed record summaries.
async function listByTag(cfg: Config, tag: string): Promise<Array<{ slug: string }>> {
  let out = "";
  await listCmd({ cfg, tag, json: true, print: (l) => { out += l; }, printErr: () => {} });
  return JSON.parse(out) as Array<{ slug: string }>;
}

const skipReason = !isHarnessAvailable();
const describeIntegration = skipReason ? describe.skip : describe;

let harness: Harness;
let tmpHome: string;
let configPath: string;

// No consent gate on the ephemeral dogfood node.
process.env.FBRAIN_APP_IDENTITY_ENFORCE = "off";

const VEC = { vectorVerifyOptions: { sleep: () => Promise.resolve() } } as const;

beforeAll(async () => {
  if (skipReason) return;
  harness = await startHarness({ name: "fbrain-tagidx-test" });
  tmpHome = mkdtempSync(join(tmpdir(), "fbrain-tagidx-cfg-"));
  configPath = join(tmpHome, "config.json");
  process.env.FBRAIN_CONFIG = configPath;
  process.env.FBRAIN_NO_STDIN = "1";
  process.env.FBRAIN_INIT_RETRY_DELAYS_MS = "";
  const { runInit } = await import("../../src/commands/init.ts");
  await runInit({
    configPath,
    nodeUrl: harness.nodeUrl,
    schemaServiceUrl: harness.schemaServiceUrl,
    bootstrapName: "fbrain-tagidx",
    print: () => {},
  });
});

afterAll(async () => {
  if (skipReason) return;
  if (harness) await harness.teardown();
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.FBRAIN_CONFIG;
  delete process.env.FBRAIN_NO_STDIN;
});

describeIntegration("tag secondary index (integration)", () => {
  test("init registered the TagIndex schema", () => {
    const cfg = readConfig();
    expect(tagIndexAvailable(cfg)).toBe(true);
    expect(cfg.schemaHashes.__tagindex__).toMatch(/.+/);
  });

  test("create → index → list --tag resolves through the index; delete unindexes", async () => {
    const cfg = readConfig();

    // Create three records: two carry `papercut`, one doesn't.
    await recordNew({ cfg, type: "concept", slug: "ti-a", title: "A", body: "a", tags: ["papercut", "perf"], ...VEC });
    await recordNew({ cfg, type: "reference", slug: "ti-b", title: "B", body: "b", tags: ["papercut"], ...VEC });
    await recordNew({ cfg, type: "concept", slug: "ti-c", title: "C", body: "c", tags: ["other"], ...VEC });

    // The index now lists both papercut members (order-independent).
    const node = newReadClientFromCfg(cfg);
    const idx = await readTagIndex(node, cfg, "papercut");
    expect(idx).not.toBeNull();
    expect(idx!.members.sort()).toEqual(["concept:ti-a", "reference:ti-b"]);

    // list --tag papercut returns exactly those two, resolved via the index.
    const slugs = (await listByTag(cfg, "papercut")).map((c) => c.slug).sort();
    expect(slugs).toEqual(["ti-a", "ti-b"]);

    // Delete one → it drops out of the index and the tag query.
    await deleteRecord({ cfg, slug: "ti-a", type: "concept" });
    const idx2 = await readTagIndex(newReadClientFromCfg(readConfig()), readConfig(), "papercut");
    expect(idx2!.members).toEqual(["reference:ti-b"]);
    const after = (await listByTag(readConfig(), "papercut")).map((c) => c.slug);
    expect(after).toEqual(["ti-b"]);
  });

  test("reindex --tags rebuilds the index from the live corpus", async () => {
    const cfg = readConfig();
    const r = await reindexCmd({ cfg, tags: true, print: () => {} });
    expect(r.tagIndex).toBeDefined();
    // At least the `papercut`/`perf`/`other` tags seeded above are indexed.
    expect(r.tagIndex!.tagsIndexed).toBeGreaterThanOrEqual(1);
    // The rebuilt index still resolves the surviving papercut member.
    const idx = await readTagIndex(newReadClientFromCfg(cfg), cfg, "papercut");
    expect(idx!.members).toContain("reference:ti-b");
  });
});
