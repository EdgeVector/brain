// The 2026-09-06 papercut-ledger infrastructure fixes, each pinned to the
// measured failure it closes:
//
//   - a refusal that follows `--not-duplicate-of` says what the flag did
//     (papercut-brain-papercut-file-refuses-when-every-candidate-is-cleared-
//     individually-but-accepts-not-duplicate-of-any-20260906);
//   - `papercut close` writes the reference twin of a dual-typed slug
//     (papercut-lastdb-typed-and-reference-copies-drift-in-opposite-
//     directions-per-family);
//   - `Closes-when:` is read, so a parent whose last item lives in a child
//     record is surfaced when the child closes (papercut-lastgit-a-record-
//     that-defers-its-last-item-to-a-child-record-has-no-computable-status).

import { describe, expect, test } from "bun:test";
import {
  CHILD_CLOSED_STATUSES,
  LIST_METHOD_BODY_RESOLVED,
  REFERENCE_TWIN_CLOSED,
  buildPapercutList,
  clearedDiagnostics,
  closesWhenClaim,
  closesWhenSlugs,
  referenceTwinStatusFor,
  type DuplicateCandidate,
} from "../../src/commands/papercut.ts";
import { PAPERCUT_STATUSES, REFERENCE_STATUSES } from "../../src/schemas.ts";
import type { FbrainRecord } from "../../src/record.ts";

function rec(over: Partial<FbrainRecord> & { slug: string }): FbrainRecord {
  return {
    title: "",
    body: "",
    status: "open",
    tags: [],
    created_at: "2026-09-06T00:00:00.000Z",
    updated_at: "2026-09-06T00:00:00.000Z",
    component: "lastgit",
    ...over,
  } as FbrainRecord;
}

function cand(slug: string): DuplicateCandidate {
  return { slug, title: slug, status: "open", score: 0.75, exact: false };
}

describe("--not-duplicate-of diagnostics on a refusal", () => {
  const candidates = [cand("papercut-a"), cand("papercut-b"), cand("papercut-c")];

  test("no slug given → no extra line (a first refusal stays as it was)", () => {
    expect(clearedDiagnostics(candidates, new Set())).toBeNull();
  });

  test("every given slug matched → says so and lists none as unmatched", () => {
    const d = clearedDiagnostics(candidates, new Set(["papercut-a", "papercut-b"]));
    expect(d).not.toBeNull();
    expect(d!.cleared).toEqual(["papercut-a", "papercut-b"]);
    expect(d!.unmatched).toEqual([]);
    expect(d!.line).toContain("2 of 2");
    expect(d!.line).not.toContain("NO candidate");
  });

  // The 2026-09-06 shape: ten slugs passed back, the same ten refused, and
  // nothing in the output to say whether the flag was read. Now the line
  // names each slug that did not match, so a copy that differs from the slug
  // column by one character is visible on the first retry.
  test("a slug that matches no candidate is named, not silently dropped", () => {
    const d = clearedDiagnostics(
      candidates,
      new Set(["papercut-a", "papercut-b ", "papercut-zzz"]),
    );
    expect(d!.cleared).toEqual(["papercut-a"]);
    expect(d!.unmatched).toEqual(["papercut-b ", "papercut-zzz"]);
    expect(d!.line).toContain("1 of 3");
    expect(d!.line).toContain("2 matched NO candidate");
    expect(d!.line).toContain("papercut-zzz");
  });

  test("the diagnostics never change the candidate set itself", () => {
    const before = candidates.map((c) => c.slug);
    clearedDiagnostics(candidates, new Set(["papercut-a"]));
    expect(candidates.map((c) => c.slug)).toEqual(before);
  });
});

describe("the reference twin of a typed close", () => {
  test("every terminal typed status archives the twin; open and partial leave it live", () => {
    expect(referenceTwinStatusFor("fixed")).toBe(REFERENCE_TWIN_CLOSED);
    expect(referenceTwinStatusFor("verified")).toBe(REFERENCE_TWIN_CLOSED);
    expect(referenceTwinStatusFor("wontfix")).toBe(REFERENCE_TWIN_CLOSED);
    expect(referenceTwinStatusFor("duplicate")).toBe(REFERENCE_TWIN_CLOSED);
    expect(referenceTwinStatusFor("open")).toBeNull();
    expect(referenceTwinStatusFor("partial")).toBeNull();
  });

  test("the twin status is one the reference type accepts", () => {
    expect(REFERENCE_STATUSES).toContain(REFERENCE_TWIN_CLOSED);
  });

  test("the rule covers the whole typed enum, so a new status cannot fall through unmapped", () => {
    for (const s of PAPERCUT_STATUSES) {
      const twin = referenceTwinStatusFor(s);
      expect(twin === null || twin === REFERENCE_TWIN_CLOSED).toBe(true);
    }
  });
});

