// `papercut list --body-resolved` surfaces the rows whose BODY claims a
// resolution the typed `status` does not carry.
//
// The ledger predates the typed status column, so a run that fixed a defect
// wrote its verdict as prose and left the header where the record was filed.
// Measured on the primary 2026-09-05: of the 16 open rows carrying a
// `fixed_by` header, 11 said `Status: FIXED` AND carried a `Verified:` line
// while the typed status still read `open`, the oldest since 2026-08-05.
// `papercut list --status open` and `papercut census` both rank on the typed
// field, so a month of already-verified work was counted as outstanding defect
// load and was invisible as a closure candidate, because nothing compared the
// two.
//
// The claim forms below are the ones the live corpus actually holds — read off
// 24 matching rows of the 191 open `--kind specified-fix` records on
// 2026-09-05, not invented for the test.
import { describe, expect, test } from "bun:test";
import {
  LIST_METHOD_BODY_RESOLVED,
  bodyClaimOutranksStatus,
  bodyResolutionClaim,
  buildPapercutList,
  papercutListCmd,
  staleClosureClaim,
} from "../../src/commands/papercut.ts";
import {
  PAPERCUT_FLAGS_BY_SUBCOMMAND,
  USAGE_ERROR_CODES,
} from "../../src/cli.ts";
import { PAPERCUT_STATUSES } from "../../src/schemas.ts";
import type { FbrainRecord } from "../../src/record.ts";

function rec(over: Partial<FbrainRecord> = {}): FbrainRecord {
  return {
    slug: "s",
    title: "t",
    body: "",
    status: "open",
    tags: [],
    component: "brain",
    severity: "p0",
    kind: "specified-fix",
    repo: "EdgeVector/brain",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...over,
  } as FbrainRecord;
}

// Verbatim from live records, so a spelling the corpus uses cannot be dropped
// by a later tightening of the markers.
const LIVE_FIXED_LINES = [
  "Status: **FIXED** — lastgit PR #191, merged `3ab1ebc`, 2026-08-03.",
  "## Status: FIXED — 2026-08-05 (lastgit-improvement chief-engineer, run o)",
  "## STATUS: RESOLVED — 2026-08-02 ~23:44Z",
  "Status: **RESOLVED 2026-08-01 — lastgit #144**",
  "Status: FIXED 2026-08-05 — parity wiring + address-decides-existence defect",
];

const LIVE_VERIFIED_LINES = [
  "Verified: not \"merged\". `lastgit which` -> build `5960f8729c4c`, installed",
  "Verified: reproduced FIRST, then fixed, then re-run.",
  "Verified: **live on the primary this run, not on the merge.**",
];

describe("bodyResolutionClaim", () => {
  test("reads every fixed-claim spelling the live corpus carries", () => {
    for (const line of LIVE_FIXED_LINES) {
      const claim = bodyResolutionClaim(`## Symptom\nprose\n\n${line}\n`);
      expect(claim).not.toBeNull();
      expect(claim?.level).toBe("fixed");
      expect(claim?.line).toBe(line);
    }
  });

  test("reads every verified-claim spelling the live corpus carries", () => {
    for (const line of LIVE_VERIFIED_LINES) {
      const claim = bodyResolutionClaim(`## Symptom\nprose\n\n${line}\n`);
      expect(claim?.level).toBe("verified");
      expect(claim?.line).toBe(line);
    }
  });

  test("a Status line naming VERIFIED is a live-check claim, not a merge one", () => {
    expect(bodyResolutionClaim("Status: VERIFIED 2026-08-09")?.level).toBe(
      "verified",
    );
  });

  test("a later Verified line outranks an earlier fixed claim", () => {
    const claim = bodyResolutionClaim(
      "Status: **FIXED** — PR #191\nFixed-by: PR #191\nVerified: re-ran it live\n",
    );
    expect(claim?.level).toBe("verified");
    expect(claim?.line).toBe("Verified: re-ran it live");
  });

  // The negative fixtures supply a WRONG value, never an absent one: a body
  // with no `Status:` line at all cannot distinguish "the marker is right" from
  // "the marker never ran".
  test("a Status line naming a live state is not a claim", () => {
    expect(bodyResolutionClaim("Status: OPEN\nStatus: BLOCKED\n")).toBeNull();
  });

  test("a negated verification line is not a claim", () => {
    expect(
      bodyResolutionClaim("Not verified: nobody re-ran it\nUnverified: still\n"),
    ).toBeNull();
  });

  test("a Verified label with nothing after it is not a claim", () => {
    expect(bodyResolutionClaim("Verified:\nVerified:   \n")).toBeNull();
  });

  test("the words in prose do not match — the marker is line-anchored", () => {
    expect(
      bodyResolutionClaim("we verified: nothing, and the status: fixed was a lie"),
    ).toBeNull();
  });

  test("an empty or non-string body is not a claim", () => {
    expect(bodyResolutionClaim("")).toBeNull();
    expect(bodyResolutionClaim(undefined)).toBeNull();
  });
});

