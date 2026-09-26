// `brain papercut set` — the verb that amends a header column after a filing.
//
// Why it exists, measured 2026-09-26: a papercut filed without `--kind` keeps
// `kind: complaint` forever. `papercut file` refuses a second call on the same
// slug (the dedupe gate reports an EXACT self-match — correct, the row IS a
// duplicate of itself) and `papercut close` writes only the closure columns.
// So the row never appears in `papercut list --status open --kind
// specified-fix`, which is the cheapest triage query there is, and the
// correction has to live as prose in the body where no filter can read it.
//
// The decision half of the verb is pure on purpose, so these guards need no
// node: which requested columns move, which already hold the value, and what
// the audit line says.
import { describe, expect, test } from "bun:test";
import { FbrainError } from "../../src/client.ts";
import {
  PAPERCUT_HEADER_COLUMNS,
  normalizePapercutHeaderValue,
  papercutHeaderAuditLine,
  planPapercutHeaderAmend,
  renderPapercutHeaderChange,
  papercutSetCmd,
} from "../../src/commands/papercut.ts";
import {
  PAPERCUT_FLAGS_BY_SUBCOMMAND,
  PAPERCUT_SUBCOMMANDS,
  assertPapercutFlagsConsumed,
} from "../../src/cli.ts";
import type { FbrainRecord } from "../../src/record.ts";

function row(over: Partial<FbrainRecord> = {}): FbrainRecord {
  return {
    slug: "papercut-x",
    title: "t",
    body: "Symptom: a thing\n\nsome evidence",
    status: "open",
    tags: [],
    created_at: "2026-09-26T00:00:00.000Z",
    updated_at: "2026-09-26T00:00:00.000Z",
    component: "brain-papercut",
    repo: "",
    severity: "p2",
    kind: "complaint",
    symptom_hash: "abc",
    fixed_by: "",
    verified_by: "",
    duplicate_of: "",
    ...over,
  } as FbrainRecord;
}

describe("planPapercutHeaderAmend", () => {
  // The exact defect the verb was filed for.
  test("moves kind and repo off a filing that omitted both", () => {
    const plan = planPapercutHeaderAmend(row(), {
      kind: "specified-fix",
      repo: "EdgeVector/brain",
    });
    expect(plan.changes).toEqual([
      { field: "kind", from: "complaint", to: "specified-fix" },
      { field: "repo", from: "", to: "EdgeVector/brain" },
    ]);
    expect(plan.unchanged).toEqual([]);
  });

  // A no-op write is not free: it bumps `updated_at`, and `papercut list` is
  // ordered oldest-updated-first, so it would move the row to the back of the
  // triage queue this verb exists to feed.
  test("a column already holding the value is unchanged, not a change", () => {
    const plan = planPapercutHeaderAmend(row(), {
      kind: "complaint",
      severity: "p2",
    });
    expect(plan.changes).toEqual([]);
    expect(plan.unchanged).toEqual(["kind", "severity"]);
  });

  test("reports the moved and the already-correct column separately", () => {
    const plan = planPapercutHeaderAmend(row(), {
      kind: "specified-fix",
      severity: "p2",
    });
    expect(plan.changes.map((c) => c.field)).toEqual(["kind"]);
    expect(plan.unchanged).toEqual(["severity"]);
  });

  test("a column not requested is never touched", () => {
    const plan = planPapercutHeaderAmend(row(), { severity: "p1" });
    expect(plan.changes.map((c) => c.field)).toEqual(["severity"]);
    expect(plan.unchanged).toEqual([]);
  });

  // The plan is the whole decision, so it must refuse a bad value before any
  // write is planned rather than storing a string no filter matches.
  test("refuses an invalid kind and an invalid severity", () => {
    expect(() => planPapercutHeaderAmend(row(), { kind: "fix" })).toThrow(
      FbrainError,
    );
    expect(() => planPapercutHeaderAmend(row(), { severity: "p9" })).toThrow(
      FbrainError,
    );
  });

  // Same normalisation as `papercut file`, or the same string would be
  // accepted at filing time and refused (or stored differently) at amend time.
  test("normalises the way file does", () => {
    expect(normalizePapercutHeaderValue("kind", "Specified_Fix")).toBe(
      "specified-fix",
    );
    expect(normalizePapercutHeaderValue("component", "LastDB_UDS")).toBe(
      "lastdb-uds",
    );
    // `repo` is free-form on `file`, so it is free-form here too — trimmed only.
    expect(normalizePapercutHeaderValue("repo", "  EdgeVector/brain ")).toBe(
      "EdgeVector/brain",
    );
  });

  test("a normalised value equal to the stored one is unchanged", () => {
    const plan = planPapercutHeaderAmend(row({ component: "lastdb-uds" }), {
      component: "LastDB_UDS",
    });
    expect(plan.changes).toEqual([]);
    expect(plan.unchanged).toEqual(["component"]);
  });
});

