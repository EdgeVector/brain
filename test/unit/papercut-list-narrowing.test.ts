// `papercut list` narrows candidates from the index payload snapshot before it
// point-reads anything. That turns a filtered listing from "the size of the
// partition" into "the size of the answer" — measured on the primary
// 2026-09-04, `--status open --severity p0` returned 22 rows and charged 2258
// node requests / 715.6s of node time to do it, and an owner-review run doing
// the same read got socket-not-reachable from the load.
//
// Narrowing is only safe while it can never rule out a row the rendered filter
// would have kept. These guards assert that relationship structurally, so a
// filter added later cannot make the narrowing stricter than the answer.
import { describe, expect, test } from "bun:test";
import {
  PAPERCUT_LIST_FILTERS,
  PAPERCUT_NARROWABLE_FILTERS,
  buildPapercutList,
  listMethod,
  matchesPapercutFilters,
  narrowingFilters,
  type PapercutListFilters,
} from "../../src/commands/papercut.ts";
import type { FbrainRecord } from "../../src/record.ts";

function rec(over: Partial<FbrainRecord> = {}): FbrainRecord {
  return {
    slug: "s",
    title: "t",
    body: "b",
    status: "open",
    tags: [],
    component: "brain",
    severity: "p0",
    kind: "complaint",
    repo: "EdgeVector/brain",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...over,
  } as FbrainRecord;
}

const FULL: PapercutListFilters = {
  component: "brain",
  status: "open",
  severity: "p0",
  kind: "complaint",
  repo: "EdgeVector/brain",
  tags: ["owner:fbrain"],
};

describe("narrowingFilters", () => {
  test("narrows on every list filter except status", () => {
    expect([...PAPERCUT_NARROWABLE_FILTERS].sort()).toEqual(
      PAPERCUT_LIST_FILTERS.filter((f) => f !== "status").sort(),
    );
    expect(Object.keys(narrowingFilters(FULL) ?? {}).sort()).toEqual(
      PAPERCUT_LIST_FILTERS.filter((f) => f !== "status").sort(),
    );
  });

  // `status` is the partition key. Letting the snapshot decide it would take
  // away the reader's only way to catch a record whose status moved without
  // the index following.
  test("an unfiltered or status-only listing narrows nothing", () => {
    expect(narrowingFilters({})).toBeNull();
    expect(narrowingFilters({ status: "open" })).toBeNull();
  });

  // The load-bearing property: narrowing must be a RELAXATION of the rendered
  // filter. Anything the full filter keeps, the narrowing must also keep, or
  // the row is dropped before it is ever read and the listing silently shrinks.
  test("narrowing keeps every record the rendered filter keeps", () => {
    const records = [
      rec({ slug: "match" }),
      rec({ slug: "wrong-sev", severity: "p2" }),
      rec({ slug: "wrong-kind", kind: "defect" }),
      rec({ slug: "wrong-repo", repo: "EdgeVector/lastgit" }),
      rec({ slug: "wrong-component", component: "lastgit" }),
      rec({ slug: "wrong-status", status: "fixed" }),
      rec({ slug: "no-tag", tags: [] }),
    ].map((r) => ({ ...r, tags: r.slug === "no-tag" ? [] : ["owner:fbrain"] }));
    const narrowBy = narrowingFilters(FULL)!;
    for (const r of records) {
      if (matchesPapercutFilters(r, FULL))
        expect(`${r.slug}:${matchesPapercutFilters(r, narrowBy)}`).toBe(
          `${r.slug}:true`,
        );
    }
    // And it is a real narrowing, not a pass-through: only the status mismatch
    // survives it, because status is the one filter it declines to judge.
    expect(
      records.filter((r) => matchesPapercutFilters(r, narrowBy)).map((r) => r.slug),
    ).toEqual(["match", "wrong-status"]);
    expect(buildPapercutList(records, FULL).map((r) => r.slug)).toEqual([
      "match",
    ]);
  });
});

describe("listMethod", () => {
  // A caller who only learns the command got faster cannot tell a narrowed
  // answer from a complete one, and this reader's contract is that it returns
  // every matching row.
  test("discloses what was narrowed, how much was read, and the risk", () => {
    const line = listMethod(false, FULL, {
      fields: ["severity"],
      rows: 2251,
      pointReads: 22,
    });
    expect(line).toContain("candidates pre-selected from the index snapshot");
    expect(line).toContain("severity");
    expect(line).toContain("22 of 2251 rows point-read");
    expect(line).toContain("disagrees on those fields is not read");
  });

  test("an unnarrowed listing makes no such claim", () => {
    expect(listMethod(false, { status: "open" })).not.toContain(
      "pre-selected",
    );
  });
});
