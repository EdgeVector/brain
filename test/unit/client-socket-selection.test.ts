// Unit tests for client.ts's node-socket selection.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverFullSurfaceSocket, localNodeRouteSocket } from "../../src/client.ts";

function makeSocketFiles(opts: { full?: boolean } = {}): {
  dataPath: string;
  fullPath: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "fbrain-sock-sel-"));
  const dataPath = join(dir, "folddb.sock");
  const fullPath = join(dir, "folddb-full.sock");
  writeFileSync(dataPath, "");
  if (opts.full) writeFileSync(fullPath, "");
  return { dataPath, fullPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("localNodeRouteSocket", () => {
  const LOOPBACK = "http://127.0.0.1:9001";
  const REMOTE = "http://10.0.0.1:9001";
  let cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
  });

  function liveSockets(opts: { full?: boolean } = {}): { dataPath: string; fullPath: string } {
    const { dataPath, fullPath, cleanup } = makeSocketFiles(opts);
    cleanups.push(cleanup);
    return { dataPath, fullPath };
  }

  test("loopback data-plane routes select the data socket", () => {
    const { dataPath } = liveSockets();
    const routeCases: Array<[string, string]> = [
      ["GET", "/api/health"],
      ["GET", "/api/schemas"],
      ["GET", "/api/system/auto-identity"],
      ["GET", "/api/native-index/search"],
      ["POST", "/api/query"],
      ["POST", "/api/mutation"],
    ];
    for (const [method, path] of routeCases) {
      expect(localNodeRouteSocket("node", method, path, LOOPBACK, dataPath)).toEqual({
        socketPath: dataPath,
        kind: "data",
      });
    }
  });

  test("query strings and fragments are stripped before matching data-plane routes", () => {
    const { dataPath } = liveSockets();
    expect(
      localNodeRouteSocket(
        "node",
        "GET",
        "/api/native-index/search?q=foo&exact=true",
        LOOPBACK,
        dataPath,
      ),
    ).toEqual({ socketPath: dataPath, kind: "data" });
    expect(
      localNodeRouteSocket("node", "GET", "/api/native-index/search#frag", LOOPBACK, dataPath),
    ).toEqual({ socketPath: dataPath, kind: "data" });
  });

  test("loopback full-surface routes select folddb-full.sock when it exists", () => {
    const { dataPath, fullPath } = liveSockets({ full: true });
    const routeCases: Array<[string, string]> = [
      ["POST", "/api/apps/request-consent"],
      ["POST", "/api/session/browser-pair"],
      ["POST", "/api/setup/bootstrap"],
      ["GET", "/api/system/status"],
    ];
    for (const [method, path] of routeCases) {
      expect(localNodeRouteSocket("node", method, path, LOOPBACK, dataPath)).toEqual({
        socketPath: fullPath,
        kind: "full",
      });
    }
  });

  test("collapsed loopback nodes serve full-surface routes over the control socket", () => {
    const { dataPath } = liveSockets();
    expect(discoverFullSurfaceSocket(dataPath)).toBe(dataPath);
    expect(
      localNodeRouteSocket("node", "POST", "/api/apps/request-consent", LOOPBACK, dataPath),
    ).toEqual({ socketPath: dataPath, kind: "full" });
  });

  test("loopback selection is unconditional even when the socket path is absent", () => {
    const socketPath = "/no/such/dir/folddb.sock";
    expect(localNodeRouteSocket("node", "POST", "/api/mutation", LOOPBACK, socketPath)).toEqual({
      socketPath,
      kind: "data",
    });
    expect(
      localNodeRouteSocket("node", "POST", "/api/apps/request-consent", LOOPBACK, socketPath),
    ).toEqual({ socketPath, kind: "full" });
  });

  test("localhost and ::1 loopback hosts select the socket", () => {
    const { dataPath } = liveSockets();
    expect(
      localNodeRouteSocket("node", "POST", "/api/mutation", "http://localhost:9001", dataPath),
    ).toEqual({ socketPath: dataPath, kind: "data" });
    expect(
      localNodeRouteSocket("node", "POST", "/api/mutation", "http://[::1]:9001", dataPath),
    ).toEqual({ socketPath: dataPath, kind: "data" });
  });

  test("remote node URLs never select a local socket even when one exists", () => {
    const { dataPath } = liveSockets({ full: true });
    expect(localNodeRouteSocket("node", "POST", "/api/mutation", REMOTE, dataPath)).toBeNull();
    expect(
      localNodeRouteSocket("node", "POST", "/api/apps/request-consent", REMOTE, dataPath),
    ).toBeNull();
  });

  test("schema service and empty socket paths never select a node socket", () => {
    const { dataPath } = liveSockets();
    expect(localNodeRouteSocket("schema", "POST", "/api/query", LOOPBACK, dataPath)).toBeNull();
    expect(localNodeRouteSocket("node", "POST", "/api/mutation", LOOPBACK, undefined)).toBeNull();
    expect(localNodeRouteSocket("node", "POST", "/api/mutation", LOOPBACK, "")).toBeNull();
  });

  test("discoverFullSurfaceSocket still reports a genuinely dead path as absent", () => {
    expect(discoverFullSurfaceSocket("/no/such/dir/folddb.sock")).toBeUndefined();
  });
});
