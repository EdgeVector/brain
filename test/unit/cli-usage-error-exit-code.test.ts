// Pins the fbrain CLI's usage-vs-operational exit-code contract end to end.
//
// A *usage/argument* error — "you invoked fbrain wrong" — exits 2: unknown
// command, typo'd command, missing required positional, unknown/misapplied
// flag, missing-flag-value, bad flag combination. An *operational* failure —
// "the work couldn't be done" — exits 1: record-not-found from a reachable
// node, node unreachable, write/consent failure, non-2xx from `raw`. Help and
// bare invocation stay 0. This lets a script or agent wrapping fbrain tell
// "fix my invocation" (2) apart from "the node is down / record missing /
// retry" (1). Mirrors the sibling fkanban CLI's contract (cards
// `missing-arg-exit-code-2`, `reject-unknown-flags`). See card
// `cli-usage-errors-exit-2`.
//
// Spawn-based so the real argv → main() → process.exit(code) path is
// exercised. Usage cases short-circuit before any node/config access, so they
// need NO running node — a fresh fake HOME (no ~/.fbrain/config.json) is
// enough. The two operational cases either reach a config-missing failure or a
// deliberately-unreachable bogus node; both stay exit 1 without any real node
// (Tom's :9001 brain is never touched).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-usage-exit-"));
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

// Writes a hand-written config pointing at a bogus (connection-refused) node
// into a fresh fake HOME and returns its path. The malformed-input cases on the
// put/create path read config BEFORE the input validation that throws (the put
// handler reads config, then frontmatter parsing throws inside putCmd; the
// create handler reads config, then validateSlug throws inside recordNew) — and
// both throw BEFORE any HTTP traffic, so the bogus node is never contacted
// (Tom's :9001 brain is never touched). Without a config they'd fail earlier
// with config_missing (operational, exit 1) and never reach the input error.
function writeBogusConfig(fakeHome: string): string {
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
  return cfgPath;
}

