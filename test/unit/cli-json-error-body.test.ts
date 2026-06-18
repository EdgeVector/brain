// Pins the `--json` FAILURE-path contract: when `--json` is set, a failing
// fbrain command must emit a machine-readable `{"error", "hint"}` JSON object
// to STDOUT (so `... --json | jq` never chokes on a bare `error:` line), while
// the human `error:`/`hint:` lines still go to STDERR unchanged. Without
// `--json`, stdout stays empty and the error output is byte-identical to today.
// Exit codes are preserved (operational=1, compatible with the usage=2 contract
// in cli-usage-error-exit-code.test.ts). See card `errors-emit-json-under-json-flag`.
//
// Spawn-based so the real argv → main() → process.exit(code) path (including
// the top-level catch block's jsonMode branch) is exercised. The config-missing
// and bogus-node cases reach the catch without touching any real node (Tom's
// :9001 brain is never involved).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-json-err-"));
  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, FBRAIN_NO_STDIN: "1", HOME: fakeHome, ...extraEnv },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

// Point a hand-written config at a connection-refused port so a well-formed
// read fails *operationally* (node unreachable) — the cleanest way to drive the
// catch block with a real FbrainError without standing up a node.
function deadNodeEnv(): Record<string, string> {
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-json-err-node-"));
  const cfgPath = join(fakeHome, "config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      configVersion: 1,
      nodeUrl: "http://127.0.0.1:59999",
      schemaServiceUrl: "http://127.0.0.1:59999",
      userHash: "0".repeat(64),
      schemaHashes: {},
      designSchemaHash: "0".repeat(64),
      taskSchemaHash: "0".repeat(64),
    }),
  );
  return { HOME: fakeHome, FBRAIN_CONFIG: cfgPath, FBRAIN_HTTP_TIMEOUT_MS: "1500" };
}

describe("fbrain --json failure path emits a JSON error object on stdout", () => {
  test("config-missing `get <slug> --json` → JSON {error, hint} on stdout, exit 1", async () => {
    const { code, stdout, stderr } = await runCli(["get", "some-slug", "--json"]);
    expect(code).toBe(1);
    // stdout must be exactly one parseable JSON object carrying `error`.
    const parsed = JSON.parse(stdout.trim());
    expect(typeof parsed.error).toBe("string");
    expect(parsed.error.length).toBeGreaterThan(0);
    // The first-touch config-missing error now carries a STRUCTURED hint (the
    // recovery action), not a null — it joins the uniform {error,hint} contract
    // that node-down/capability/write errors already honor.
    expect(typeof parsed.hint).toBe("string");
    expect(parsed.hint).toContain("fbrain init");
    // …and the human path prints the matching `error:` + `hint:` lines.
    expect(stderr).toContain("error:");
    expect(stderr).toContain("hint:");
    expect(stderr).toContain("fbrain init");
  });

  test("config-invalid `list --json` → non-null hint, exit 1", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-json-err-invalid-"));
    const cfgPath = join(fakeHome, "config.json");
    writeFileSync(cfgPath, "{ not valid json", "utf8");
    const { code, stdout } = await runCli(["list", "--json"], {
      HOME: fakeHome,
      FBRAIN_CONFIG: cfgPath,
    });
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout.trim());
    expect(typeof parsed.error).toBe("string");
    expect(parsed.error).toContain("invalid");
    expect(typeof parsed.hint).toBe("string");
    expect(parsed.hint).toContain("fbrain init");
  });

  test("node-unreachable `get <slug> --json` → JSON object on stdout, exit 1", async () => {
    const { code, stdout, stderr } = await runCli(["get", "some-slug", "--json"], deadNodeEnv());
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout.trim());
    expect(typeof parsed.error).toBe("string");
    expect("hint" in parsed).toBe(true);
    expect(stderr).toContain("error:");
  }, 15000);

  test("`--json` carries the FbrainError hint when one exists", async () => {
    // The config-missing path surfaces a FbrainError/ConfigMissingError with a
    // human-facing message; whichever it is, `hint` is present (string|null).
    const { stdout } = await runCli(["status", "some-slug", "--json"]);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed).toHaveProperty("error");
    expect(parsed).toHaveProperty("hint");
    expect(parsed.hint === null || typeof parsed.hint === "string").toBe(true);
  });
});

describe("fbrain non-`--json` failure path is unchanged (plaintext on stderr)", () => {
  test("`get <slug>` (no --json) → empty stdout, `error:` on stderr, exit 1", async () => {
    const { code, stdout, stderr } = await runCli(["get", "some-slug"]);
    expect(code).toBe(1);
    // No JSON leaks onto stdout when --json is absent.
    expect(stdout.trim()).toBe("");
    expect(stderr).toContain("error:");
  });
});
