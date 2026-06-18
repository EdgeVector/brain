// Pins the recovery hint for `fbrain <type> <slug> --status <value>`.
//
// A dev who has learned `fbrain <type> new <slug>` and `fbrain status <slug>`
// naturally reaches — by analogy with most CLIs — for
// `fbrain task <slug> --status in_progress` to move a record's status. That
// guess used to dead-end confusingly: `<slug>` parsed as an unknown subcommand
// and the misleading `<type> new` usage was dumped, while `--status` was
// silently swallowed. This guard turns the dead-end into a self-correcting
// nudge toward the real verb — `fbrain status <slug> <new-status>` — without
// auto-performing the update (the explicit verb is intentional).
//
// Same accepted "recovery hint" UX pattern already shipped for the
// `--tags → --tag` papercut (cli-tags-flag-hint.test.ts). The bare `task new`
// usage MUST NOT leak through for the status-update case, and genuinely
// unrecognizable input (`fbrain task --frobnicate`) MUST still show normal
// help — the hint is targeted, not blanket.
//
// Spawn-based so we exercise the real argv → runRecordNew path. HOME points at
// an empty dir so readConfig() would throw a ConfigMissingError if it ran — the
// hint MUST fire before readConfig, otherwise a brand-new uninit'd machine
// would see the config error and never reach the actionable hint.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-status-hint-"));
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

describe("fbrain <type> <slug> --status → status verb recovery hint", () => {
  // Table-driven: the fix lives in the shared runRecordNew dispatcher, so the
  // hint must fire identically for every record type's subcommand path.
  for (const type of ["task", "concept", "design", "preference", "project"]) {
    test(`\`fbrain ${type} some-slug --status in_progress\` points at \`fbrain status ...\``, async () => {
      const { code, stderr } = await runCli([
        type,
        "some-task-slug",
        "--status",
        "in_progress",
      ]);
      expect(code).toBe(2);
      // Points at the real verb with the slug + status echoed back.
      expect(stderr).toContain("fbrain status some-task-slug in_progress");
      // The misleading `<type> new` usage dump must NOT leak through.
      expect(stderr).not.toContain(`fbrain ${type} new <slug>`);
      expect(stderr).not.toContain("Unknown");
      // Acknowledges the swallowed --status value.
      expect(stderr).toContain("in_progress");
      // Fires before readConfig — empty HOME would otherwise shadow the hint.
      expect(stderr).not.toMatch(/config not found/i);
    });
  }

  test("a slug-shaped subcommand WITHOUT --status still nudges toward the status verb", async () => {
    // `fbrain task some-task-slug` alone is ambiguous but slug-shaped — the
    // most likely intent is still "do something to this record", and the
    // status verb is the highest-value pointer. We surface `<new-status>` as
    // the placeholder since none was given.
    const { code, stderr } = await runCli(["task", "some-task-slug"]);
    expect(code).toBe(2);
    expect(stderr).toContain("fbrain status some-task-slug <new-status>");
    expect(stderr).not.toContain("fbrain task new <slug>");
  });

  test("`fbrain task --frobnicate` (genuinely bogus) still shows the normal help", async () => {
    // A flag-shaped, non-slug subcommand that is nowhere near a known verb must
    // fall through to the bare `task new` usage dump — the hint is targeted at
    // the status-update intent, not a blanket replacement of all bad input.
    const { code, stderr } = await runCli(["task", "--frobnicate"]);
    expect(code).toBe(2);
    expect(stderr).toContain("fbrain task new <slug>");
    expect(stderr).not.toContain("Did you mean to change status");
  });

  test("a near-miss verb typo still gets the Levenshtein `Did you mean: <verb>?` suggestion", async () => {
    // `fbrain task nwe` is one transposition from `new` — that path must keep
    // its existing compound-command suggestion, NOT be absorbed by the status
    // hint (the status hint only fires when no command suggestion matched).
    const { code, stderr } = await runCli(["task", "nwe"]);
    expect(code).toBe(2);
    expect(stderr).toContain("Did you mean:");
    expect(stderr).not.toContain("Did you mean to change status");
  });

  test("`fbrain <type> new <slug>` (the correct verb) is unaffected", async () => {
    // The real `new` subcommand must proceed to readConfig (which fails only
    // because HOME is empty) — proof the status hint does not over-absorb.
    const { code, stderr } = await runCli(["concept", "new", "good-slug"]);
    expect(code).toBe(1);
    expect(stderr).not.toContain("Did you mean to change status");
    expect(stderr).toMatch(/config not found/i);
  });
});
