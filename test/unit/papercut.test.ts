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
  ensurePapercutStatus,
  ensureSeverity,
  ensureVerificationEvidence,
  isLivePapercutStatus,
  normalizeSymptom,
  symptomHash,
} from "../../src/papercut.ts";
import {
  buildCensus,
  findDuplicateCandidates,
  similarity,
  NEAR_DUPLICATE_THRESHOLD,
} from "../../src/commands/papercut.ts";
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
  test("a changed measurement does not collide on the hash (the similarity net catches it)", () => {
    expect(symptomHash("lastgit", "70 of 84 packs fetch 404")).not.toBe(
      symptomHash("lastgit", "71 of 84 packs fetch 404"),
    );
    expect(normalizeSymptom("70 of 84 packs fetch 404")).toBe("70 of 84 packs fetch 404");
  });
});

describe("the dedupe gate", () => {
  const existing = [
    rec({
      slug: "papercut-lastgit-sweep-skips-pointer-rows",
      title: "the durability sweep skips every pack row carrying a file pointer",
      body: "repair --backfill-file-blobs never dereferences a pointer",
      symptom_hash: symptomHash("lastgit", "the durability sweep skips pointer rows"),
      status: "open",
    }),
  ];

  test("an exact symptom-hash match blocks the file", () => {
    const hits = findDuplicateCandidates(existing, {
      component: "lastgit",
      symptom: "the durability sweep skips pointer rows",
      hash: symptomHash("lastgit", "the durability sweep skips pointer rows"),
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.exact).toBe(true);
  });

  // The failure this exists for: on 2026-08-04 the same defect was filed twice,
  // two hours apart, by different runs. Two agents describing one defect
  // paraphrase — so a hash alone would not have caught it.
  test("a paraphrase with no hash match still blocks the file", () => {
    const symptom = "the durability sweep skips every pack row that carries a file pointer";
    const hits = findDuplicateCandidates(existing, {
      component: "lastgit",
      symptom,
      hash: symptomHash("lastgit", symptom),
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.exact).toBe(false);
    expect(hits[0]!.score).toBeGreaterThanOrEqual(NEAR_DUPLICATE_THRESHOLD);
  });

  test("a genuinely different defect in the same component does not block", () => {
    const symptom = "ci watch replays the whole ref-event partition on every restart";
    const hits = findDuplicateCandidates(existing, {
      component: "lastgit",
      symptom,
      hash: symptomHash("lastgit", symptom),
    });
    expect(hits).toEqual([]);
  });

  test("the same symptom in a different component does not block", () => {
    const symptom = "the durability sweep skips pointer rows";
    const hits = findDuplicateCandidates(existing, {
      component: "kanban",
      symptom,
      hash: symptomHash("kanban", symptom),
    });
    expect(hits).toEqual([]);
  });

  // A verified papercut coming back is a REGRESSION and deserves its own
  // record. Folding it into the closed one would hide the regression inside a
  // record whose status says the defect is gone.
  test("a terminal papercut never blocks a new filing", () => {
    for (const status of ["verified", "wontfix", "duplicate"]) {
      const closed = [rec({ ...existing[0]!, status } as Partial<FbrainRecord> & { slug: string })];
      const hits = findDuplicateCandidates(closed, {
        component: "lastgit",
        symptom: "the durability sweep skips pointer rows",
        hash: symptomHash("lastgit", "the durability sweep skips pointer rows"),
      });
      expect(hits, `status ${status} should not gate`).toEqual([]);
    }
  });

  test("similarity is symmetric and bounded", () => {
    const a = "the sweep skips pointer rows entirely";
    const b = "the sweep skips every pointer row it finds";
    expect(similarity(a, b)).toBeCloseTo(similarity(b, a), 10);
    expect(similarity(a, a)).toBe(1);
    expect(similarity(a, "")).toBe(0);
  });

  // REGRESSION. The first implementation used Jaccard, which divides by the
  // union — so every extra token of evidence in the stored record pushed the
  // score down, and a well-documented papercut was HARDER to match than a terse
  // one. Measured on this exact pair: 0.750 against the title, 0.529 against
  // title+body, with the gate at 0.6. The duplicate would have been filed.
  test("a long evidence body does not make a record harder to match", () => {
    const short = rec({
      slug: "short",
      title: "the durability sweep skips every pack row carrying a file pointer",
      body: "Symptom: the durability sweep skips pointer rows\n",
      status: "open",
    });
    const documented = rec({
      slug: "documented",
      title: "the durability sweep skips every pack row carrying a file pointer",
      body:
        "Symptom: the durability sweep skips pointer rows\n\n" +
        "repair --backfill-file-blobs never dereferences a pointer. brain is typical: " +
        "84 of 84 packs in its covering set carry a pointer, 70 fetch HTTP 404, and the " +
        "sweep answered noop skipped=94 unrecoverable=0 for a repo that cannot be cloned " +
        "at all. Root cause is node-side: the file-blob plane accepts writes it cannot " +
        "serve back, uncorrelated with size, generation or state.\n",
      status: "open",
    });
    const symptom = "the durability sweep skips every pack row that carries a file pointer";
    const hash = symptomHash("lastgit", symptom);
    const hitShort = findDuplicateCandidates([short], { component: "lastgit", symptom, hash });
    const hitLong = findDuplicateCandidates([documented], { component: "lastgit", symptom, hash });
    expect(hitShort).toHaveLength(1);
    expect(hitLong).toHaveLength(1);
    expect(hitLong[0]!.score).toBeCloseTo(hitShort[0]!.score, 10);
  });

  // The floor that makes dividing by the shorter side safe.
  test("a handful of shared common words does not block an unrelated filing", () => {
    const existing = [
      rec({
        slug: "long-record",
        title: "the durability sweep skips every pack row carrying a file pointer to the cas",
        body: "Symptom: the durability sweep skips pointer rows\n",
        status: "open",
      }),
    ];
    const symptom = "the cas";
    const hits = findDuplicateCandidates(existing, {
      component: "lastgit",
      symptom,
      hash: symptomHash("lastgit", symptom),
    });
    expect(hits).toEqual([]);
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