describe("Closes-when: a status that is a function of another record's", () => {
  test("parses wikilinked, bare, and multi-child forms, with any Markdown prefix", () => {
    expect(closesWhenSlugs("Closes-when: [[papercut-child-a]]")).toEqual(["papercut-child-a"]);
    expect(closesWhenSlugs("> **Closes-when:** papercut-child-a")).toEqual(["papercut-child-a"]);
    expect(closesWhenSlugs("- Closes-when: [[papercut-a]], [[papercut-b]]")).toEqual([
      "papercut-a",
      "papercut-b",
    ]);
    expect(
      closesWhenSlugs("intro\n\nCloses-when: [[papercut-a]]\n\nmore prose\nCloses-When: papercut-b\n"),
    ).toEqual(["papercut-a", "papercut-b"]);
  });

  test("ignores prose that merely mentions the words, and non-slug tokens", () => {
    expect(closesWhenSlugs("this closes when the child lands")).toEqual([]);
    expect(closesWhenSlugs("Closes-when: TBD")).toEqual([]);
    expect(closesWhenSlugs("")).toEqual([]);
    expect(closesWhenSlugs(undefined)).toEqual([]);
  });

  const parent = rec({
    slug: "papercut-lastgit-parent",
    status: "open",
    body: "mostly fixed.\n\nCloses-when: [[papercut-lastgit-child]]\n",
  });

  test("a live parent whose child reads closed is a candidate", () => {
    const claim = closesWhenClaim(parent, new Map([["papercut-lastgit-child", "verified"]]));
    expect(claim).toEqual({ children: [{ slug: "papercut-lastgit-child", status: "verified" }] });
  });

  test("a child still open blocks the claim", () => {
    expect(closesWhenClaim(parent, new Map([["papercut-lastgit-child", "open"]]))).toBeNull();
  });

  // The 3.5-hour case had the child closed; the neighbouring case would have
  // closed FALSELY on the same inference. Neither is decided here — but an
  // unread child is unknown, and unknown must not read as satisfied.
  test("a child that could not be read blocks the claim rather than passing it", () => {
    expect(closesWhenClaim(parent, new Map())).toBeNull();
  });

  test("with several children, ALL must be closed", () => {
    const two = rec({
      slug: "papercut-p",
      body: "Closes-when: [[papercut-a]], [[papercut-b]]",
    });
    expect(closesWhenClaim(two, new Map([["papercut-a", "fixed"], ["papercut-b", "open"]]))).toBeNull();
    expect(
      closesWhenClaim(two, new Map([["papercut-a", "fixed"], ["papercut-b", "archived"]])),
    ).toEqual({
      children: [
        { slug: "papercut-a", status: "fixed" },
        { slug: "papercut-b", status: "archived" },
      ],
    });
  });

  test("a terminal parent is never a candidate, whatever its children say", () => {
    for (const status of ["verified", "wontfix", "duplicate"]) {
      expect(
        closesWhenClaim(rec({ ...parent, status }), new Map([["papercut-lastgit-child", "verified"]])),
      ).toBeNull();
    }
  });

  test("closed-child statuses span both ledgers' terminal states", () => {
    for (const s of ["fixed", "verified", "wontfix", "duplicate", "archived"])
      expect(CHILD_CLOSED_STATUSES.has(s)).toBe(true);
    for (const s of ["open", "partial", "active", "parked"])
      expect(CHILD_CLOSED_STATUSES.has(s)).toBe(false);
  });

  test("list --body-resolved surfaces the row and carries the child statuses", () => {
    const plain = rec({ slug: "papercut-lastgit-plain", status: "open", body: "nothing here" });
    const rows = buildPapercutList(
      [parent, plain],
      {},
      true,
      new Map([["papercut-lastgit-child", "verified"]]),
    );
    expect(rows.map((r) => r.slug)).toEqual(["papercut-lastgit-parent"]);
    expect(rows[0]!.closes_when).toEqual({
      children: [{ slug: "papercut-lastgit-child", status: "verified" }],
    });
    expect(rows[0]!.body_claim).toBeUndefined();
  });

  test("without --body-resolved the closes_when field is absent and every row is kept", () => {
    const rows = buildPapercutList([parent], {}, false, new Map([["papercut-lastgit-child", "verified"]]));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.closes_when).toBeUndefined();
  });

  test("the method line says the child's FIX must still be read", () => {
    expect(LIST_METHOD_BODY_RESOLVED).toContain("Closes-when");
    expect(LIST_METHOD_BODY_RESOLVED).toContain("child's FIX");
  });
});
