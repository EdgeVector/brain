// Unit tests for `resolveNodeHome` — the single node-data-home resolver every
// path-deriving site (control socket, port breadcrumb, init hint) routes
// through. The FoldDB→LastDB rebrand (node v0.15.1+) moved the default data
// home from `~/.folddb` to `~/.lastdb`; fbrain must work against BOTH a current
// `~/.lastdb` node and a legacy 0.14.x `~/.folddb` node. Precedence:
//   1. LASTDB_HOME env, 2. FOLDDB_HOME env, 3. ~/.lastdb if it exists,
//   4. ~/.folddb otherwise.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveNodeHome } from "../../src/client.ts";

describe("resolveNodeHome", () => {
  let priorLastdb: string | undefined;
  let priorFolddb: string | undefined;

  beforeEach(() => {
    priorLastdb = process.env.LASTDB_HOME;
    priorFolddb = process.env.FOLDDB_HOME;
    delete process.env.LASTDB_HOME;
    delete process.env.FOLDDB_HOME;
  });

  afterEach(() => {
    if (priorLastdb === undefined) delete process.env.LASTDB_HOME;
    else process.env.LASTDB_HOME = priorLastdb;
    if (priorFolddb === undefined) delete process.env.FOLDDB_HOME;
    else process.env.FOLDDB_HOME = priorFolddb;
  });

  test("LASTDB_HOME wins over everything", () => {
    process.env.LASTDB_HOME = "/tmp/explicit-lastdb";
    process.env.FOLDDB_HOME = "/tmp/explicit-folddb";
    expect(resolveNodeHome()).toBe("/tmp/explicit-lastdb");
  });

  test("FOLDDB_HOME (legacy) honored when LASTDB_HOME unset", () => {
    process.env.FOLDDB_HOME = "/tmp/explicit-folddb";
    expect(resolveNodeHome()).toBe("/tmp/explicit-folddb");
  });

  test("empty env values are ignored (treated as unset)", () => {
    process.env.LASTDB_HOME = "";
    process.env.FOLDDB_HOME = "/tmp/explicit-folddb";
    expect(resolveNodeHome()).toBe("/tmp/explicit-folddb");
  });

  test("no env → prefers ~/.lastdb when it exists, else ~/.folddb", () => {
    // Deterministic against the real machine: the result is exactly the
    // existsSync-driven default, with ~/.lastdb taking precedence.
    const lastdb = join(homedir(), ".lastdb");
    const folddb = join(homedir(), ".folddb");
    const expected = existsSync(lastdb) ? lastdb : folddb;
    expect(resolveNodeHome()).toBe(expected);
  });
});
