// A design's body must render even when the child-task projection cannot be
// read — and the `tasks:` line must say UNAVAILABLE, never `(none)`.
//
// Regression origin: on 2026-08-08 the ChildTaskIndex schema was registered
// without its completeness marker, and for ~17 hours `fbrain get <design>`
// failed for EVERY design record. The body is a point get on the primary key;
// it never needed that projection. Brain:
// `papercut-brain-get-fails-for-every-design-record-child-task-index-not-marked-complete`.
//
// The other half of the contract is just as load-bearing: the delete cascade
// guard must KEEP failing closed, or a design could be deleted because its
// children were invisible.

import { describe, expect, test } from "bun:test";
import { FbrainError } from "../../src/client.ts";
import {
  CHILD_TASK_INDEX_INCOMPLETE_CODE,
  isChildTaskIndexIncomplete,
} from "../../src/child-task-index.ts";
import { formatRecord, recordToJson } from "../../src/commands/get.ts";
import type { FbrainRecord } from "../../src/record.ts";

const DESIGN: FbrainRecord = {
  slug: "design-a",
  title: "Design A",
  body: "the body that must survive an unreadable projection",
  status: "active",
  tags: [],
  created_at: "2026-08-08T00:00:00Z",
  updated_at: "2026-08-08T00:00:00Z",
};

const UNAVAILABLE = "Run `fbrain reindex --child-task-index` (admin/offline)";

describe("design get degrades when the child-task index is unreadable", () => {
  test("the incomplete-index condition is recognised by code, not by message text", () => {
    const err = new FbrainError({
      code: CHILD_TASK_INDEX_INCOMPLETE_CODE,
      message: "…",
    });
    expect(isChildTaskIndexIncomplete(err)).toBe(true);
    // Any other failure must NOT be swallowed as "unavailable" — the display
    // path only degrades for this one recognised condition.
    expect(
      isChildTaskIndexIncomplete(new FbrainError({ code: "node_unreachable", message: "…" })),
    ).toBe(false);
    expect(isChildTaskIndexIncomplete(new Error("boom"))).toBe(false);
  });

  test("human output renders the body and marks tasks unavailable", () => {
    const out = formatRecord(DESIGN, "design", false, undefined, undefined, UNAVAILABLE);
    expect(out).toContain("the body that must survive an unreadable projection");
    expect(out).toContain("tasks:      (unavailable");
    expect(out).toContain("fbrain reindex --child-task-index");
    // The regression this test exists to prevent: claiming the design has no
    // children when we simply could not look.
    expect(out).not.toContain("tasks:      (none)");
  });

  test("unavailable and empty are different renderings, not the same one", () => {
    const empty = formatRecord(DESIGN, "design", false, [], undefined, undefined);
    const unavailable = formatRecord(DESIGN, "design", false, undefined, undefined, UNAVAILABLE);
    expect(empty).toContain("tasks:      (none)");
    expect(unavailable).not.toBe(empty);
  });

  test("json surface carries children_unavailable and omits children", () => {
    const json = recordToJson(DESIGN, "design", false, undefined, undefined, UNAVAILABLE);
    expect(json.children_unavailable).toContain("fbrain reindex --child-task-index");
    // A consumer asserting `children.length === 0` must not be handed an empty
    // array it would read as "no children".
    expect(json.children).toBeUndefined();
    expect(json.body).toBe(DESIGN.body);
  });

  test("a readable projection still reports children normally", () => {
    const child: FbrainRecord = {
      slug: "t1",
      title: "T1",
      body: "",
      status: "open",
      tags: [],
      design_slug: "design-a",
      created_at: "2026-08-08T00:00:00Z",
      updated_at: "2026-08-08T00:00:00Z",
    };
    const json = recordToJson(DESIGN, "design", false, [child], undefined, undefined);
    expect(json.children).toEqual([{ slug: "t1", status: "open" }]);
    expect(json.children_unavailable).toBeUndefined();
    expect(formatRecord(DESIGN, "design", false, [child], undefined, undefined)).toContain(
      "tasks:      t1 (open)",
    );
  });
});
