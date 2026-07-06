// Pins the "type-as-positional" nudge for `list`, `get`, `status`, `delete`.
//
// A brand-new downloaded user's instinct is `fbrain list task` /
// `fbrain get task`, not `fbrain list --type task`. Without these hints
// `list task` dead-ends on parseArgs's bare "Unexpected argument" error
// and `get|status|delete task` dead-ends on a bare "No record with slug
// 'task'" — the user is left guessing which flag to add.
//
// Two halves to this guard:
//   1. `list task` (parseArgs rejects the positional): re-throw with a
//      hint pointing at `fbrain list --type task`. Spawn-based since the
//      parseArgs failure fires before any I/O, so HOME-as-empty-dir
//      doesn't shadow it with a config-missing error.
//   2. `get|status|delete task` (slug lookup misses): re-throw the
//      not_found with a parenthetical hint, BUT only when the slug
//      equals a known record type AND no record with that slug exists.
//      Unit-tested at the helper boundary so we don't need a live node.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withTypeAsPositionalHint } from "../../src/cli.ts";
import { FbrainError } from "../../src/client.ts";
import { RECORD_TYPES } from "../../src/schemas.ts";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  // HOME points at an empty dir so readConfig() would throw a
  // ConfigMissingError if it ran — that makes the test sharper. The
  // parseArgs check must fire BEFORE readConfig, otherwise we'd see the
  // config-missing path instead of the hint.
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-type-positional-"));
  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, FBRAIN_NO_STDIN: "1", HOME: fakeHome },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe("fbrain list <type> → --type hint (parseArgs path)", () => {
  test("`fbrain list task` keeps the parseArgs error and appends a --type hint", async () => {
    const { code, stderr } = await runCli(["list", "task"]);
    expect(code).toBe(2);
    // Original parseArgs wording preserved verbatim — the user still sees
    // exactly what's wrong, plus the suggestion.
    expect(stderr).toContain("Unexpected argument 'task'");
    expect(stderr).toContain("fbrain list --type task");
    // Hint fires before readConfig.
    expect(stderr).not.toContain("config");
  });

  test("`fbrain list design` hints at `--type design`", async () => {
    const { stderr } = await runCli(["list", "design"]);
    expect(stderr).toContain("fbrain list --type design");
  });

  test("every record type triggers the hint when typed as a positional", async () => {
    // Belt-and-braces: pins the suggestion against every known record
    // type so a new type added to RECORD_TYPES without updating the hint
    // path is caught.
    for (const t of RECORD_TYPES) {
      const { stderr } = await runCli(["list", t]);
      expect(stderr).toContain(`fbrain list --type ${t}`);
    }
  });

  test("`fbrain list xyzzy` does NOT add the --type hint (unknown positional)", async () => {
    // Only known record types get the nudge — a typo like `xyzzy` falls
    // through to the bare parseArgs error so we don't mislead the user
    // into thinking `--type xyzzy` would have worked.
    const { code, stderr } = await runCli(["list", "xyzzy"]);
    expect(code).toBe(2);
    expect(stderr).toContain("Unexpected argument 'xyzzy'");
    expect(stderr).not.toContain("--type xyzzy");
  });
});