describe("the audit line", () => {
  // A header rewrite is durable and leaves no diff: without this line a reader
  // who finds kind=specified-fix on a row filed as complaint cannot tell it
  // was amended, when, or from what.
  test("names every column that moved, with both values", () => {
    const line = papercutHeaderAuditLine(
      [
        { field: "kind", from: "complaint", to: "specified-fix" },
        { field: "repo", from: "", to: "EdgeVector/brain" },
      ],
      "2026-09-26T09:00:00.000Z",
    );
    expect(line).toBe(
      "Header-amended 2026-09-26T09:00:00.000Z: kind complaint → specified-fix, repo (none) → EdgeVector/brain",
    );
  });

  test("an empty stored value renders as (none), not as nothing", () => {
    expect(
      renderPapercutHeaderChange({ field: "repo", from: "", to: "EdgeVector/brain" }),
    ).toBe("repo (none) → EdgeVector/brain");
  });
});

describe("what set is NOT allowed to write", () => {
  // A header amender that could also flip status would be a status launderer
  // with no evidence flag. `close` owns the closure columns because a status
  // move must carry evidence.
  test("the header column set excludes status and the closure columns", () => {
    for (const forbidden of [
      "status",
      "fixed_by",
      "verified_by",
      "duplicate_of",
      "symptom_hash",
      "body",
      "title",
    ]) {
      expect(
        (PAPERCUT_HEADER_COLUMNS as readonly string[]).includes(forbidden),
      ).toBe(false);
    }
  });

  test("the CLI does not hand set a status or evidence flag", () => {
    const flags = PAPERCUT_FLAGS_BY_SUBCOMMAND.set ?? [];
    expect(flags).not.toContain("status");
    expect(flags).not.toContain("evidence");
    expect(flags).not.toContain("body");
    expect(() =>
      assertPapercutFlagsConsumed("set", { status: "verified" }),
    ).toThrow(FbrainError);
  });

  test("set is a registered subcommand with a declared flag set", () => {
    expect([...PAPERCUT_SUBCOMMANDS]).toContain("set");
    expect(PAPERCUT_FLAGS_BY_SUBCOMMAND.set).toBeDefined();
    for (const f of ["kind", "repo", "severity", "component"]) {
      expect(PAPERCUT_FLAGS_BY_SUBCOMMAND.set).toContain(f);
    }
  });
});

describe("papercutSetCmd", () => {
  // The refusal happens before `newWriteClientFromCfg`, so this needs no node:
  // a call with no header flag would otherwise resolve the slug and write
  // nothing but a fresh `updated_at`.
  test("refuses a call that requests no column at all", async () => {
    await expect(
      papercutSetCmd({ cfg: {} as never, slug: "papercut-x" }),
    ).rejects.toThrow(/requires at least one of/);
  });

  // The index snapshot is what `papercut list --kind …` pre-selects candidates
  // on, so an amend that bypassed the shared write plan would move the column
  // and leave the row absent from the query the verb exists to make it appear
  // in.
  test("writes through the resident write plan, which patches the status index", () => {
    const src = papercutSetCmd.toString();
    expect(src).toContain("buildResidentWritePlan");
    expect(src).toContain("commitResidentWritePlan");
  });
});

describe("a bad value is refused before the node is touched", () => {
  // The planner validates, but it runs after `resolveBySlug`. Without an
  // up-front pass a typo'd `--kind` costs a point read and then reports
  // not_found for the SLUG, which reads as "the row is missing" rather than
  // "the value is wrong". Measured 2026-09-26 on the first build of this verb:
  //   brain papercut set <any-slug> --kind fix
  //     -> error: No record with slug "<any-slug>".
  test("an invalid kind throws about the kind, not about the slug", async () => {
    await expect(
      papercutSetCmd({ cfg: {} as never, slug: "papercut-x", kind: "fix" }),
    ).rejects.toThrow(/Invalid --kind/);
  });

  test("an invalid severity throws about the severity", async () => {
    await expect(
      papercutSetCmd({ cfg: {} as never, slug: "papercut-x", severity: "p9" }),
    ).rejects.toThrow(/Invalid --severity/);
  });
});
