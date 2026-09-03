// Tests for the typed papercut ledger.
//
// Each block below pins one of the measured prose-ledger failures shut. The
// citations are not decoration: they are why the assertion is worth its line.

import { describe, expect, test } from "bun:test";
import { FbrainError } from "../../src/client.ts";
import {
  ensureComponent,
  ensureDuplicateTarget,
  ensureKind,
  ensurePapercutSlug,
  ensurePapercutStatus,
  ensureSeverity,
  ensureVerificationEvidence,
  isLivePapercutStatus,
  normalizeSymptom,
  symptomHash,
} from "../../src/papercut.ts";
import {
  buildCensus,
  buildPapercutList,
  elide,
  LIST_MARK_MAX,
  LIST_INDEX_ONLY_METHOD,
  LIST_METHOD,
  isIdempotentPapercutFile,
  papercutCloseCmd,
  papercutFileCmd,
  papercutDedupeProbes,
  partitionWaivedCandidates,
  semanticDuplicateCandidates,
  SEMANTIC_DUPLICATE_FETCH_LIMIT,
  SEMANTIC_DUPLICATE_LIMIT,
  SEMANTIC_DUPLICATE_THRESHOLD,
} from "../../src/commands/papercut.ts";
import type { FindHit } from "../../src/commands/find.ts";
import type { FbrainRecord } from "../../src/record.ts";
import { RECORDS, PAPERCUT_STATUSES } from "../../src/schemas.ts";

function rec(over: Partial<FbrainRecord> & { slug: string }): FbrainRecord {
  return {
    title: "",
    body: "",
    status: "open",
    tags: [],
    created_at: "2026-08-06T00:00:00.000Z",
    updated_at: "2026-08-06T00:00:00.000Z",
    component: "lastgit",
    repo: "",
    severity: "p2",
    kind: "complaint",
    symptom_hash: "",
    fixed_by: "",
    verified_by: "",
    duplicate_of: "",
    ...over,
  } as FbrainRecord;
}

describe("symptom normalization and hashing", () => {
  test("punctuation, case and whitespace do not change the key", () => {
    const a = symptomHash("lastgit", "The sweep reports noop for a repo that cannot be cloned.");
    const b = symptomHash("lastgit", "the   sweep REPORTS noop, for a repo that cannot be cloned!!");
    expect(a).toBe(b);
  });

  test("the same sentence about two components stays two records", () => {
    expect(symptomHash("lastgit", "the count is wrong")).not.toBe(
      symptomHash("kanban", "the count is wrong"),
    );
  });

  // Deliberate design choice, documented in normalizeSymptom: digits are kept,
  // so a drifting measurement UNDER-collides rather than over-collides. An
  // over-collision would silently fold two real defects into one record.
  test("a changed measurement does not collide on the hash (the semantic net catches it)", () => {
    expect(symptomHash("lastgit", "70 of 84 packs fetch 404")).not.toBe(
      symptomHash("lastgit", "71 of 84 packs fetch 404"),
    );
    expect(normalizeSymptom("70 of 84 packs fetch 404")).toBe("70 of 84 packs fetch 404");
  });
});

