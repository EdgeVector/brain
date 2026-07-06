// The MCP idle-reaper: an fbrain MCP server that receives no request for the
// idle window must exit itself. This bounds hosts that abandon a stdio server
// while keeping the pipe open, so `transport.onclose` never fires.

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MCP_IDLE_TIMEOUT_MS,
  makeIdleReaper,
  mcpIdleTimeoutMs,
  withIdleReaper,
} from "../../src/mcp/server.ts";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("mcpIdleTimeoutMs", () => {
  const KEY = "FBRAIN_MCP_IDLE_TIMEOUT_MS";

  function withEnv(val: string | undefined, fn: () => void): void {
    const prev = process.env[KEY];
    if (val === undefined) delete process.env[KEY];
    else process.env[KEY] = val;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env[KEY];
      else process.env[KEY] = prev;
    }
  }

  test("defaults to 30 minutes when unset", () => {
    withEnv(undefined, () => {
      expect(mcpIdleTimeoutMs()).toBe(DEFAULT_MCP_IDLE_TIMEOUT_MS);
      expect(DEFAULT_MCP_IDLE_TIMEOUT_MS).toBe(30 * 60 * 1000);
    });
  });

  test("honors a numeric override", () => {
    withEnv("60000", () => expect(mcpIdleTimeoutMs()).toBe(60000));
  });

  test("non-integer values are rejected loudly", () => {
    withEnv("banana", () => {
      expect(() => mcpIdleTimeoutMs()).toThrow("FBRAIN_MCP_IDLE_TIMEOUT_MS");
    });
    withEnv("30m", () => {
      expect(() => mcpIdleTimeoutMs()).toThrow("integer number of milliseconds");
    });
  });

  test("0 and negative values are honored so the caller can disable", () => {
    withEnv("0", () => expect(mcpIdleTimeoutMs()).toBe(0));
    withEnv("-1", () => expect(mcpIdleTimeoutMs()).toBe(-1));
  });
});

describe("makeIdleReaper", () => {
  test("fires onIdle after the window when never touched again", async () => {
    let fired = 0;
    const reaper = makeIdleReaper({ idleMs: 20, onIdle: () => fired++ });
    expect(reaper.enabled).toBe(true);
    reaper.touch();
    await sleep(50);
    expect(fired).toBe(1);
  });

  test("each touch resets the clock", async () => {
    let fired = 0;
    const reaper = makeIdleReaper({ idleMs: 40, onIdle: () => fired++ });
    reaper.touch();
    for (let i = 0; i < 4; i++) {
      await sleep(20);
      reaper.touch();
    }
    expect(fired).toBe(0);
    reaper.stop();
  });

  test("stop cancels a pending reap", async () => {
    let fired = 0;
    const reaper = makeIdleReaper({ idleMs: 20, onIdle: () => fired++ });
    reaper.touch();
    reaper.stop();
    await sleep(50);
    expect(fired).toBe(0);
  });

  test("a non-positive idleMs disables the reaper", async () => {
    let fired = 0;
    const reaper = makeIdleReaper({ idleMs: 0, onIdle: () => fired++ });
    expect(reaper.enabled).toBe(false);
    reaper.touch();
    await sleep(30);
    expect(fired).toBe(0);
  });
});

describe("withIdleReaper", () => {
  class FakeTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;
    sent: JSONRPCMessage[] = [];

    async start(): Promise<void> {}
    async send(message: JSONRPCMessage): Promise<void> {
      this.sent.push(message);
    }
    async close(): Promise<void> {
      this.onclose?.();
    }
    receive(message: JSONRPCMessage): void {
      this.onmessage?.(message);
    }
  }

  test("does not reap while a request is in flight, then reaps after the response", async () => {
    let fired = 0;
    const inner = new FakeTransport();
    const transport = withIdleReaper(
      inner,
      makeIdleReaper({ idleMs: 100, onIdle: () => fired++ }),
    );
    transport.onmessage = () => {};
    await transport.start();

    inner.receive({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} });
    await sleep(180);
    expect(fired).toBe(0);

    await transport.send({ jsonrpc: "2.0", id: 1, result: {} });
    await sleep(140);
    expect(fired).toBe(1);
  });
});