describe("withTypeAsPositionalHint (get/status/delete not-found path)", () => {
  test("wraps not_found with the --type hint when slug equals a record type", async () => {
    const inner = () =>
      Promise.reject(
        new FbrainError({
          code: "not_found",
          message: 'No record with slug "task".',
        }),
      );
    let caught: unknown = null;
    try {
      await withTypeAsPositionalHint("task", inner);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FbrainError);
    const e = caught as FbrainError;
    expect(e.code).toBe("not_found");
    // Original message preserved.
    expect(e.message).toBe('No record with slug "task".');
    // Hint nudges at the right `--type` invocation.
    expect(e.hint).toContain("fbrain list --type task");
    expect(e.hint).toContain('"task" is a record type');
  });

  test("nudges for every record type", async () => {
    // Pins every known type so RECORD_TYPES drift is caught.
    for (const t of RECORD_TYPES) {
      const inner = () =>
        Promise.reject(
          new FbrainError({
            code: "not_found",
            message: `No record with slug "${t}".`,
          }),
        );
      let caught: FbrainError | null = null;
      try {
        await withTypeAsPositionalHint(t, inner);
      } catch (err) {
        caught = err as FbrainError;
      }
      expect(caught?.hint).toContain(`fbrain list --type ${t}`);
    }
  });

  test("does NOT add a hint when the slug is not a known record type", async () => {
    // A user-defined slug that happens to be missing should surface the
    // bare not_found — no spurious `--type` suggestion.
    const original = new FbrainError({
      code: "not_found",
      message: 'No record with slug "ghost-bug".',
    });
    let caught: unknown = null;
    try {
      await withTypeAsPositionalHint("ghost-bug", () => Promise.reject(original));
    } catch (err) {
      caught = err;
    }
    // Same FbrainError instance flowed through untouched.
    expect(caught).toBe(original);
    expect((caught as FbrainError).hint).toBeUndefined();
  });

  test("does NOT touch errors with codes other than not_found", async () => {
    // The hint is only for the slug-lookup miss. A capability 403 or any
    // other failure on a slug that happens to be a record type must pass
    // through untouched — otherwise we'd attach a misleading `--type` nudge
    // to an unrelated failure.
    const original = new FbrainError({
      code: "capability_denied",
      message: "Capability denied for task schema.",
    });
    let caught: unknown = null;
    try {
      await withTypeAsPositionalHint("task", () => Promise.reject(original));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(original);
  });

  test("returns the inner result unchanged when it resolves", async () => {
    // The slug actually exists (e.g. `fbrain put task --type concept` created
    // a real concept slugged "task"). No throw, no hint, just the value.
    const result = await withTypeAsPositionalHint("task", () =>
      Promise.resolve({ ok: true }),
    );
    expect(result).toEqual({ ok: true });
  });
});

describe("fbrain get <type> <slug> → `get <slug> --type <type>` hint", () => {
  // The natural mistake `fbrain get design my-first-idea` (type-then-slug)
  // used to take "design" as the slug, silently drop "my-first-idea", and
  // emit the single-arg `list --type design` hint — the WRONG intent (the
  // user wants one record, not a type listing). The two-positional shape is
  // caught BEFORE the network call and routed at `get <slug> --type <type>`.
  // HOME-as-empty-dir makes the test sharp: the shape check must fire before
  // readConfig, so we never see a config-missing error.

  test("two positionals with a record-type first nudge at `get <slug> --type <type>`", async () => {
    const { code, stderr } = await runCli(["get", "design", "my-first-idea"]);
    expect(code).toBe(2);
    expect(stderr).toContain('"design" is a record type');
    // Points at the corrected command, preserving the slug they typed.
    expect(stderr).toContain("fbrain get my-first-idea --type design");
    // NOT the misleading single-arg listing hint.
    expect(stderr).not.toContain("fbrain list --type design");
    // Fires before readConfig.
    expect(stderr).not.toContain("config");
  });

  test("every record type triggers the corrected get hint", async () => {
    for (const t of RECORD_TYPES) {
      const { stderr } = await runCli(["get", t, "some-slug"]);
      expect(stderr).toContain(`fbrain get some-slug --type ${t}`);
      expect(stderr).not.toContain(`fbrain list --type ${t}`);
    }
  });

  test("single-positional `fbrain get design` is UNCHANGED (still list --type hint)", async () => {
    // The slug-lookup miss path: a live brain returns not_found and
    // withTypeAsPositionalHint adds the `list --type` hint. With HOME empty
    // there's no node, so we assert the corrected get-hint does NOT appear —
    // i.e. the two-positional branch did not steal the single-arg case.
    const { stderr } = await runCli(["get", "design"]);
    expect(stderr).not.toContain("fbrain get  --type design");
    expect(stderr).not.toContain("--type design`?");
  });

  test("two positionals where the first is NOT a type are rejected", async () => {
    // `fbrain get my-slug stray` — "my-slug" isn't a type, so the generic
    // extra-positional guard should fire before config/node access.
    const { code, stderr } = await runCli(["get", "my-slug", "stray"]);
    expect(code).toBe(2);
    expect(stderr).toContain("get takes exactly one slug");
    expect(stderr).toContain("my-slug");
    expect(stderr).toContain("stray");
    expect(stderr.toLowerCase()).not.toContain("config");
  });
});
