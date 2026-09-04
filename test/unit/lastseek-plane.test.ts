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
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LastSeekUnknownSchemaError,
  queryLastSeek,
} from "../../src/lastseek-plane.ts";
import { resetSubprocessTotals, subprocessMsSoFar } from "../../src/slow-call.ts";
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

const defaultLastSeekBin = process.env.LASTSEEK_BIN;
const defaultLastSeekDisable = process.env.LASTSEEK_DISABLE;
const defaultLastSeekCallLog = process.env.LASTSEEK_CALL_LOG;
const defaultLastSeekTimeout = process.env.LASTSEEK_TIMEOUT_MS;
const defaultLastSeekBudget = process.env.LASTSEEK_BUDGET_MS;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restoreEnv("LASTSEEK_BIN", defaultLastSeekBin);
  restoreEnv("LASTSEEK_DISABLE", defaultLastSeekDisable);
  restoreEnv("LASTSEEK_CALL_LOG", defaultLastSeekCallLog);
  restoreEnv("LASTSEEK_TIMEOUT_MS", defaultLastSeekTimeout);
  restoreEnv("LASTSEEK_BUDGET_MS", defaultLastSeekBudget);
  resetSubprocessTotals();
});

describe("lastseek plane", () => {
  test("LASTSEEK_DISABLE=1 pins the incumbent", () => {
    process.env.LASTSEEK_BIN = fakeLastSeek(
      `if [ "$1" = status ]; then echo '${STATUS_LIVE}'; fi`,
    );
    process.env.LASTSEEK_DISABLE = "1";
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

  test("querySearchPlane launches lastseek exactly once", async () => {
    const callLog = join(mkdtempSync(join(tmpdir(), "lastseek-calls-")), "calls");
    writeFileSync(callLog, "");
    process.env.LASTSEEK_CALL_LOG = callLog;
    process.env.LASTSEEK_BIN = fakeLastSeek(
      `echo "$1" >> "$LASTSEEK_CALL_LOG"
       echo '{"ok":true,"results":[]}'`,
    );

    await expect(querySearchPlane({ query: "x" })).resolves.toEqual([]);
    expect(readFileSync(callLog, "utf8").trim().split("\n")).toEqual([
      "query",
    ]);
  });

  // ── Deadline and budget ─────────────────────────────────────────────────
  //
  // The original spawn carried a 60 s timeout, which is above every caller's
  // budget: an agent Bash step is 45 s, and `brain ask` spawns once per query
  // phrasing. On 2026-09-03 one 35.1 s spawn was backgrounded at 45 s and two
  // routines then idled to their 50-minute timeouts. These tests pin the two
  // properties that stop that: the tier gives up inside a caller's budget, and
  // it never gives up quietly.
  test("a spawn past its deadline is stopped, degrades to null, and says so", () => {
    process.env.LASTSEEK_TIMEOUT_MS = "300";
    process.env.LASTSEEK_BIN = fakeLastSeek(`sleep 5; echo '{"ok":true,"results":[]}'`);

    const said: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => void said.push(a.join(" "));
    let hits: unknown;
    const started = Date.now();
    try {
      hits = queryLastSeek({ query: "x" });
    } finally {
      console.error = realError;
    }
    const elapsed = Date.now() - started;

    // Null, not a throw: falling through to the incumbent is the designed
    // degrade, and it is what keeps the caller's answer non-empty.
    expect(hits).toBeNull();
    // Bounded by the deadline, not by the 5 s sleep.
    expect(elapsed).toBeLessThan(3_000);
    // A silent degrade would be the worse bug — the caller must be able to
    // tell LastSeek's ranking from the cheaper ranker's.
    expect(said.join("\n")).toContain("deadline");
    // And the time is charged to the helper, so the report can name it.
    expect(subprocessMsSoFar()).toBeGreaterThan(0);
  });

  test("a clean non-zero exit is still the quiet unavailable path", () => {
    // Only the deadline miss is loud. An absent index is the normal
    // fall-through this tier was built for and must stay silent.
    process.env.LASTSEEK_BIN = fakeLastSeek(
      `echo 'lastseek: io: no such file or directory' >&2; exit 1`,
    );
    const said: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => void said.push(a.join(" "));
    try {
      expect(queryLastSeek({ query: "x" })).toBeNull();
    } finally {
      console.error = realError;
    }
    expect(said).toEqual([]);
  });

  test("once the cumulative budget is spent, later phrasings skip the spawn", () => {
    // `brain ask` calls this once per phrasing. Four slow spawns under the old
    // 60 s per-spawn timeout could block for four minutes; the budget is what
    // bounds the CALL rather than each spawn.
    const callLog = join(mkdtempSync(join(tmpdir(), "lastseek-budget-")), "calls");
    writeFileSync(callLog, "");
    process.env.LASTSEEK_CALL_LOG = callLog;
    // The kill has to leave the helper room to record that it ran. The fake
    // writes its call log and THEN sleeps, so a 300 ms timeout made the
    // assertion below depend on "a process starts and runs one echo in under
    // 300 ms" — a property of the host, not of the code under test. It held
    // until the suite ran on a loaded machine and the log came back empty.
    // 1200 ms is far above process startup and far below bun's 5 s per-test
    // deadline, and the budget stays what the test is actually about.
    process.env.LASTSEEK_TIMEOUT_MS = "1200";
    process.env.LASTSEEK_BUDGET_MS = "200";
    process.env.LASTSEEK_BIN = fakeLastSeek(
      `echo "$1" >> "$LASTSEEK_CALL_LOG"; sleep 5; echo '{"ok":true,"results":[]}'`,
    );

    const said: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => void said.push(a.join(" "));
    try {
      expect(queryLastSeek({ query: "one" })).toBeNull();
      expect(queryLastSeek({ query: "two" })).toBeNull();
      expect(queryLastSeek({ query: "three" })).toBeNull();
    } finally {
      console.error = realError;
    }

    // The first spawn spends the budget; the rest never launch.
    expect(readFileSync(callLog, "utf8").trim().split("\n")).toEqual(["query"]);
    expect(said.join("\n")).toContain("helper budget");
  });

  test("LASTSEEK_BUDGET_MS=0 disables the budget without disabling the tier", () => {
    // An operator who wants the old unbounded behaviour needs a way to say so
    // that is not "turn the better ranker off entirely".
    process.env.LASTSEEK_BUDGET_MS = "0";
    process.env.LASTSEEK_BIN = fakeLastSeek(`echo '{"ok":true,"results":[]}'`);
    expect(queryLastSeek({ query: "one" })).toEqual([]);
    expect(queryLastSeek({ query: "two" })).toEqual([]);
  });
});