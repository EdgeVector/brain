// JCS golden-vector tests. These MUST match the Rust app_identity_crypto
// golden vectors byte-for-byte (fold/app_identity_crypto/tests/golden_vectors.rs)
// — the capability token's envelope payload_hash is sha256(JCS(payload)), so
// any drift between the TS and Rust canonicalizers breaks fbrain's integrity
// check (and would break signing if fbrain ever signed).

import { describe, expect, test } from "bun:test";

import { canonicalize, canonicalizeBytes, JcsError, type JsonValue } from "../../src/jcs.ts";

// The 12 cases mirror jcs_cases() in golden_vectors.rs verbatim.
const GOLDEN: Array<{ name: string; input: JsonValue; expected: string }> = [
  { name: "empty object", input: {}, expected: "{}" },
  { name: "empty array", input: [], expected: "[]" },
  { name: "null value", input: { n: null }, expected: '{"n":null}' },
  {
    name: "key ordering — lexicographic by code unit",
    input: { b: 1, a: 2, c: 3 },
    expected: '{"a":2,"b":1,"c":3}',
  },
  {
    name: "nested object — recursive key sort",
    input: { outer: { z: 1, a: 2 }, first: 0 },
    expected: '{"first":0,"outer":{"a":2,"z":1}}',
  },
  {
    name: "unicode — string passes through as UTF-8 not \\u-escaped",
    input: { k: "café — 漢字" },
    expected: '{"k":"café — 漢字"}',
  },
  {
    name: "control char — must be \\u-escaped (short form)",
    input: { k: "a\nb" },
    expected: '{"k":"a\\nb"}',
  },
  { name: "integer", input: { n: 42 }, expected: '{"n":42}' },
  { name: "negative integer", input: { n: -17 }, expected: '{"n":-17}' },
  { name: "float — round value", input: { n: 1.5 }, expected: '{"n":1.5}' },
  { name: "float — scientific input normalizes", input: { n: 1.0e2 }, expected: '{"n":100}' },
  {
    name: "deeply nested",
    input: { a: { b: { c: { d: 1 } } }, z: [3, 2, 1] },
    expected: '{"a":{"b":{"c":{"d":1}}},"z":[3,2,1]}',
  },
];

describe("JCS golden vectors (must match Rust app_identity_crypto)", () => {
  for (const c of GOLDEN) {
    test(c.name, () => {
      expect(canonicalize(c.input)).toBe(c.expected);
    });
  }

  test("canonicalizeBytes returns the UTF-8 encoding of canonicalize", () => {
    const v: JsonValue = { k: "café — 漢字" };
    const bytes = canonicalizeBytes(v);
    expect(new TextDecoder().decode(bytes)).toBe(canonicalize(v));
    // The em dash + CJK must be multi-byte UTF-8, never \u-escaped ASCII.
    expect(bytes.length).toBeGreaterThan(canonicalize(v).length - 4);
  });
});

