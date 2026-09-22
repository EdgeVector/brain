// Pins the 2026-09-22 brain CLI authoring papercut fixes.
import { describe, expect, test } from "bun:test";

import { FbrainError } from "../../src/client.ts";
import { parseFrontmatter } from "../../src/commands/put.ts";
import { ensureKind } from "../../src/papercut.ts";
import { normalizeStatus, validateSlug } from "../../src/record.ts";

describe("frontmatter leading whitespace", () => {
  test("a stray leading space on a top-level key is accepted", () => {
    const fm = parseFrontmatter("type: reference\ntitle: Closeout\nstatus: archived\n tags: [closeout, kanban-pickup]");
    expect(fm.tags).toEqual(["closeout", "kanban-pickup"]);
    expect(fm.status).toBe("archived");
  });

  test("an indented key inside an open block list still refuses, with a clear hint", () => {
    try {
      parseFrontmatter("tags:\n  - a\n  slug: nested");
      throw new Error("expected refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(FbrainError);
      expect((err as FbrainError).hint).toContain("column 0");
    }
  });
});

describe("status aliases", () => {
  test("complete on a reference maps to archived", () => {
    expect(normalizeStatus("reference", "complete")).toBe("archived");
    expect(normalizeStatus("design", "proposed")).toBe("draft");
    expect(normalizeStatus("reference", "active")).toBe("active");
    expect(normalizeStatus("reference", "bogus")).toBe("bogus");
  });
});

describe("slug uppercase hint", () => {
  test("an uppercase ISO timestamp names the lowercase slug", () => {
    try {
      validateSlug("closeout-w6-20260921T183748Z");
      throw new Error("expected refusal");
    } catch (err) {
      expect((err as FbrainError).hint).toContain("closeout-w6-20260921t183748z");
    }
  });
});

describe("papercut kind", () => {
  test("needs-human refuses with a pointer to the kanban block status", () => {
    try {
      ensureKind("needs-human");
      throw new Error("expected refusal");
    } catch (err) {
      expect((err as FbrainError).hint).toContain("--block-status needs_human");
    }
    expect(ensureKind("Complaint")).toBe("complaint");
  });
});