// Variant that pipes a body on stdin — needed for the `put` malformed-input
// cases, whose errors fire on the *parsed stdin* (frontmatter parsing). We must
// NOT set FBRAIN_NO_STDIN (that would short-circuit the stdin read and never
// reach the frontmatter parser).
async function runCliWithStdin(
  args: string[],
  stdin: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-usage-exit-stdin-"));
  const cfgPath = writeBogusConfig(fakeHome);
  const env = {
    ...process.env,
    HOME: fakeHome,
    FBRAIN_CONFIG: cfgPath,
  } as Record<string, string>;
  delete env.FBRAIN_NO_STDIN;
  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: new TextEncoder().encode(stdin),
    env,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

// Variant that runs with a bogus config present but no stdin — for the
// invalid-slug create case, which reaches validateSlug (and throws) before any
// HTTP traffic once a config exists.
async function runCliWithConfig(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-usage-exit-cfg-"));
  const cfgPath = writeBogusConfig(fakeHome);
  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, FBRAIN_NO_STDIN: "1", HOME: fakeHome, FBRAIN_CONFIG: cfgPath },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe("fbrain usage/argument errors → exit 2", () => {
  // The four representative usage classes from the card's contract table.
  // None of these reaches a node — they short-circuit in main() / the arg
  // parser before any config or network access.
  const usageCases: Array<{ name: string; args: string[] }> = [
    { name: "unknown command", args: ["frobnicate"] },
    { name: "typo'd command", args: ["serach", "foo"] },
    { name: "missing required positional (`get` with no slug)", args: ["get"] },
    { name: "unknown flag (`list --bogusflag`)", args: ["list", "--bogusflag"] },
  ];

  for (const { name, args } of usageCases) {
    test(`${name} → exit 2`, async () => {
      const { code } = await runCli(args);
      expect(code).toBe(2);
    });
  }

  test("missing flag value (`list --limit`) → exit 2", async () => {
    // `--limit` with no value: a missing-flag-value usage error, surfaced
    // before any node call.
    const { code } = await runCli(["list", "--limit"]);
    expect(code).toBe(2);
  });

  test("misapplied flag (`get --node-url …`) → exit 2", async () => {
    // --node-url is init-only; re-using it on another command is a usage
    // error, not an operational one.
    const { code } = await runCli(["get", "foo", "--node-url", "http://127.0.0.1:59999"]);
    expect(code).toBe(2);
  });

  test("bad flag combination (`ask … --explain` without --expand) → exit 2", async () => {
    const { code } = await runCli(["ask", "foo", "--explain"]);
    expect(code).toBe(2);
  });

  // Malformed-input errors on the put/create path. These are "you handed me a
  // bad record" (fix your input), the same class as missing_type /
  // unsupported_type / empty_stdin which already exit 2 — not operational. The
  // frontmatter cases parse stdin and throw before any node access; the
  // invalid-slug case rejects the bad slug arg before any node access too.
  test("put with unclosed frontmatter → exit 2", async () => {
    const { code } = await runCliWithStdin(
      ["put", "some-slug"],
      "---\ntype: concept\ntitle: oops\nbody no close\n",
    );
    expect(code).toBe(2);
  });

  test("put with malformed frontmatter → exit 2", async () => {
    const { code } = await runCliWithStdin(
      ["put", "some-slug"],
      "---\n  : : :\n---\nbody\n",
    );
    expect(code).toBe(2);
  });

  test("put with unfenced frontmatter → exit 2", async () => {
    const { code } = await runCliWithStdin(
      ["put", "some-slug"],
      "type: concept\ntitle: x\nbody\n",
    );
    expect(code).toBe(2);
  });

  test("create with an invalid slug → exit 2", async () => {
    // A create with bad slug chars: rejected by validateSlug (invalid_slug)
    // before any HTTP traffic. Same class as missing_slug (already exit 2). A
    // config must exist so the create reaches validateSlug rather than
    // short-circuiting on config_missing (operational, exit 1).
    const { code } = await runCliWithConfig(["concept", "new", "Bad Slug!"]);
    expect(code).toBe(2);
  });

  test("put with an invalid status: in frontmatter → exit 2", async () => {
    // An invalid status enum value (invalid_status) is a caller-supplied
    // malformed value, same class as invalid_slug — usage error, exit 2. On
    // the put path `ensureStatus` runs after frontmatter parse + validateSlug
    // but BEFORE any HTTP traffic (the bogus node is never contacted), so the
    // bad status is caught and classified as a usage error. The status-update
    // surface (`status <slug> <bad>`) resolves the record on a live node
    // before ensureStatus, so its exit-2 path is exercised in the app-run
    // verification rather than this no-node spawn test.
    const { code } = await runCliWithStdin(
      ["put", "some-slug"],
      "---\ntype: concept\ntitle: x\nstatus: not-a-real-status\n---\nbody\n",
    );
    expect(code).toBe(2);
  });
});

describe("fbrain operational failures stay exit 1", () => {
  test("node unreachable (`get <slug>` against a bogus node) → exit 1", async () => {
    // A well-formed invocation that fails only because the node can't be
    // reached. Operational, not usage → exit 1. We point at a bogus
    // (connection-refused) port via a hand-written config rather than `fbrain
    // init`, which has a multi-minute reachability retry/backoff loop; writing
    // the config directly keeps the test fast and never touches a real node.
    const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-usage-exit-op-"));
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
    const proc = Bun.spawn(["bun", CLI_PATH, "get", "some-slug"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: {
        ...process.env,
        FBRAIN_NO_STDIN: "1",
        HOME: fakeHome,
        FBRAIN_CONFIG: cfgPath,
        FBRAIN_HTTP_TIMEOUT_MS: "1500",
      },
    });
    const code = await proc.exited;
    // A clean operational failure (1) — never a usage error (2).
    expect(code).toBe(1);
  }, 15000);

  test("config missing (well-formed `get <slug>`, un-init'd) → exit 1", async () => {
    // A correctly-shaped invocation whose only problem is the absence of a
    // config/node — an operational failure, not a bad invocation.
    const { code } = await runCli(["get", "some-slug"]);
    expect(code).toBe(1);
  });
});

describe("fbrain help / bare invocation stay exit 0", () => {
  test("`fbrain --help` → exit 0", async () => {
    const { code } = await runCli(["--help"]);
    expect(code).toBe(0);
  });

  test("bare `fbrain` → exit 0", async () => {
    const { code } = await runCli([]);
    expect(code).toBe(0);
  });

  test("`fbrain help` → exit 0", async () => {
    const { code } = await runCli(["help"]);
    expect(code).toBe(0);
  });
});