describe("JCS determinism + edge cases", () => {
  test("is deterministic under input key reordering", () => {
    const a: JsonValue = { x: 1, y: 2, z: 3 };
    const b: JsonValue = { z: 3, y: 2, x: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  test("escapes the structural quote and backslash", () => {
    expect(canonicalize({ k: 'a"b\\c' })).toBe('{"k":"a\\"b\\\\c"}');
  });

  test("escapes the five short control chars", () => {
    expect(canonicalize({ k: "\b\t\n\f\r" })).toBe('{"k":"\\b\\t\\n\\f\\r"}');
  });

  test("escapes other C0 control chars as \\u00XX", () => {
    // U+0001 has no short form → six-char .
    expect(canonicalize({ k: "" })).toBe('{"k":"\\u0001"}');
  });

  test("booleans + nested arrays of objects", () => {
    expect(canonicalize({ on: true, off: false, items: [{ b: 2, a: 1 }] })).toBe(
      '{"items":[{"a":1,"b":2}],"off":false,"on":true}',
    );
  });

  test("throws JcsError on a non-finite number", () => {
    expect(() => canonicalize({ n: NaN as unknown as number })).toThrow(JcsError);
    expect(() => canonicalize({ n: Infinity as unknown as number })).toThrow(JcsError);
  });

  test("negative zero collapses to 0 (matches JSON.stringify)", () => {
    expect(canonicalize({ n: -0 })).toBe('{"n":0}');
  });

  // The 12 golden vectors include `1.0e2 → 100` — i.e. scientific *input*
  // normalizing to decimal output. They never exercise the regime where the
  // *output itself* is scientific notation. ECMA-262 NumberToString (the
  // algorithm RFC 8785 §3.2.2.3 defers to, and that Rust json_canon emits
  // via ryu_js) is non-obvious at the boundaries: positive exponents get an
  // explicit `+`, negative get `-`, and the decimal/scientific crossover
  // sits at |n| ≥ 1e21 (above → scientific) and |n| < 1e-6 (below →
  // scientific). A formatter swap that dropped the `+` (e.g. moving from
  // `JSON.stringify` to a generic `n.toString()` port) would silently break
  // byte-parity with Rust on any payload whose number falls in this regime
  // — and nothing else in this file would catch it.
  test("scientific-notation boundary matches ECMA-262 (Rust ryu_js parity)", () => {
    // |n| ≥ 1e21 → scientific with explicit `+` on the positive exponent.
    expect(canonicalize({ n: 1e21 })).toBe('{"n":1e+21}');
    expect(canonicalize({ n: 1e22 })).toBe('{"n":1e+22}');
    expect(canonicalize({ n: -1e21 })).toBe('{"n":-1e+21}');
    // |n| < 1e-6 → scientific with `-` (no `+` on negative exponents).
    expect(canonicalize({ n: 1e-7 })).toBe('{"n":1e-7}');
    // Decimal side of each crossover — pins that we don't slip into
    // scientific too eagerly.
    expect(canonicalize({ n: 1e20 })).toBe('{"n":100000000000000000000}');
    expect(canonicalize({ n: 1e-6 })).toBe('{"n":0.000001}');
  });

  // RFC 8785 §3.2.2.2 defers to ECMA-262 QuoteJSONString, which (post-ES2019,
  // "well-formed JSON.stringify") escapes every code unit in the surrogate
  // range that is not part of a valid pair. Without escaping, the lone
  // surrogate survives `serializeString` and `TextEncoder.encode` silently
  // substitutes U+FFFD on the byte path — producing a payload_hash that
  // disagrees with both `JSON.stringify` and any conformant JCS verifier.
  test("escapes lone surrogates as \\u-escape (RFC 8785 §3.2.2.2)", () => {
    expect(canonicalize({ k: "\uD800" })).toBe('{"k":"\\ud800"}');
    expect(canonicalize({ k: "\uDC00" })).toBe('{"k":"\\udc00"}');
    expect(canonicalize({ k: "\uD800X" })).toBe('{"k":"\\ud800X"}');
    expect(canonicalize({ k: "X\uDC00" })).toBe('{"k":"X\\udc00"}');
    // Two adjacent highs are both lone (neither is followed by a low).
    expect(canonicalize({ k: "\uD800\uD800" })).toBe('{"k":"\\ud800\\ud800"}');
    // Output must match well-formed JSON.stringify byte-for-byte.
    expect(canonicalize({ k: "\uD800" })).toBe(JSON.stringify({ k: "\uD800" }));
  });

  test("valid surrogate pair passes through raw (UTF-8 of the codepoint)", () => {
    // U+1F600 = 😀 — a well-formed pair must NOT be escaped.
    expect(canonicalize({ k: "😀" })).toBe('{"k":"😀"}');
    // U+10000 = 𐀀 — boundary of the supplementary plane.
    expect(canonicalize({ k: "𐀀" })).toBe('{"k":"\u{10000}"}');
  });
});
