import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(
  args: string[],
  home = mkdtempSync(join(tmpdir(), "fbrain-cli-int-sweep-")),
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, FBRAIN_NO_STDIN: "1", HOME: home },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

const intFlagCommands = [
  { name: "get", base: ["get", "some-slug"], flag: "--body-limit" },
  { name: "list", base: ["list"], flag: "--limit" },
  { name: "search", base: ["search", "query"], flag: "--limit" },
  { name: "ask", base: ["ask", "query"], flag: "--limit" },
  { name: "doctor", base: ["doctor", "--usage"], flag: "--usage-window" },
] as const;

describe("integer flags validate identically for --flag value and --flag=value", () => {
  for (const spec of intFlagCommands) {
    test(`${spec.name}: valid values reach config for both spellings`, async () => {
      const home = mkdtempSync(join(tmpdir(), "fbrain-cli-int-valid-"));
      const space = await runCli([...spec.base, spec.flag, "2"], home);
      const equals = await runCli([...spec.base, `${spec.flag}=2`], home);

      expect(space.code).toBe(equals.code);
      expect(space.stderr).toBe(equals.stderr);
      expect(space.code).toBe(1);
      expect(space.stderr).not.toContain("must be a positive integer");
      expect(space.stderr).not.toContain("ambiguous");
    });

    for (const value of ["abc", "0", "-1"]) {
      test(`${spec.name}: ${value} is rejected the same way for both spellings`, async () => {
        const home = mkdtempSync(join(tmpdir(), "fbrain-cli-int-invalid-"));
        const space = await runCli([...spec.base, spec.flag, value], home);
        const equals = await runCli([...spec.base, `${spec.flag}=${value}`], home);

        expect(space.code).toBe(2);
        expect(equals.code).toBe(2);
        expect(space.stderr).toBe(equals.stderr);
        expect(space.stderr).toContain(`${spec.flag} must be a positive integer`);
        expect(space.stderr).toContain(value);
        expect(space.stderr).not.toContain("ambiguous");
        expect(space.stderr.toLowerCase()).not.toContain("config");
      });
    }

    test(`${spec.name}: repeated flags validate the last parsed value`, async () => {
      const validHome = mkdtempSync(join(tmpdir(), "fbrain-cli-int-repeat-ok-"));
      const spaceLastValid = await runCli(
        [...spec.base, spec.flag, "abc", spec.flag, "2"],
        validHome,
      );
      const equalsLastValid = await runCli(
        [...spec.base, `${spec.flag}=abc`, `${spec.flag}=2`],
        validHome,
      );

      expect(spaceLastValid.code).toBe(equalsLastValid.code);
      expect(spaceLastValid.stderr).toBe(equalsLastValid.stderr);
      expect(spaceLastValid.code).toBe(1);
      expect(spaceLastValid.stderr).not.toContain("must be a positive integer");

      const invalidHome = mkdtempSync(join(tmpdir(), "fbrain-cli-int-repeat-bad-"));
      const spaceLastInvalid = await runCli(
        [...spec.base, spec.flag, "2", spec.flag, "abc"],
        invalidHome,
      );
      const equalsLastInvalid = await runCli(
        [...spec.base, `${spec.flag}=2`, `${spec.flag}=abc`],
        invalidHome,
      );

      expect(spaceLastInvalid.code).toBe(2);
      expect(equalsLastInvalid.code).toBe(2);
      expect(spaceLastInvalid.stderr).toBe(equalsLastInvalid.stderr);
      expect(spaceLastInvalid.stderr).toContain(`${spec.flag} must be a positive integer`);
      expect(spaceLastInvalid.stderr).toContain("abc");
    });
  }
});

describe("CLI argument taxonomy sweep", () => {
  test("get rejects extra positionals instead of warning and proceeding", async () => {
    const { code, stderr } = await runCli(["get", "slug1", "slug2"]);
    expect(code).toBe(2);
    expect(stderr).toContain("get takes exactly one slug");
    expect(stderr).toContain("slug1");
    expect(stderr).toContain("slug2");
    expect(stderr.toLowerCase()).not.toContain("config");
  });

  test("get type-then-slug hint is classified as usage", async () => {
    const { code, stderr } = await runCli(["get", "design", "slug1"]);
    expect(code).toBe(2);
    expect(stderr).toContain("did you mean `fbrain get slug1 --type design`");
    expect(stderr.toLowerCase()).not.toContain("config");
  });

  test("raw rejects more than method, path, and optional body", async () => {
    const { code, stderr } = await runCli(["raw", "POST", "/x", "body", "extra"]);
    expect(code).toBe(2);
    expect(stderr).toContain("raw takes method, path, and optional body");
    expect(stderr.toLowerCase()).not.toContain("config");
  });

  test("share rejects extra positionals", async () => {
    const { code, stderr } = await runCli(["share", "extra"]);
    expect(code).toBe(2);
    expect(stderr).toContain("share takes no positional arguments");
    expect(stderr.toLowerCase()).not.toContain("config");
  });

  test("mcp flags before the subcommand are not consumed as the subcommand", async () => {
    const { code, stderr } = await runCli(["mcp", "--claude-md", "install"]);
    expect(code).toBe(2);
    expect(stderr).toContain("Unknown option `--claude-md`");
    expect(stderr).not.toContain("brain-mcp");
  });
});
