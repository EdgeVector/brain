import { describe, expect, test } from "bun:test";

import {
  parseFieldProjection,
  renderProjectedValue,
  resolveField,
} from "../../src/field-projection.ts";

describe("field projection helpers", () => {
  test("accepts repeated and comma-separated fields", () => {
    expect(parseFieldProjection(["slug,status", "tags[0]"])).toEqual([
      "slug",
      "status",
      "tags[0]",
    ]);
  });

  test("resolves dot paths and bracket array indexes", () => {
    const row = {
      slug: "s1",
      extra_fields: { program: "p1" },
      linked_from: [{ slug: "parent" }],
      tags: ["a", "b"],
    };

    expect(resolveField(row, "extra_fields.program")).toBe("p1");
    expect(resolveField(row, "linked_from[0].slug")).toBe("parent");
    expect(resolveField(row, "tags[1]")).toBe("b");
  });

  test("renders scalar arrays as comma-joined plain values", () => {
    expect(renderProjectedValue(["a", "b"])).toBe("a,b");
  });
});
