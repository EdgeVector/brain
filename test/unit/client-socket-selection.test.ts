// Unit tests for client.ts's owner-socket selection (`shouldUseNodeSocket`).
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

import { SOCKET_DATA_PLANE_PATHS, shouldUseNodeSocket } from "../../src/client.ts";

// A real on-disk file standing in for a live node socket: `shouldUseNodeSocket`
// guards on existsSync(socketPath), so the path must exist for selection to win.
function makeSocketFile(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fbrain-sock-sel-"));
  const path = join(dir, "folddb.sock");
  writeFileSync(path, "");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("shouldUseNodeSocket", () => {
  let cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
  });

  function liveSocket(): string {
    const { path, cleanup } = makeSocketFile();
    cleanups.push(cleanup);
    return path;
  }

  test("native-index search WITH a query string selects the socket", () => {
    // The motivating case: a GET carrying `?q=foo`. The selector must strip the
    // query string before matching the allowlist, or this route can never use
    // the socket and dials the retired TCP port instead.
    const socket = liveSocket();
    expect(shouldUseNodeSocket("node", "/api/native-index/search?q=foo", socket)).toBe(true);
  });

  test("query-string stripping: the same path with and without `?q` both match", () => {
    const socket = liveSocket();
    expect(shouldUseNodeSocket("node", "/api/native-index/search", socket)).toBe(true);
    expect(
      shouldUseNodeSocket("node", "/api/native-index/search?q=foo&exact=true", socket),
    ).toBe(true);
    // A `#fragment` is stripped too.
    expect(shouldUseNodeSocket("node", "/api/native-index/search#frag", socket)).toBe(true);
  });

  test("the full owner-socket data-plane allowlist selects the socket", () => {
    const socket = liveSocket();
    for (const path of SOCKET_DATA_PLANE_PATHS) {
      expect(shouldUseNodeSocket("node", path, socket)).toBe(true);
    }
    // The allowlist matches the node's owner-socket route table.
    expect(SOCKET_DATA_PLANE_PATHS).toContain("/api/native-index/search");
    expect(SOCKET_DATA_PLANE_PATHS).toContain("/api/schemas");
    expect(SOCKET_DATA_PLANE_PATHS).toContain("/api/system/auto-identity");
  });

  test("a non-data-plane path never selects the socket", () => {
    const socket = liveSocket();
    expect(shouldUseNodeSocket("node", "/api/system/status", socket)).toBe(false);
    expect(shouldUseNodeSocket("node", "/health", socket)).toBe(false);
    // A path that merely prefixes a known one is not a match.
    expect(shouldUseNodeSocket("node", "/api/native-index/search-extra", socket)).toBe(false);
  });

  test("the schema service never uses the node socket", () => {
    const socket = liveSocket();
    expect(shouldUseNodeSocket("schema", "/api/query", socket)).toBe(false);
  });

  test("an absent / missing socket path falls back to TCP", () => {
    expect(shouldUseNodeSocket("node", "/api/native-index/search?q=foo", undefined)).toBe(false);
    expect(shouldUseNodeSocket("node", "/api/native-index/search?q=foo", "")).toBe(false);
    expect(
      shouldUseNodeSocket("node", "/api/native-index/search?q=foo", "/no/such/socket.sock"),
    ).toBe(false);
  });
});
