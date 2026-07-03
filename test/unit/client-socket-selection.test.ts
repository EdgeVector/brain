// Unit tests for client.ts's node-socket selection.
//
// Regression for the search-over-TCP bug: `fbrain search` / `fbrain_ask`
// build `/api/native-index/search?q=...` and used to fall through to the
// retired loopback TCP port (`http://127.0.0.1:9001`) — "node not reachable" —
// because (a) the search path was absent from the data-plane allowlist and
// (b) the selector compared the FULL path-with-query, so even adding the bare
// path would never match a GET that carries `?q=...`. This pins both halves.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SOCKET_DATA_PLANE_PATHS,
  discoverFullSurfaceSocket,
  nodeSocketForRoute,
  shouldUseNodeSocket,
} from "../../src/client.ts";

// A real on-disk file standing in for a live node socket: `shouldUseNodeSocket`
// guards on existsSync(socketPath), so the path must exist for selection to win.
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

describe("node socket selection", () => {
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

  test("native-index search WITH a query string selects the socket", () => {
    // The motivating case: a GET carrying `?q=foo`. The selector must strip the
    // query string before matching the allowlist, or this route can never use
    // the socket and dials the retired TCP port instead.
    const { dataPath } = liveSockets();
    expect(shouldUseNodeSocket("node", "/api/native-index/search?q=foo", dataPath)).toBe(true);
  });

  test("query-string stripping: the same path with and without `?q` both match", () => {
    const { dataPath } = liveSockets();
    expect(shouldUseNodeSocket("node", "/api/native-index/search", dataPath)).toBe(true);
    expect(
      shouldUseNodeSocket("node", "/api/native-index/search?q=foo&exact=true", dataPath),
    ).toBe(true);
    // A `#fragment` is stripped too.
    expect(shouldUseNodeSocket("node", "/api/native-index/search#frag", dataPath)).toBe(true);
  });

  test("the data-plane allowlist selects the data socket", () => {
    const { dataPath } = liveSockets({ full: true });
    const routeCases: Array<[string, string]> = [
      ["POST", "/api/query"],
      ["POST", "/api/mutation"],
      ["GET", "/api/schemas"],
      ["GET", "/health"],
      ["GET", "/api/system/auto-identity"],
      ["GET", "/api/native-index/search"],
    ];
    for (const [method, path] of routeCases) {
      expect(nodeSocketForRoute("node", method, path, dataPath)).toEqual({
        socketPath: dataPath,
        kind: "data",
      });
    }
    // The allowlist matches the node's owner-socket route table.
    expect(SOCKET_DATA_PLANE_PATHS).toContain("/api/native-index/search");
    expect(SOCKET_DATA_PLANE_PATHS).toContain("/api/schemas");
    expect(SOCKET_DATA_PLANE_PATHS).toContain("/health");
    expect(SOCKET_DATA_PLANE_PATHS).toContain("/api/system/auto-identity");
  });

  test("full-surface routes select folddb-full.sock when it exists", () => {
    const { dataPath, fullPath } = liveSockets({ full: true });
    const routeCases: Array<[string, string]> = [
      ["GET", "/api/health"],
      ["POST", "/api/apps/request-consent"],
      ["POST", "/api/session/browser-pair"],
      ["POST", "/api/setup/bootstrap"],
      ["GET", "/api/system/status"],
    ];
    for (const [method, path] of routeCases) {
      expect(nodeSocketForRoute("node", method, path, dataPath)).toEqual({
        socketPath: fullPath,
        kind: "full",
      });
    }
  });

  test("collapsed node (no folddb-full.sock) serves owner routes over the control socket", () => {
    // fold #1246 (2026-06-30) collapsed the separate full-surface socket into
    // the canonical `folddb.sock`, so a CURRENT node exposes only `folddb.sock`
    // and serves the owner-attested verbs there too. When the sibling is
    // absent, `discoverFullSurfaceSocket` must fall back to the control socket
    // — NOT undefined — or owner verbs (declare-schema, browser-pair) fail to
    // open a socket (the FailedToOpenSocket regression this pins). Loopback TCP
    // is retired, so there is no TCP fallback to preserve.
    const { dataPath } = liveSockets();
    expect(discoverFullSurfaceSocket(dataPath)).toBe(dataPath);
    expect(nodeSocketForRoute("node", "GET", "/api/health", dataPath)).toEqual({
      socketPath: dataPath,
      kind: "full",
    });
    expect(nodeSocketForRoute("node", "POST", "/api/apps/request-consent", dataPath)).toEqual({
      socketPath: dataPath,
      kind: "full",
    });
    // Data-plane routes still select the control socket as `data`.
    expect(nodeSocketForRoute("node", "POST", "/api/query", dataPath)).toEqual({
      socketPath: dataPath,
      kind: "data",
    });
  });

  test("a genuinely dead socket path (neither file exists) still yields no socket", () => {
    // The fallback is guarded on existsSync(controlSocket): a path where NOTHING
    // exists must stay undefined so a down node maps to a clear diagnostic
    // rather than dialing a nonexistent socket.
    expect(discoverFullSurfaceSocket("/no/such/dir/folddb.sock")).toBeUndefined();
  });

  test("a path that merely prefixes a data-plane route is full-surface or TCP, not data", () => {
    const { dataPath, fullPath } = liveSockets({ full: true });
    expect(nodeSocketForRoute("node", "GET", "/api/native-index/search-extra", dataPath)).toEqual({
      socketPath: fullPath,
      kind: "full",
    });
  });

  test("the schema service never uses the node socket", () => {
    const { dataPath } = liveSockets({ full: true });
    expect(nodeSocketForRoute("schema", "POST", "/api/query", dataPath)).toBeNull();
  });

  test("an absent / missing socket path falls back to TCP", () => {
    expect(shouldUseNodeSocket("node", "/api/native-index/search?q=foo", undefined)).toBe(false);
    expect(shouldUseNodeSocket("node", "/api/native-index/search?q=foo", "")).toBe(false);
    expect(
      shouldUseNodeSocket("node", "/api/native-index/search?q=foo", "/no/such/socket.sock"),
    ).toBe(false);
  });
});
