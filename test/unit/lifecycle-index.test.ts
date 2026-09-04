import { describe, expect, test } from "bun:test";

import { planLifecycleMembershipOps } from "../../src/lifecycle-index.ts";
import { EPH_INDEX_SCHEMA_KEY } from "../../src/schemas.ts";
import type { FbrainRecord } from "../../src/record.ts";

const EPH_HASH = "2".repeat(64);

function rec(over: Partial<FbrainRecord> = {}): FbrainRecord {
  return {
    slug: "lifecycle-ship-proof-eph",
    title: "lifecycle-ship-proof-eph",
    body: "ephemeral proof closeout",
    status: "active",
    tags: ["series:proof", "eph-day:2026-08-13"],
    created_at: "2026-08-13T00:00:00Z",
    updated_at: "2026-08-13T00:00:00Z",
    ...over,
  };
}

describe("planLifecycleMembershipOps eph payload", () => {
  test("stamps product type on the eph membership payload", () => {
    const ops = planLifecycleMembershipOps({
      cfg: { schemaHashes: { [EPH_INDEX_SCHEMA_KEY]: EPH_HASH } },
      type: "reference",
      slug: "lifecycle-ship-proof-eph",
      record: rec(),
      upsertType: "create",
    });
    const eph = ops.find(
      (op) => op.schemaHash === EPH_HASH && op.mutationType === "create",
    );
    expect(eph).toBeDefined();
    const payload = JSON.parse(eph!.fields.eph_payload ?? "{}") as FbrainRecord;
    expect(payload.type).toBe("reference");
    expect(payload.slug).toBe("lifecycle-ship-proof-eph");
  });

  test("does not emit an untyped eph payload for a reference closeout", () => {
    const ops = planLifecycleMembershipOps({
      cfg: { schemaHashes: { [EPH_INDEX_SCHEMA_KEY]: EPH_HASH } },
      type: "reference",
      slug: "lifecycle-ship-proof-eph",
      record: rec(),
      upsertType: "create",
    });
    const eph = ops.find(
      (op) => op.schemaHash === EPH_HASH && op.mutationType === "create",
    );
    const payload = JSON.parse(eph!.fields.eph_payload ?? "{}") as {
      type?: string;
    };
    expect(payload.type).not.toBeUndefined();
    expect(payload.type).not.toBe("preference");
  });
});
