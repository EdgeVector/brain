// Unit tests for `resolveNodeHome` — the single node-data-home resolver every
// path-deriving site (control socket, port breadcrumb, init hint) routes
// through. The FoldDB→LastDB rebrand is mid-flight, so there is NO single fixed
// default home: the LastDB.app desktop node uses `~/.folddb` while a v0.15.1+
// CLI/brew node uses `~/.lastdb`. fbrain must attest against whichever node is
// actually live. Precedence:
//   1. LASTDB_HOME env, 2. FOLDDB_HOME env,
//   3. the default home whose live socket (`data/folddb.sock`) exists
//      (~/.lastdb first, then ~/.folddb),
//   4. ~/.lastdb if its dir exists, 5. ~/.folddb otherwise.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveDefaultNodeHome, resolveNodeHome } from "../../src/client.ts";

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

  test("no env → resolves the existsSync-driven default deterministically", () => {
    // Deterministic against the real machine: the result equals the same
    // socket-preference + directory-fallback logic the resolver applies.
    const home = homedir();
    const expected = resolveDefaultNodeHome(home, existsSync);
    expect(resolveNodeHome()).toBe(expected);
  });
});

// The pure default-home resolver (env overrides already consumed) — driven with
// an injected home base + `exists` probe so the mixed-version cases the rebrand
// makes plausible are deterministic, regardless of the real machine's state.
describe("resolveDefaultNodeHome (socket-preference + directory fallback)", () => {
  const HOME = "/tmp/fbrain-home-fixture";
  const lastdbDir = join(HOME, ".lastdb");
  const folddbDir = join(HOME, ".folddb");
  const lastdbSock = join(lastdbDir, "data", "folddb.sock");
  const folddbSock = join(folddbDir, "data", "folddb.sock");

  // Build an `exists` probe from an explicit set of present paths.
  const probe = (present: string[]) => (p: string) => present.includes(p);

  test("BOTH ~/.lastdb dir + ~/.folddb socket present → returns the ~/.folddb home (socket wins over a stale dir)", () => {
    // The card's core case: a dev who ran a brew node (left ~/.lastdb behind,
    // no socket) then switched to LastDB.app (~/.folddb, live socket).
    expect(resolveDefaultNodeHome(HOME, probe([lastdbDir, folddbSock, folddbDir]))).toBe(folddbDir);
  });

  test("only ~/.lastdb socket present → returns ~/.lastdb", () => {
    expect(resolveDefaultNodeHome(HOME, probe([lastdbDir, lastdbSock]))).toBe(lastdbDir);
  });

  test("~/.lastdb socket wins over ~/.folddb socket when both exist", () => {
    expect(resolveDefaultNodeHome(HOME, probe([lastdbSock, folddbSock]))).toBe(lastdbDir);
  });

  test("neither socket present → falls back to ~/.lastdb when its dir exists", () => {
    expect(resolveDefaultNodeHome(HOME, probe([lastdbDir]))).toBe(lastdbDir);
  });

  test("neither socket present, neither dir exists → falls back to ~/.folddb", () => {
    expect(resolveDefaultNodeHome(HOME, probe([]))).toBe(folddbDir);
  });

  test("neither socket present, only ~/.folddb dir exists → ~/.folddb", () => {
    expect(resolveDefaultNodeHome(HOME, probe([folddbDir]))).toBe(folddbDir);
  });
});
