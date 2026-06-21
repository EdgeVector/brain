// Pins the broken-HOME guard: when os.homedir() cannot return a usable absolute
// path, fbrain must FAIL LOUD (operational exit 1, code `home_unresolved`) and
// write NOTHING — instead of silently scattering a relative
// `./undefined/.fbrain/config.json` (+ keychain, migrations, caches, usage log)
// under whatever cwd it happened to be standing in.
//
// Root cause (observed dogfooding RUN 124): a spawn passing a JS-`undefined`
// HOME (`env: { ...process.env, HOME: fakeHome }` with `fakeHome` undefined)
// makes Bun/Node's os.homedir() return the LITERAL string "undefined", so every
// `join(homedir(), ".fbrain", …)` becomes the relative path `undefined/.fbrain/…`
// and the first mkdir+write scatters config into cwd. The guard (fbrainHomeBase)
// rejects the literal "undefined"/"null" and any non-absolute home up front.
//
// Two layers of coverage:
//  1. Unit — fbrainHomeBase() throws HomeUnresolvedError for each bad shape and
//     returns the real home on the happy path.
//  2. Spawn (the contract that matters end to end) — run a real verb with
//     HOME="undefined" from a CLEAN cwd and assert: exit 1, the error names the
//     home-resolution failure, and the cwd is byte-for-byte unchanged (no
//     `undefined/` dir created).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  fbrainHomeBase,
  HomeUnresolvedError,
  validateHomeBase,
} from "../../src/config.ts";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

describe("the home-base guard rejects an unusable home", () => {
  test("fbrainHomeBase() returns the real absolute home on the happy path", () => {
    const h = fbrainHomeBase();
    expect(h).toBe(homedir());
    expect(isAbsolute(h)).toBe(true);
  });

  test("validateHomeBase() passes through a valid absolute path unchanged", () => {
    expect(validateHomeBase("/Users/someone")).toBe("/Users/someone");
  });

  // The failure shapes os.homedir() can yield on a broken HOME. We test the
  // pure predicate with literal inputs because in-process os.homedir() on macOS
  // reads the passwd entry (NOT $HOME), so overriding process.env.HOME in-process
  // cannot exercise these — only a spawned child can (see the spawn test below).
  const badHomes: Array<{ name: string; value: string }> = [
    { name: 'the literal string "undefined" (undefined HOME)', value: "undefined" },
    { name: 'the literal string "null" (null HOME)', value: "null" },
    { name: "a non-absolute relative path", value: "some/relative/dir" },
    { name: "an empty string", value: "" },
  ];

  for (const { name, value } of badHomes) {
    test(`validateHomeBase() throws HomeUnresolvedError for ${name}`, () => {
      let thrown: unknown;
      try {
        validateHomeBase(value);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(HomeUnresolvedError);
      expect((thrown as HomeUnresolvedError).code).toBe("home_unresolved");
      // A structured, actionable hint (the recovery action) — not null.
      expect(typeof (thrown as HomeUnresolvedError).hint).toBe("string");
      expect((thrown as HomeUnresolvedError).hint).toContain("FBRAIN_CONFIG");
      // home_unresolved is OPERATIONAL (exit 1), never a usage code — assert it
      // here so a future refactor that misfiles it surfaces.
      expect((thrown as HomeUnresolvedError).code).not.toBe("");
    });
  }
});

describe("a verb spawned with HOME=undefined fails loud and litters nothing", () => {
  // Run a real verb from a CLEAN, empty cwd with HOME set to the literal
  // "undefined" (the exact dogfood repro). The guard must fire BEFORE any
  // mkdir/write, so the cwd stays empty and exit is 1 (operational), not 2
  // (usage). We use a verb that resolves config first (`get`); init would do the
  // same.
  test("exit 1, names the home-resolution failure, creates no ./undefined/", async () => {
    const cleanCwd = mkdtempSync(join(tmpdir(), "fbrain-home-guard-cwd-"));
    try {
      const before = readdirSync(cleanCwd);
      expect(before.length).toBe(0);

      const proc = Bun.spawn(["bun", CLI_PATH, "get", "some-slug", "--json"], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        cwd: cleanCwd,
        // The crux: HOME passed as the literal string "undefined" — exactly what
        // a `spawn(..., { env: { HOME: <undefined-var> } })` produces once the
        // child reads os.homedir().
        // BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 disables Bun's OWN transpile
        // cache, which otherwise writes `$HOME/Library/Caches/bun` → with a
        // broken HOME that's `./undefined/Library/…`. That litter is the Bun
        // runtime, NOT fbrain; disabling it isolates the assertion to "fbrain
        // wrote nothing" (no `./undefined/.fbrain/…` scatter).
        env: {
          ...process.env,
          FBRAIN_NO_STDIN: "1",
          HOME: "undefined",
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        },
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;

      // Operational failure (1), NOT a usage error (2) — `home_unresolved` is
      // not in USAGE_ERROR_CODES.
      expect(code).toBe(1);

      // The --json body is a parseable {error, hint} object naming the failure.
      const parsed = JSON.parse(stdout.trim());
      expect(typeof parsed.error).toBe("string");
      expect(parsed.error.toLowerCase()).toContain("home directory");
      expect(typeof parsed.hint).toBe("string");
      expect(parsed.hint).toContain("FBRAIN_CONFIG");
      // The human path prints the matching error: line on stderr.
      expect(stderr).toContain("error:");

      // The whole point: NOTHING was written to cwd — no `undefined/` scatter,
      // nothing at all.
      const after = readdirSync(cleanCwd);
      expect(after).toEqual([]);
    } finally {
      rmSync(cleanCwd, { recursive: true, force: true });
    }
  }, 15000);

  // A pinned FBRAIN_CONFIG must still let a command proceed past path resolution
  // even with a broken HOME — the override is honored before the guard. (We
  // still exit 1 here because the pinned config doesn't exist, i.e.
  // config_missing — NOT home_unresolved. The key assertion is that the home
  // guard did not pre-empt the override.)
  test("FBRAIN_CONFIG override is honored before the guard (config_missing, not home_unresolved)", async () => {
    const cleanCwd = mkdtempSync(join(tmpdir(), "fbrain-home-guard-override-cwd-"));
    const pinnedHome = mkdtempSync(join(tmpdir(), "fbrain-home-guard-pinned-"));
    const pinnedCfg = join(pinnedHome, "config.json"); // does not exist
    try {
      const proc = Bun.spawn(["bun", CLI_PATH, "get", "some-slug", "--json"], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        cwd: cleanCwd,
        env: {
          ...process.env,
          FBRAIN_NO_STDIN: "1",
          HOME: "undefined",
          FBRAIN_CONFIG: pinnedCfg,
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        },
      });
      const stdout = await new Response(proc.stdout).text();
      const code = await proc.exited;
      expect(code).toBe(1);
      const parsed = JSON.parse(stdout.trim());
      // Reached config-missing (the pinned path), proving the override bypassed
      // the home guard rather than tripping home_unresolved.
      expect(parsed.error.toLowerCase()).toContain("config not found");
      // And still no cwd litter.
      expect(readdirSync(cleanCwd)).toEqual([]);
    } finally {
      rmSync(cleanCwd, { recursive: true, force: true });
      rmSync(pinnedHome, { recursive: true, force: true });
    }
  }, 15000);
});
