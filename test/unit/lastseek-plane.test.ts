/**
 * LastSeek tier of the search plane.
 *
 * These test the failure behaviour, because that is where the value is. The
 * tier's job is to be preferred when present, invisible when absent, and loud
 * about one specific thing: a schema scope term that resolves to nothing.
 *
 * A fake `lastseek` is a shell script, so the tests exercise the real
 * subprocess boundary (argv, exit codes, stdout/stderr parsing) rather than a
 * mock of it. The predecessor's equivalent bug lived exactly there — in what a
 * non-zero exit was taken to mean.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LastSeekUnknownSchemaError,
  lastSeekAvailable,
  queryLastSeek,
} from "../../src/lastseek-plane.ts";
import { querySearchPlane } from "../../src/search-plane.ts";

/** Write a fake `lastseek` that answers `status` and `query` from a script. */
function fakeLastSeek(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lastseek-fake-"));
  const bin = join(dir, "lastseek");
  writeFileSync(bin, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

const STATUS_LIVE = `{"ok":true,"needs_rebuild":false,"committed_rows":42,"pending_ops":0}`;

afterEach(() => {
  delete process.env.LASTSEEK_BIN;
  delete process.env.LASTSEEK_DISABLE;
});

describe("lastseek plane", () => {
  test("a missing binary is not a live plane", () => {
    process.env.LASTSEEK_BIN = "/nonexistent/lastseek-xyz";
    expect(lastSeekAvailable()).toBe(false);
  });

  test("an empty index is not a live plane", () => {
    // Otherwise every query would answer "no matches" while the incumbent
    // still held the whole corpus — a confident empty answer by another route.
    process.env.LASTSEEK_BIN = fakeLastSeek(
      `if [ "$1" = status ]; then echo '{"ok":true,"needs_rebuild":false,"committed_rows":0,"pending_ops":0}'; fi`,
    );
    expect(lastSeekAvailable()).toBe(false);
  });

  test("a store needing a rebuild is not a live plane", () => {
    process.env.LASTSEEK_BIN = fakeLastSeek(
      `if [ "$1" = status ]; then echo '{"ok":true,"needs_rebuild":true,"committed_rows":9}'; fi`,
    );
    expect(lastSeekAvailable()).toBe(false);
  });

  test("a populated index is a live plane", () => {
    process.env.LASTSEEK_BIN = fakeLastSeek(
      `if [ "$1" = status ]; then echo '${STATUS_LIVE}'; fi`,
    );
    expect(lastSeekAvailable()).toBe(true);
  });

  test("LASTSEEK_DISABLE=1 pins the incumbent", () => {
    process.env.LASTSEEK_BIN = fakeLastSeek(
      `if [ "$1" = status ]; then echo '${STATUS_LIVE}'; fi`,
    );
    process.env.LASTSEEK_DISABLE = "1";
    expect(lastSeekAvailable()).toBe(false);
    expect(queryLastSeek({ query: "x" })).toBeNull();
  });

  test("results are returned with the identity the row is keyed on", () => {
    process.env.LASTSEEK_BIN = fakeLastSeek(
      `echo '{"ok":true,"hits":1,"results":[{"score":0.8,"schema_identity":"5c691083","schema":"Reference","key_hash":"slug-a","key_range":null,"fragment_key":"body","text":"hello"}]}'`,
    );
    const hits = queryLastSeek({ query: "x", schemas: ["Reference"] });
    expect(hits).not.toBeNull();
    expect(hits![0]!.schema_identity).toBe("5c691083");
    expect(hits![0]!.schema).toBe("Reference");
    expect(hits![0]!.key_hash).toBe("slug-a");
  });

  test("scope terms are passed through as repeated --schema flags", () => {
    // The plane resolves readable names, identity hashes and registry names
    // itself, so the client must not translate or collapse them.
    process.env.LASTSEEK_BIN = fakeLastSeek(
      `printf '{"ok":true,"results":[{"score":1,"schema_identity":"i","schema":null,"key_hash":"%s","key_range":null,"fragment_key":"body","text":"t"}]}' "$*"`,
    );
    const hits = queryLastSeek({ query: "q", k: 7, schemas: ["Card", "abc"] });
    expect(hits![0]!.key_hash).toContain("--schema Card --schema abc");
    expect(hits![0]!.key_hash).toContain("--k 7");
  });

  test("an unresolvable schema throws instead of reporting no matches", () => {
    // The central property. If this returned null, the caller would fall
    // through to the incumbent, which answers `[]`, and the confident-empty
    // answer LastSeek exists to remove would be reintroduced by the fallback.
    process.env.LASTSEEK_BIN = fakeLastSeek(
      `if [ "$1" = status ]; then echo '${STATUS_LIVE}'; exit 0; fi
       echo 'lastseek: unknown schema "Crad"; known names include: Card' >&2
       exit 1`,
    );
    expect(() => queryLastSeek({ query: "x", schemas: ["Crad"] })).toThrow(
      LastSeekUnknownSchemaError,
    );
  });

  test("an unresolvable schema propagates out of querySearchPlane", async () => {
    process.env.LASTSEEK_BIN = fakeLastSeek(
      `if [ "$1" = status ]; then echo '${STATUS_LIVE}'; exit 0; fi
       echo 'lastseek: unknown schema "Crad"; known names include: Card' >&2
       exit 1`,
    );
    await expect(
      querySearchPlane({ query: "x", schemas: ["Crad"] }),
    ).rejects.toThrow(LastSeekUnknownSchemaError);
  });

  test("any other failure returns null so the incumbent still runs", () => {
    process.env.LASTSEEK_BIN = fakeLastSeek(
      `echo 'lastseek: io: no such file or directory' >&2; exit 1`,
    );
    expect(queryLastSeek({ query: "x" })).toBeNull();
  });

  test("non-JSON output returns null rather than throwing", () => {
    process.env.LASTSEEK_BIN = fakeLastSeek(`echo 'not json'`);
    expect(queryLastSeek({ query: "x" })).toBeNull();
  });

  test("querySearchPlane prefers LastSeek and maps its hits", async () => {
    process.env.LASTSEEK_BIN = fakeLastSeek(
      `if [ "$1" = status ]; then echo '${STATUS_LIVE}'; exit 0; fi
       echo '{"ok":true,"results":[{"score":0.77,"schema_identity":"5c691083","schema":"Reference","key_hash":"slug-a","key_range":null,"fragment_key":"body","text":"body text"}]}'`,
    );
    const hits = await querySearchPlane({ query: "x", schemas: ["Reference"] });
    expect(hits).not.toBeNull();
    expect(hits!.length).toBe(1);
    // Callers compare schema_name against the hashes they passed, so the
    // identity travels in that field, not the readable label.
    expect(hits![0]!.schema_name).toBe("5c691083");
    expect(hits![0]!.score).toBe(0.77);
    expect(hits![0]!.text).toBe("body text");
  });
});
