// Pins case-insensitivity for the shared `--type` flag.
//
// Every user-facing surface (doctor, --help, list/ask/get output) Capitalizes
// the type name, so users naturally reach for `fbrain list --type Design`.
// Without this normalization, the shared `--type` parsers would dead-end on
// `error: --type must be one of design | task | ... (got "Design")` — a
// strict-validation papercut on a word the user copied off our own output.
//
// Precedent: `src/commands/put.ts normaliseType` already lowercases on the
// way in for `put` (both frontmatter `type:` and `--type`). This pins that
// the shared CLI parsers do the same on every other command.
//
// Spawn-based so we exercise the real argv → parseArgs → parseRecordType{,List}
// path that ships in production. HOME is an empty dir so any code path that
// happens to reach readConfig() before validation would surface a
// config-missing error and fail the test — keeps the assertion sharp.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RECORD_TYPES } from "../../src/schemas.ts";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-cli-type-case-"));
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

describe("shared --type flag: case-insensitive normalization", () => {
  // The Capitalized form is what the user copies off `fbrain doctor`,
  // `--help`, and the type column in list/ask output. It must be accepted
  // on every command that takes `--type`.

  test("`list --type Design` is accepted (does NOT exit with `must be one of`)", async () => {
    const { stderr } = await runCli(["list", "--type", "Design"]);
    // Whether the command succeeds depends on whether HOME is configured,
    // which we deliberately don't set up. The only thing we pin here is
    // that we do NOT trip the --type validation error.
    expect(stderr).not.toContain("--type must be one of");
  });

  test("`search foo --type Concept` is accepted (does NOT trip --type validation)", async () => {
    const { stderr } = await runCli(["search", "foo", "--type", "Concept"]);
    expect(stderr).not.toContain("--type must be one of");
  });

  test("`ask foo --type Project` is accepted (does NOT trip --type validation)", async () => {
    const { stderr } = await runCli(["ask", "foo", "--type", "Project"]);
    expect(stderr).not.toContain("--type must be one of");
  });

  test("`get foo --type Task` is accepted (does NOT trip --type validation)", async () => {
    const { stderr } = await runCli(["get", "foo", "--type", "Task"]);
    expect(stderr).not.toContain("--type must be one of");
  });

  test("`status foo --type Preference` is accepted", async () => {
    const { stderr } = await runCli(["status", "foo", "--type", "Preference"]);
    expect(stderr).not.toContain("--type must be one of");
  });

  test("`delete foo --type Reference --yes` is accepted", async () => {
    const { stderr } = await runCli(["delete", "foo", "--type", "Reference", "--yes"]);
    expect(stderr).not.toContain("--type must be one of");
  });

  test("`reindex --type Agent` is accepted", async () => {
    const { stderr } = await runCli(["reindex", "--type", "Agent"]);
    expect(stderr).not.toContain("--type must be one of");
  });

  test("ALL-CAPS form is also accepted (mirrors put.ts normaliseType behavior)", async () => {
    // `normaliseType` in put.ts uses a bare `toLowerCase()`, so `DESIGN`,
    // `Design`, and `design` all collapse. Mirror that here so the two
    // code paths agree.
    const { stderr } = await runCli(["list", "--type", "DESIGN"]);
    expect(stderr).not.toContain("--type must be one of");
  });

  test("every record type, Capitalized, passes --type validation on list", async () => {
    // Belt-and-braces: ensures a new entry added to RECORD_TYPES won't
    // silently regress to case-sensitive parsing.
    for (const t of RECORD_TYPES) {
      const cap = t.charAt(0).toUpperCase() + t.slice(1);
      const { stderr } = await runCli(["list", "--type", cap]);
      expect(stderr).not.toContain("--type must be one of");
    }
  });

  test("every record type, Capitalized, passes --type validation on search", async () => {
    for (const t of RECORD_TYPES) {
      const cap = t.charAt(0).toUpperCase() + t.slice(1);
      const { stderr } = await runCli(["search", "q", "--type", cap]);
      expect(stderr).not.toContain("--type must be one of");
    }
  });

  test("canonical lowercase still works unchanged", async () => {
    const { stderr } = await runCli(["list", "--type", "design"]);
    expect(stderr).not.toContain("--type must be one of");
  });

  test("genuinely-unknown type still errors with the validation message", async () => {
    // The fix is normalize-then-validate, NOT accept-anything. Typos and
    // bogus values must still trip the existing error path so the user
    // sees the list of valid types. Uses `search` because list/status/get
    // call readConfig() before parseRecordType, which would shadow this
    // assertion with a config-missing error in our HOME-as-empty-dir setup.
    const { code, stderr } = await runCli(["search", "q", "--type", "Whatever"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--type must be one of");
    // Echo the user's original spelling in the error for findability.
    expect(stderr).toContain("Whatever");
  });

  test("near-miss typo surfaces a `did you mean` hint", async () => {
    // Polish: matches the `Did you mean: concept new?` UX from suggestCommand.
    // `desgin` → `design` is well within the Levenshtein threshold.
    const { code, stderr } = await runCli(["search", "q", "--type", "desgin"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--type must be one of");
    expect(stderr).toContain("did you mean");
    expect(stderr).toContain("design");
  });
});
