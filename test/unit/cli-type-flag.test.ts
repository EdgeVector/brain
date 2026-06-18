// Pins `--type` parsing on `fbrain search` and `fbrain ask`:
//   1. An unknown type errors with the validation message AND exits 1.
//   2. The check runs BEFORE readConfig() — an un-init'd machine (no
//      ~/.fbrain/config.json) still surfaces the parse error instead of
//      the config-missing one.
//
// Spawn-based so we exercise the real argv → parseArgs → parseRecordTypeList
// path that the CLI ships.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RECORD_TYPES } from "../../src/schemas.ts";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  // HOME points at an empty dir so readConfig() would throw a
  // ConfigMissingError — which makes the test sharper: if we EVER see that
  // error, we know the --type validation didn't run first.
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-cli-type-flag-"));
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

describe("fbrain search / ask --type validation", () => {
  test("`fbrain search q --type whatever` exits 1 with the validation message", async () => {
    const { code, stderr } = await runCli(["search", "q", "--type", "whatever"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--type must be one of");
    expect(stderr).toContain("whatever");
    // The check runs before config — never the config-missing path.
    expect(stderr).not.toContain("config");
  });

  test("`fbrain ask q --type bogus` exits 1 with the validation message", async () => {
    const { code, stderr } = await runCli(["ask", "q", "--type", "bogus"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--type must be one of");
    expect(stderr).toContain("bogus");
    expect(stderr).not.toContain("config");
  });

  test("validation lists every known record type", async () => {
    // Belt-and-braces: the error message must enumerate every type so the
    // user can recover. Pinning this with RECORD_TYPES catches drift if a
    // new type is added without updating the error.
    const { stderr } = await runCli(["search", "q", "--type", "nope"]);
    for (const t of RECORD_TYPES) {
      expect(stderr).toContain(t);
    }
  });
});