describe("the dedupe gate", () => {
  function hit(record: FbrainRecord, maxSimilarity: number): FindHit {
    return {
      type: "papercut",
      slug: record.slug,
      fusedScore: 0.02,
      maxSimilarity,
      matchHits: [{ idx: 0, rank: 1 }],
      record,
    };
  }

  const existing = rec({
      slug: "papercut-lastgit-sweep-skips-pointer-rows",
      title: "the durability sweep skips every pack row carrying a file pointer",
      body: "Symptom: the durability sweep skips pointer rows",
      symptom_hash: symptomHash("lastgit", "the durability sweep skips pointer rows"),
      status: "open",
    });

  test("an exact slug point-read remains the cheap pre-filter", () => {
    const hits = semanticDuplicateCandidates([hit(existing, 0.01)], {
      component: "lastgit",
      exactSlug: existing.slug,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.exact).toBe(true);
  });

  // The failure this exists for: on 2026-08-04 the same defect was filed twice,
  // two hours apart, by different runs. Two agents describing one defect
  // paraphrase — so a hash alone would not have caught it.
  test("a differently-worded restatement is detected by semantic similarity", () => {
    const hits = semanticDuplicateCandidates([hit(existing, 0.79)], {
      component: "lastgit",
      exactSlug: "papercut-lastgit-backfill-cannot-read-cas-indirections",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.exact).toBe(false);
    expect(hits[0]!.score).toBeGreaterThanOrEqual(SEMANTIC_DUPLICATE_THRESHOLD);
  });

  test("a new defect with a shared slug prefix stays below the floor", () => {
    const hits = semanticDuplicateCandidates([hit(existing, 0.49)], {
      component: "lastgit",
      exactSlug: "papercut-lastgit-sweep-skips-new-unrelated-thing",
    });
    expect(hits).toEqual([]);
  });

  test("the same symptom in a different component does not block", () => {
    const hits = semanticDuplicateCandidates([hit(existing, 0.99)], {
      component: "kanban",
    });
    expect(hits).toEqual([]);
  });

  // A verified papercut coming back is a REGRESSION and deserves its own
  // record. Folding it into the closed one would hide the regression inside a
  // record whose status says the defect is gone.
  test("a terminal papercut never blocks a new filing", () => {
    for (const status of ["verified", "wontfix", "duplicate"]) {
      const closed = rec({ ...existing, status } as Partial<FbrainRecord> & { slug: string });
      const hits = semanticDuplicateCandidates([hit(closed, 0.99)], {
        component: "lastgit",
      });
      expect(hits, `status ${status} should not gate`).toEqual([]);
    }
  });

  test("title, symptom, and an optional error line become separate probes", () => {
    expect(
      papercutDedupeProbes({
        title: "The writer stalls",
        symptom: "writes never finish",
        body: "Observed twice.\nError: deadline exceeded while sealing",
      }),
    ).toEqual([
      "The writer stalls",
      "writes never finish",
      "deadline exceeded while sealing",
    ]);
  });

  test("the file path contains no papercut partition enumeration", () => {
    expect(papercutFileCmd.toString()).not.toContain("listRecords");
  });

  // Measured 2026-08-17 → 2026-09-03 on
  // papercut-brain-papercut-file-token-overlap-refuses-unrelated-claims: one
  // filing cost five full re-sends of the whole --body, revealing two NEW
  // candidates per round. The cause was ordering — `find` sliced to 10 hits
  // across EVERY component, and the component / live-status / --not-duplicate-of
  // filters ran on that slice. So a disclaimed candidate still held a retrieval
  // slot and clearing it only uncovered what the slice had hidden.
  describe("the retrieval pool is spent AFTER the filters, not before", () => {
    test("the fetch pool is wider than the displayed candidate cap", () => {
      expect(SEMANTIC_DUPLICATE_FETCH_LIMIT).toBeGreaterThan(
        SEMANTIC_DUPLICATE_LIMIT,
      );
    });

    // The load-bearing half: every already-cleared slug must buy headroom, or
    // the round-trip count has no upper bound.
    test("each cleared slug widens the fetch so an exclusion frees a slot", () => {
      const src = papercutFileCmd.toString();
      expect(src).toContain("SEMANTIC_DUPLICATE_FETCH_LIMIT + cleared.size");
    });

    test("the refusal states the candidate set is complete", () => {
      const src = papercutFileCmd.toString();
      expect(src).toContain("COMPLETE candidate set");
    });
  });

  // The escape hatch that bounds filing at two invocations. The standing rule
  // is ALWAYS file papercuts; a gate that charges five --body re-sends per
  // record is a standing incentive to skip filing, which is the exact failure
  // the typed ledger exists to prevent.
  describe("--not-duplicate-of-any", () => {
    const candidates = [
      { slug: "papercut-a", title: "a", status: "open", score: 0.78, exact: false },
      { slug: "papercut-b", title: "b", status: "fixed", score: 0.71, exact: false },
    ];

    test("without the flag every candidate still refuses the filing", () => {
      const { duplicates, waived } = partitionWaivedCandidates(candidates, false);
      expect(duplicates).toHaveLength(2);
      expect(waived).toEqual([]);
    });

    test("with the flag the whole set is cleared in ONE call", () => {
      const { duplicates, waived } = partitionWaivedCandidates(candidates, true);
      expect(duplicates).toEqual([]);
      expect(waived).toEqual(["papercut-a", "papercut-b"]);
    });

    // An exact slug match is not a similarity judgement the filer may overrule:
    // it says the record already exists. Waiving it would let the bulk flag
    // become a silent --force over a live record.
    test("an EXACT slug match is never waivable", () => {
      const withExact = [
        ...candidates,
        { slug: "papercut-mine", title: "mine", status: "open", score: 1, exact: true },
      ];
      const { duplicates, waived } = partitionWaivedCandidates(withExact, true);
      expect(duplicates.map((d) => d.slug)).toEqual(["papercut-mine"]);
      expect(waived).not.toContain("papercut-mine");
    });

    // `--force` would leave no trace. The waiver must stay auditable, and a
    // reader must be able to tell it apart from the per-slug form.
    test("the waived slugs are written into the record body", () => {
      const src = papercutFileCmd.toString();
      expect(src).toContain("--not-duplicate-of-any after the gate raised");
      expect(src).toContain("cleared as a set rather than");
    });
  });

  // `fbrain new` and `fbrain put` both announce a cross-type slug collision on
  // a create. `papercut file` did not, and that silence is how 55 slugs came to
  // hold BOTH a `reference` (the pre-2026-08-04 prose record, later archived)
  // and a `papercut` (the typed row, `open`) — measured on the primary
  // 2026-09-01, 55 of 58 in component `lastgit`. Every one was filed through
  // this verb, over an ancestor it never mentioned.
  test("the file path announces a cross-type slug collision, like new and put", () => {
    const src = papercutFileCmd.toString();
    expect(src).toContain("findCrossTypeSlugCollisions");
    expect(src).toContain("crossTypeSlugNote");
  });

  // Pins the note to the CREATE verb. `close` operates on a slug that already
  // exists, so the same note there is noise, not news — and putting it there
  // would leave the create path silent, which is the bug.
  test("the close path does NOT emit the create-time collision note", () => {
    expect(papercutCloseCmd.toString()).not.toContain("crossTypeSlugNote");
  });

  test("an exact replay is idempotent but changed input is still a conflict", () => {
    const existing = rec({
      slug: "papercut-retry",
      title: "same title",
      body: "Symptom: same symptom\n\nsame body\n",
      status: "open",
      component: "brain",
      repo: "EdgeVector/brain",
      severity: "p1",
      kind: "specified-fix",
      symptom_hash: "abc123",
      tags: ["papercut", "brain"],
    });
    const desired = {
      ...existing,
      created_at: "later",
      updated_at: "later",
    };
    expect(isIdempotentPapercutFile(existing, desired)).toBe(true);
    expect(
      isIdempotentPapercutFile(existing, {
        ...desired,
        body: "Symptom: changed\n\nchanged body\n",
      }),
    ).toBe(false);
  });
});

describe("closure guards", () => {
  // The load-bearing one. "Merged" is a fact about a repository; the corpus
  // records at least 12 findings whose shape was merged-but-not-running.
  test("`verified` demands a live check, not a merge reference", () => {
    expect(() => ensureVerificationEvidence("verified", "")).toThrow(FbrainError);
    expect(() => ensureVerificationEvidence("verified", "merged in #242")).toThrow(FbrainError);
    expect(() => ensureVerificationEvidence("verified", "PR #242")).toThrow(FbrainError);
    expect(() =>
      ensureVerificationEvidence(
        "verified",
        "re-ran the sweep on brain: dangling=31, was dangling=unchecked",
      ),
    ).not.toThrow();
  });

  test("`fixed` does not demand verification evidence", () => {
    expect(() => ensureVerificationEvidence("fixed", "")).not.toThrow();
  });

  test("`duplicate` demands a target", () => {
    expect(() => ensureDuplicateTarget("duplicate", "")).toThrow(FbrainError);
    expect(() => ensureDuplicateTarget("duplicate", "papercut-lastgit-other")).not.toThrow();
    expect(() => ensureDuplicateTarget("open", "")).not.toThrow();
  });
});

describe("field validation", () => {
  test("component must be a bare lowercase token", () => {
    expect(ensureComponent("lastgit")).toBe("lastgit");
    expect(ensureComponent(" last-gitistan ")).toBe("last-gitistan");
    for (const bad of ["LastGit", "last gitistan", "3lastgit", "papercut-lastgit-thing", ""]) {
      expect(() => ensureComponent(bad), `should reject: ${bad}`).toThrow(FbrainError);
    }
  });

  test("file slug must start with papercut-", () => {
    expect(ensurePapercutSlug("papercut-brain-example")).toBe("papercut-brain-example");
    for (const bad of [
      "brain-papercut-file-token-overlap-refuses-unrelated-claims",
      "portal-wt-start-help-creates-a-worktree",
      "papercut-",
      "",
    ]) {
      expect(() => ensurePapercutSlug(bad), `should reject: ${bad}`).toThrow(FbrainError);
    }
  });

  test("severity, kind and status are enum-checked", () => {
    expect(ensureSeverity("p1")).toBe("p1");
    expect(() => ensureSeverity("P1")).toThrow(FbrainError);
    expect(() => ensureSeverity("high")).toThrow(FbrainError);
    expect(ensureKind("specified-fix")).toBe("specified-fix");
    expect(() => ensureKind("proposal")).toThrow(FbrainError);
    expect(ensurePapercutStatus("partial")).toBe("partial");
    expect(() => ensurePapercutStatus("OPEN")).toThrow(FbrainError);
  });

  test("live vs terminal partitions the status enum exactly", () => {
    const live = PAPERCUT_STATUSES.filter(isLivePapercutStatus);
    const terminal = PAPERCUT_STATUSES.filter((s) => !isLivePapercutStatus(s));
    expect(live).toEqual(["open", "partial", "fixed"]);
    expect(terminal).toEqual(["verified", "wontfix", "duplicate"]);
  });
});

describe("census", () => {
  const records = [
    rec({ slug: "a", component: "lastgit", status: "open" }),
    rec({ slug: "b", component: "lastgit", status: "fixed" }),
    rec({ slug: "c", component: "lastgit", status: "verified" }),
    rec({ slug: "d", component: "kanban", status: "open" }),
    rec({ slug: "e", component: "", status: "open" }),
  ];

  test("groups by component and separates live from total", () => {
    const rows = buildCensus(records);
    const lastgit = rows.find((r) => r.component === "lastgit")!;
    expect(lastgit.total).toBe(3);
    expect(lastgit.live).toBe(2); // open + fixed; `verified` is terminal
    expect(lastgit.verified).toBe(1);
  });

  // A record with no component is the exact shape the slug-prefix ledger hid.
  // It must be visible as its own bucket, never silently dropped from a count.
  test("an unset component gets its own visible bucket", () => {
    const rows = buildCensus(records);
    expect(rows.find((r) => r.component === "(unset)")?.total).toBe(1);
  });

  test("filters to one component when asked", () => {
    const rows = buildCensus(records, "kanban");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.component).toBe("kanban");
  });

  // An unknown status still lands in `total`, so the per-status columns can
  // never quietly sum to less than the total without the total disagreeing.
  test("an unknown status is counted in total even with no column for it", () => {
    const rows = buildCensus([rec({ slug: "x", component: "lastgit", status: "mystery" })]);
    expect(rows[0]!.total).toBe(1);
    expect(rows[0]!.open).toBe(0);
    expect(rows[0]!.live).toBe(0);
  });
});

// `papercut list` is the only reader that yields SLUGS, and both of its
// defects below were measured on the live primary on 2026-08-17, two days
// after the reader shipped:
//
//   * `papercut list lastdb --json` returned 20 rows of which 8 were
//     kanban/lastgit/fold/pipeline — the <component> positional was parsed and
//     then never passed on, because the command delegated to the generic record
//     lister, which has no component filter at all.
//   * The same call reported `total: 630` for EVERY component (lastdb, brain,
//     routines, disk), that being the unfiltered papercut count.
//   * The projection served 7 generic columns and dropped `component`,
//     `severity`, `kind`, `repo`, `fixed_by`, `verified_by`, `symptom_hash`
//     and `duplicate_of` with no partial-projection marker — the exact fields
//     the shared hygiene procedure tells every routine to audit.
describe("list", () => {
  const records = [
    rec({ slug: "b-old", component: "lastdb", status: "open", updated_at: "2026-08-01T00:00:00.000Z" }),
    rec({ slug: "a-new", component: "lastdb", status: "fixed", updated_at: "2026-08-09T00:00:00.000Z", fixed_by: "fold #1197" }),
    rec({ slug: "c-mid", component: "lastdb", status: "open", updated_at: "2026-08-05T00:00:00.000Z" }),
    rec({ slug: "d", component: "kanban", status: "open" }),
    rec({ slug: "e", component: "", status: "open" }),
  ];

  test("filters to the named component instead of ignoring it", () => {
    const rows = buildPapercutList(records, { component: "lastdb" });
    expect(rows.map((r) => r.slug).sort()).toEqual(["a-new", "b-old", "c-mid"]);
    expect(rows.every((r) => r.component === "lastdb")).toBe(true);
  });

  // The regression that mattered: a component filter that lets other
  // components through turns a family ledger into a cross-family sample.
  test("no foreign component survives the filter", () => {
    const rows = buildPapercutList(records, { component: "lastdb" });
    expect(rows.some((r) => r.component === "kanban")).toBe(false);
    expect(rows.some((r) => r.component === "(unset)")).toBe(false);
  });

  test("an unset component is addressable as its own bucket", () => {
    const rows = buildPapercutList(records, { component: "(unset)" });
    expect(rows.map((r) => r.slug)).toEqual(["e"]);
  });

  test("component and status filters compose", () => {
    const rows = buildPapercutList(records, {
      component: "lastdb",
      status: "open",
    });
    expect(rows.map((r) => r.slug)).toEqual(["b-old", "c-mid"]);
  });

  // The reconcile loop consumes "the two oldest active records"; serving it
  // newest-first is what made it need a second reader.
  test("orders oldest-updated first", () => {
    const rows = buildPapercutList(records, { component: "lastdb" });
    expect(rows.map((r) => r.slug)).toEqual(["b-old", "c-mid", "a-new"]);
  });

  test("ties break on slug so the order is total, not arbitrary", () => {
    const same = "2026-08-04T00:00:00.000Z";
    const rows = buildPapercutList([
      rec({ slug: "z", component: "lastdb", updated_at: same }),
      rec({ slug: "y", component: "lastdb", updated_at: same }),
    ]);
    expect(rows.map((r) => r.slug)).toEqual(["y", "z"]);
  });

  // Every field a closure audit reads must survive the projection. A missing
  // field reads as an empty one, which is how "no routine populates
  // verified_by" gets concluded from a reader that never served it.
  test("carries every stored header field, not a generic 7-column subset", () => {
    const [row] = buildPapercutList([
      rec({
        slug: "s",
        component: "lastdb",
        severity: "p1",
        kind: "specified-fix",
        repo: "EdgeVector/fold",
        fixed_by: "fold #1197",
        verified_by: "GET /api/status over the socket this run",
        duplicate_of: "other-slug",
        symptom_hash: "deadbeef",
      }),
    ]);
    expect(row).toMatchObject({
      component: "lastdb",
      severity: "p1",
      kind: "specified-fix",
      repo: "EdgeVector/fold",
      fixed_by: "fold #1197",
      verified_by: "GET /api/status over the socket this run",
      duplicate_of: "other-slug",
      symptom_hash: "deadbeef",
    });
  });

  test("an absent optional field is an empty string, never undefined", () => {
    const [row] = buildPapercutList([rec({ slug: "s", component: "lastdb" })]);
    expect(row!.fixed_by).toBe("");
    expect(row!.verified_by).toBe("");
    expect(row!.tags).toEqual([]);
  });

  // list and census read the same records, so a component's row count here and
  // its `total` there are the same number by construction.
  test("row count agrees with the census total for the same component", () => {
    const rows = buildPapercutList(records, { component: "lastdb" });
    const census = buildCensus(records, "lastdb");
    expect(rows).toHaveLength(census[0]!.total);
  });

  test("no filter returns the whole ledger", () => {
    expect(buildPapercutList(records)).toHaveLength(records.length);
  });

  // The method line is the honesty contract; the old reader's hint named a
  // `-n N` flag its own strict parser rejected.
  test("the method line states that the filters were applied", () => {
    expect(LIST_METHOD).toContain("filters applied");
    expect(LIST_METHOD).toContain("every matching row");
    expect(LIST_METHOD).toContain("batched hydrate");
  });

  // The index-only line must name what it skipped, and must still identify
  // itself as the status-keyed index so queue consumers that pin that phrase
  // accept it.
  test("the index-only method line says the rows were not hydrated", () => {
    expect(LIST_INDEX_ONLY_METHOD).toContain("status-keyed papercut index");
    expect(LIST_INDEX_ONLY_METHOD).toContain("index-only");
    expect(LIST_INDEX_ONLY_METHOD).toContain("not hydrated");
    expect(LIST_INDEX_ONLY_METHOD).toContain("not re-verified");
    expect(LIST_INDEX_ONLY_METHOD).not.toContain("batched hydrate");
  });

  // Human mode only. A `verified_by` transcript is meant to be long; eliding it
  // in --json would defeat the audit the field exists for.
  test("elide flattens and caps, and leaves short values untouched", () => {
    expect(elide("fold #1197")).toBe("fold #1197");
    expect(elide("a\n  b\tc")).toBe("a b c");
    const long = "x".repeat(LIST_MARK_MAX + 50);
    expect(elide(long)).toHaveLength(LIST_MARK_MAX);
    expect(elide(long).endsWith("…")).toBe(true);
  });
});

describe("schema shape", () => {
  test("every typed column the CLI writes exists on the schema", () => {
    const fields = new Set(RECORDS.papercut.schema.schema.fields);
    for (const f of RECORDS.papercut.extraStringFields ?? []) {
      expect(fields.has(f), `schema is missing extra field ${f}`).toBe(true);
    }
    for (const f of ["slug", "title", "body", "status", "tags", "created_at", "updated_at"]) {
      expect(fields.has(f), `schema is missing envelope field ${f}`).toBe(true);
    }
  });

  test("papercut has no `new` verb — filing goes through the dedupe gate", async () => {
    const { TYPES_WITHOUT_NEW_VERB } = await import("../../src/schemas.ts");
    expect(TYPES_WITHOUT_NEW_VERB.has("papercut")).toBe(true);
  });

  test("default status is open", () => {
    expect(RECORDS.papercut.defaultStatus).toBe("open");
  });
});
