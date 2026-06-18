// Unit tests for `defaultNodeUrlFromBreadcrumb` — deriving the running node's
// TCP URL from fold's `${FOLDDB_HOME ?? ~/.folddb}/port` breadcrumb so
// `fbrain init` (no --node-url) targets whatever node is actually up on this
// machine, and the node URL agrees with the owner-attestation UDS socket
// (which derives from the SAME home root). A missing / empty / non-numeric /
// out-of-range breadcrumb yields null (caller falls back to the hardcoded
// :9001 default).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultNodeUrlFromBreadcrumb } from "../../src/client.ts";

describe("defaultNodeUrlFromBreadcrumb", () => {
  let tmp: string;
  let priorHome: string | undefined;

  function withHome(breadcrumb: string | null): void {
    tmp = mkdtempSync(join(tmpdir(), "fbrain-bc-"));
    if (breadcrumb !== null) writeFileSync(join(tmp, "port"), breadcrumb);
    priorHome = process.env.FOLDDB_HOME;
    process.env.FOLDDB_HOME = tmp;
  }

  afterEach(() => {
    if (priorHome === undefined) delete process.env.FOLDDB_HOME;
    else process.env.FOLDDB_HOME = priorHome;
    priorHome = undefined;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("present numeric port → http://127.0.0.1:<port>", () => {
    withHome("9299");
    expect(defaultNodeUrlFromBreadcrumb()).toBe("http://127.0.0.1:9299");
  });

  test("trailing whitespace/newline is trimmed", () => {
    withHome("9299\n");
    expect(defaultNodeUrlFromBreadcrumb()).toBe("http://127.0.0.1:9299");
  });

  test("breadcrumb file absent → null", () => {
    withHome(null);
    expect(defaultNodeUrlFromBreadcrumb()).toBeNull();
  });

  test("empty breadcrumb → null", () => {
    withHome("");
    expect(defaultNodeUrlFromBreadcrumb()).toBeNull();
  });

  test("non-numeric breadcrumb → null", () => {
    withHome("not-a-port");
    expect(defaultNodeUrlFromBreadcrumb()).toBeNull();
  });

  test("non-integer / decorated breadcrumb → null", () => {
    withHome("92.99");
    expect(defaultNodeUrlFromBreadcrumb()).toBeNull();
  });

  test("out-of-range port → null", () => {
    withHome("70000");
    expect(defaultNodeUrlFromBreadcrumb()).toBeNull();
  });

  test("home resolution mirrors the socket precedence (FOLDDB_HOME root)", () => {
    // The breadcrumb at <FOLDDB_HOME>/port is what's read; the URL reflects it.
    withHome("12345");
    expect(defaultNodeUrlFromBreadcrumb()).toBe("http://127.0.0.1:12345");
  });
});