describe("bodyClaimOutranksStatus", () => {
  const fixed = { level: "fixed", line: "Status: FIXED" } as const;
  const verified = { level: "verified", line: "Verified: ran it" } as const;

  test("open is outranked by either claim", () => {
    expect(bodyClaimOutranksStatus(fixed, "open")).toBe(true);
    expect(bodyClaimOutranksStatus(verified, "open")).toBe(true);
  });

  test("fixed is outranked only by a live-check claim", () => {
    expect(bodyClaimOutranksStatus(verified, "fixed")).toBe(true);
    expect(bodyClaimOutranksStatus(fixed, "fixed")).toBe(false);
  });

  // `partial` MEANS the body carries a resolved half and an unresolved one, so
  // a resolution line inside one is expected and says nothing about the record.
  test("partial is never reported, because a claim there is documented", () => {
    expect(bodyClaimOutranksStatus(fixed, "partial")).toBe(false);
    expect(bodyClaimOutranksStatus(verified, "partial")).toBe(false);
  });

  test("terminal statuses are never reported", () => {
    for (const status of ["verified", "wontfix", "duplicate"]) {
      expect(bodyClaimOutranksStatus(verified, status)).toBe(false);
      expect(bodyClaimOutranksStatus(fixed, status)).toBe(false);
    }
  });

  test("no claim is never a candidate, whatever the status", () => {
    for (const status of PAPERCUT_STATUSES)
      expect(bodyClaimOutranksStatus(null, status)).toBe(false);
  });

  // Structural: a status added to the enum later gets a decision here rather
  // than falling through to whichever branch happens to be last.
  test("every declared status resolves to a boolean, none throws", () => {
    for (const status of PAPERCUT_STATUSES)
      expect(typeof bodyClaimOutranksStatus(verified, status)).toBe("boolean");
  });
});

describe("buildPapercutList --body-resolved", () => {
  const records = [
    rec({ slug: "stale-open", body: "Status: **FIXED** — PR #191" }),
    rec({ slug: "stale-fixed", status: "fixed", body: "Verified: ran it live" }),
    rec({ slug: "consistent-fixed", status: "fixed", body: "Status: FIXED" }),
    rec({ slug: "honest-open", body: "Status: OPEN\nstill costing us" }),
    rec({ slug: "closed", status: "verified", body: "Verified: ran it live" }),
  ];

  test("off by default: the filter changes nothing unless asked for", () => {
    expect(buildPapercutList(records, {}).map((r) => r.slug).sort()).toEqual(
      ["closed", "consistent-fixed", "honest-open", "stale-fixed", "stale-open"],
    );
  });

  test("no row carries a body_claim when the filter is off", () => {
    for (const row of buildPapercutList(records, {}))
      expect(row.body_claim).toBeUndefined();
  });

  test("on, it keeps exactly the rows whose body outranks their status", () => {
    expect(
      buildPapercutList(records, {}, true)
        .map((r) => r.slug)
        .sort(),
    ).toEqual(["stale-fixed", "stale-open"]);
  });

  test("every kept row carries the line that matched, as its evidence", () => {
    for (const row of buildPapercutList(records, {}, true)) {
      expect(row.body_claim).toBeDefined();
      expect(row.body_claim?.line.length).toBeGreaterThan(0);
      expect(
        records.find((r) => r.slug === row.slug)?.body as string,
      ).toContain(row.body_claim?.line as string);
    }
  });

  test("it composes with the other filters instead of replacing them", () => {
    const mixed = [
      ...records,
      rec({
        slug: "other-component",
        component: "kanban",
        body: "Status: FIXED",
      }),
    ];
    expect(
      buildPapercutList(mixed, { component: "kanban" }, true).map((r) => r.slug),
    ).toEqual(["other-component"]);
  });

  test("staleClosureClaim agrees with the list for every record", () => {
    const kept = new Set(buildPapercutList(records, {}, true).map((r) => r.slug));
    for (const r of records)
      expect(staleClosureClaim(r) !== null).toBe(kept.has(r.slug));
  });
});

// The body is not servable from either cheap reading, so the flag has to be
// REFUSED against both rather than quietly degrading. A silent degrade here
// drops the newest rows — the ones whose closing block was appended most
// recently — and drops them invisibly.
describe("--body-resolved refuses the readings that cannot serve a body", () => {
  const cfg = { schemaHashes: {} } as never;

  test("--fast is refused, and the refusal needs no node", async () => {
    await expect(
      papercutListCmd({ cfg, fast: true, bodyResolved: true }),
    ).rejects.toMatchObject({
      code: "papercut_list_body_resolved_needs_point_read",
    });
  });

  test("--index-only is refused, and the refusal needs no node", async () => {
    await expect(
      papercutListCmd({ cfg, indexOnly: true, bodyResolved: true }),
    ).rejects.toMatchObject({ code: "papercut_list_index_only_no_body" });
  });

  test("both refusals are usage errors, not operational failures", () => {
    expect(USAGE_ERROR_CODES.has("papercut_list_body_resolved_needs_point_read")).toBe(true);
    expect(USAGE_ERROR_CODES.has("papercut_list_index_only_no_body")).toBe(true);
  });

  test("only list declares the flag — the shared table cannot drop it", () => {
    expect(PAPERCUT_FLAGS_BY_SUBCOMMAND.list).toContain("body-resolved");
    for (const sub of ["file", "close", "census"])
      expect(PAPERCUT_FLAGS_BY_SUBCOMMAND[sub]).not.toContain("body-resolved");
  });

  // The method line is the only thing standing between a filtered list of rows
  // whose bodies say FIXED and someone flipping them in bulk.
  test("the method clause says CANDIDATES and says it never writes", () => {
    expect(LIST_METHOD_BODY_RESOLVED).toContain("CANDIDATES");
    expect(LIST_METHOD_BODY_RESOLVED).toContain("never writes");
    expect(LIST_METHOD_BODY_RESOLVED).toContain("point-read");
  });
});
