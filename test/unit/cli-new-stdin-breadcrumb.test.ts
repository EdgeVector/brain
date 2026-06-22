// Pins the stderr breadcrumb on the `<type> new` create path.
//
// When a new dev (or their AI agent) runs `fbrain <type> new <slug> --title X`
// WITHOUT --body in a non-TTY context, the create handler falls back to
// reading the body from stdin (cli.ts: `values.body ?? maybeReadStdin(...)`).
// That read blocks on the raw stdin stream — and an inherited-but-empty pipe
// never EOFs, so the process hangs forever with ZERO output. The fix: print a
// one-line stderr note BEFORE the blocking read so the wait is
// self-explaining. Warn-before-the-trap shape of #275/#276/#278/#279/#280.
//
// Critically, the notice fires ONLY when stdin will actually be read:
//   - --body given           → no read, no note
//   - FBRAIN_NO_STDIN=1      → no read, no note
//   - stdin closed (</dev/null) + no --body → reads (EOFs immediately), NOTE.
//
// And `put` / `raw` — which take stdin as their documented PRIMARY input —
// must stay SILENT (their stdin is never a surprise fallback).
//
// The breadcrumb fires AFTER readConfig() (the read is part of the create), so
// the spawned CLI needs a valid on-disk config or it short-circuits on
// `Config not found`. We seed a throwaway config via FBRAIN_CONFIG pointed at a
// dead node URL: readConfig() passes, the note prints, then the actual write
// fails fast against the dead port — but the note is already on stderr, which
// is the behavior under test. stdin is "ignore" (a non-TTY that EOFs
// immediately) so the read returns "" without a real hang.
//
// Spawn-based so we exercise the real argv → parseArgs → runRecordNew path.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildTestCfg } from "../util.ts";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

const NOTE = "reading the record body from piped stdin";

// A config whose nodeUrl points at a dead loopback port — readConfig() accepts
// it, but any write fails immediately. The note prints before the write.
function seedConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "fbrain-new-stdin-"));
  const path = join(dir, "config.json");
  const cfg = buildTestCfg({ nodeUrl: "http://127.0.0.1:1" });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return path;
}

async function runCli(
  args: string[],
  opts: { env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  // Strip FBRAIN_NO_STDIN from the inherited env so per-test control is exact;
  // the harness/CI may set it, which would suppress the read we want to test.
  const baseEnv = { ...process.env } as Record<string, string>;
  delete baseEnv.FBRAIN_NO_STDIN;
  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    // "ignore" gives the child a non-TTY stdin that EOFs immediately — the
    // closest stand-in for the new-dev `</dev/null` case without a real hang.
    stdin: "ignore",
    env: { ...baseEnv, FBRAIN_CONFIG: seedConfig(), ...(opts.env ?? {}) },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe("`<type> new` without --body → stdin breadcrumb", () => {
  test("no --body, non-TTY stdin → prints the note BEFORE the read", async () => {
    const { stderr } = await runCli(["design", "new", "b1", "--title", "X"]);
    expect(stderr).toContain(NOTE);
    // The note must name the escape hatches so the wait is self-resolving.
    expect(stderr).toContain("--body");
    expect(stderr).toContain("FBRAIN_NO_STDIN=1");
    // The note must NOT tell the user to press Ctrl-D: by the time it fires
    // stdin is guaranteed non-TTY (a pipe or redirect), so there is no terminal
    // EOF for Ctrl-D to send to this read — it is dead advice.
    expect(stderr).not.toContain("Ctrl-D");
  });

  test("note fires exactly once (not per-chunk / not duplicated)", async () => {
    const { stderr } = await runCli(["design", "new", "b1", "--title", "X"]);
    const occurrences = stderr.split(NOTE).length - 1;
    expect(occurrences).toBe(1);
  });

  test("--body given → NO note (stdin is never read)", async () => {
    const { stderr } = await runCli([
      "design",
      "new",
      "b2",
      "--title",
      "X",
      "--body",
      "hi",
    ]);
    expect(stderr).not.toContain(NOTE);
  });

  test("FBRAIN_NO_STDIN=1 → NO note (read short-circuits)", async () => {
    const { stderr } = await runCli(["design", "new", "b3", "--title", "X"], {
      env: { FBRAIN_NO_STDIN: "1" },
    });
    expect(stderr).not.toContain(NOTE);
  });

  test("the note works across every simple record type, not just design", async () => {
    for (const type of [
      "concept",
      "preference",
      "reference",
      "agent",
      "task",
    ] as const) {
      const { stderr } = await runCli([type, "new", "b1", "--title", "X"]);
      expect(stderr).toContain(NOTE);
    }
  });
});

describe("put / raw keep stdin SILENT (documented primary input)", () => {
  test("`fbrain put` does not emit the new-fallback note", async () => {
    const { stderr } = await runCli(["put", "p1"]);
    expect(stderr).not.toContain(NOTE);
  });

  test("`fbrain raw GET /v1/whoami` does not emit the new-fallback note", async () => {
    const { stderr } = await runCli(["raw", "GET", "/v1/whoami"]);
    expect(stderr).not.toContain(NOTE);
  });
});
