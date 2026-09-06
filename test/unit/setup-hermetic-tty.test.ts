// The preload pins the suite to a non-TTY shell shape. See test/setup.ts for
// the measured failure (a runner pseudo-terminal un-mocked the suite).
import { describe, expect, test } from "bun:test";
import { resolveStdoutIsTty } from "../../src/format.ts";

describe("the unit suite is hermetic w.r.t. the terminal", () => {
  test("stdin, stdout and stderr all read as non-TTY under bun test", () => {
    expect(Boolean(process.stdin.isTTY)).toBe(false);
    expect(Boolean(process.stdout.isTTY)).toBe(false);
    expect(Boolean(process.stderr.isTTY)).toBe(false);
  });

  test("the column-legend gate defaults to off, and an injected TTY still wins", () => {
    expect(resolveStdoutIsTty({})).toBe(false);
    expect(resolveStdoutIsTty({ isTty: () => true })).toBe(true);
  });
});
