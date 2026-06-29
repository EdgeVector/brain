import { afterEach, describe, expect, test } from "bun:test";

import {
  addGateToBody,
  clearGateInBody,
  formatGateEntry,
  gateVerify,
  parseGateEntries,
  parseGateLine,
  verifyEvidence,
  type GateEntry,
} from "../../src/commands/gate.ts";
import { TEST_HASHES, buildTestCfg } from "../util.ts";

const cfg = buildTestCfg({ userHash: "uh" });
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function queryResp(results: unknown[]): Response {
  return new Response(JSON.stringify({ ok: true, results }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function asRow(slug: string, fields: Record<string, unknown>) {
  return { fields, key: { hash: slug, range: null } };
}

const baseGate: GateEntry = {
  status: "open",
  slug: "needs-tom",
  program: "north-star",
  unblocks: "prod cutover",
  evidence: "fbrain:task:needs-tom-card",
  surfaced: "2026-06-29",
  recommendation: "ship after explicit go",
};

describe("structured gate lines", () => {
  test("format and parse preserve field values", () => {
    const rendered = formatGateEntry(baseGate);
    expect(rendered).toContain("status=open");
    expect(rendered).toContain('program="north-star"');

    expect(parseGateLine(rendered)).toEqual(baseGate);
  });

  test("add is idempotent by slug", () => {
    const body = "# Decisions\n\n## Structured gate ledger\n";
    const once = addGateToBody(body, baseGate);
    const twice = addGateToBody(once, {
      ...baseGate,
      program: "changed",
    });

    expect(parseGateEntries(once)).toHaveLength(1);
    expect(twice).toBe(once);
  });

  test("clear flips status inline and removes gate from open set", () => {
    const body = addGateToBody("# Decisions\n\n---\n\nhistory", baseGate);
    const result = clearGateInBody(
      body,
      "needs-tom",
      "Tom chose manual prod gate",
      "2026-06-30",
    );

    expect(result.cleared).toBe(true);
    expect(result.entry.status).toBe("cleared");
    expect(result.entry.resolution).toBe("Tom chose manual prod gate");
    expect(parseGateEntries(result.body).filter((g) => g.status === "open")).toEqual([]);
  });
});

describe("gate verify", () => {
  test("fbrain evidence is stale when the evidence record is done", async () => {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.task) {
        return queryResp([
          asRow("needs-tom-card", {
            slug: "needs-tom-card",
            title: "Done",
            body: "",
            status: "done",
            tags: [],
            design_slug: "",
            created_at: "2026-06-29T00:00:00Z",
            updated_at: "2026-06-29T00:00:00Z",
          }),
        ]);
      }
      return queryResp([]);
    }) as unknown as typeof fetch;

    const result = await verifyEvidence("fbrain:task:needs-tom-card", cfg);
    expect(result.stale).toBe(true);
    expect(result.detail).toContain("is done");
  });

  test("gateVerify prints the stale warning for open gates", async () => {
    const ledgerBody = [
      "# Decisions",
      "",
      "## Structured gate ledger",
      "",
      formatGateEntry(baseGate),
    ].join("\n");
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.reference) {
        return queryResp([
          asRow("open-decisions", {
            slug: "open-decisions",
            title: "Open decisions",
            body: ledgerBody,
            status: "active",
            tags: [],
            created_at: "2026-06-29T00:00:00Z",
            updated_at: "2026-06-29T00:00:00Z",
          }),
        ]);
      }
      return queryResp([]);
    }) as unknown as typeof fetch;

    const lines: string[] = [];
    const result = await gateVerify({
      cfg,
      print: (line) => lines.push(line),
      checkEvidence: async () => ({
        stale: true,
        detail: "evidence fbrain:needs-tom-card is done",
      }),
    });

    expect(result.stale.map((g) => g.slug)).toEqual(["needs-tom"]);
    expect(lines.join("\n")).toContain("⚠️ stale — likely resolved");
  });
});
