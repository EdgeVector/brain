import { describe, expect, test } from "bun:test";
import {
  addUtcDays,
  ephHash,
  expiredEphDays,
  factBlock,
  isLiveStatus,
  pickCanonical,
  uniqueFacts,
  utcDay,
  type ClusterMember,
} from "../../src/lifecycle.ts";
import { inferType } from "../../src/commands/consolidate.ts";
import type { FbrainRecord } from "../../src/record.ts";

function rec(slug: string, body: string, extra: Partial<FbrainRecord> = {}): FbrainRecord {
  return {
    slug,
    title: slug,
    body,
    status: "active",
    tags: [],
    created_at: extra.created_at ?? "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    ...extra,
  };
}

function member(slug: string, body: string, extra: Partial<FbrainRecord> = {}): ClusterMember {
  return { type: "preference", slug, record: rec(slug, body, extra) };
}

describe("uniqueFacts", () => {
  test("returns paragraphs absent from the canonical body", () => {
    expect(uniqueFacts("keep\n\nshared", "unique\n\nshared")).toEqual(["unique"]);
  });
  test("empty when every paragraph already exists", () => {
    expect(uniqueFacts("keep\n\nshared", "keep\n\nshared")).toEqual([]);
  });
});

describe("pickCanonical", () => {
  test("prefers the canonical tag", () => {
    const a = member("a", "x");
    const b = member("b", "y", { tags: ["canonical"] });
    expect(pickCanonical([a, b]).slug).toBe("b");
  });
  test("falls back to oldest created_at then slug", () => {
    const a = member("z-old", "x", { created_at: "2026-07-01T00:00:00Z" });
    const b = member("a-new", "y", { created_at: "2026-08-01T00:00:00Z" });
    expect(pickCanonical([b, a]).slug).toBe("z-old");
  });
});

describe("isLiveStatus", () => {
  test("preference active is live, parked is not", () => {
    expect(isLiveStatus("preference", "active")).toBe(true);
    expect(isLiveStatus("preference", "parked")).toBe(false);
    expect(isLiveStatus("preference", "superseded")).toBe(false);
  });
  test("decision stays live until deleted", () => {
    expect(isLiveStatus("decision", "go")).toBe(true);
    expect(isLiveStatus("decision", "superseded")).toBe(true);
  });
});

describe("eph day hashes", () => {
  test("utcDay formats UTC", () => {
    expect(utcDay(new Date("2026-08-27T23:00:00Z"))).toBe("2026-08-27");
  });
  test("expiredEphDays names hashes at and beyond retention", () => {
    const days = expiredEphDays("2026-08-27", 14, 3);
    expect(days).toEqual(["2026-08-13", "2026-08-12", "2026-08-11"]);
    expect(ephHash("proof", days[0]!)).toBe("proof:2026-08-13");
  });
  test("addUtcDays crosses months", () => {
    expect(addUtcDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("factBlock", () => {
  test("stamps source slug", () => {
    const block = factBlock("hello", "loser-1", "2026-08-27");
    expect(block).toContain("from loser-1");
    expect(block).toContain("hello");
  });
});

describe("inferType from membership payload", () => {
  const cfg = { schemaHashes: {} };

  test("uses the stamped product type", () => {
    expect(inferType(cfg, rec("eph-ref", "closeout", { type: "reference" }))).toBe(
      "reference",
    );
    expect(inferType(cfg, rec("eph-pref", "closeout", { type: "preference" }))).toBe(
      "preference",
    );
  });

  test("does not default a missing type to preference", () => {
    expect(inferType(cfg, rec("eph-unstamped", "closeout"))).toBeNull();
  });
});
