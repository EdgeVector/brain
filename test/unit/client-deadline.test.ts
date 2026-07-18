// Unit tests for the joint request + response-body deadline (PR: bound the
// response-body read by the deadline). The node returns headers as soon as it
// accepts a request, then can stall for the whole cold-schema-init window while
// streaming the body. Before this fix only the `fetch` was deadline-bounded;
// the `await readBody()` after it was unbounded, so a body-read stall hung the
// CLI silently. These pin that BOTH halves are now bounded and that a stall
// surfaces as `service_timeout` with the idempotent-retry hint.

import { afterEach, describe, expect, test } from "bun:test";

import { FbrainError, newNodeClient } from "../../src/client.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

// Stub fetch that returns headers immediately, then a body stream that NEVER
// completes — but which rejects the moment the request's AbortSignal fires.
// This is exactly the cold-schema-init shape: headers fast, body hung.
function installHeadersThenStall(): void {
  globalThis.fetch = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal ?? undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode('{"ok":true,'));
        // never enqueue the rest, never close → the body read blocks until the
        // deadline aborts the signal, which errors the stream.
        if (signal) {
          if (signal.aborted) {
            ctrl.error(signal.reason ?? new DOMException("aborted", "AbortError"));
            return;
          }
          signal.addEventListener("abort", () => {
            ctrl.error(signal.reason ?? new DOMException("aborted", "AbortError"));
          });
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

describe("request + response-body deadline", () => {
  test("a node that returns headers then stalls mid-body still times out (not just the fetch)", async () => {
    installHeadersThenStall();
    process.env.FBRAIN_HTTP_TIMEOUT_MS = "100";
    try {
      const c = newNodeClient({ baseUrl: "http://127.0.0.1:9001", userHash: "u" });
      const start = Date.now();
      const err = await c
        .queryAll({ schemaHash: "h", fields: ["slug"], allowFullScan: true })
        .then(() => null)
        .catch((e: unknown) => e);
      // Must abort at the deadline, not hang on the unbounded body read.
      expect(Date.now() - start).toBeLessThan(3_000);
      expect(err).toBeInstanceOf(FbrainError);
      expect((err as FbrainError).code).toBe("service_timeout");
      expect((err as FbrainError).hint).toContain("re-running the command is safe");
    } finally {
      delete process.env.FBRAIN_HTTP_TIMEOUT_MS;
    }
  });

  test("FBRAIN_HTTP_TIMEOUT_MS overrides the deadline", async () => {
    installHeadersThenStall();
    process.env.FBRAIN_HTTP_TIMEOUT_MS = "150";
    try {
      const c = newNodeClient({ baseUrl: "http://127.0.0.1:9001", userHash: "u" });
      const start = Date.now();
      await c
        .queryAll({ schemaHash: "h", fields: ["slug"], allowFullScan: true })
        .catch(() => {});
      const elapsed = Date.now() - start;
      // It waited at least roughly the override before aborting (the default is
      // 30s, so without the override this would not have returned this fast).
      expect(elapsed).toBeGreaterThanOrEqual(120);
      expect(elapsed).toBeLessThan(3_000);
    } finally {
      delete process.env.FBRAIN_HTTP_TIMEOUT_MS;
    }
  });
});
