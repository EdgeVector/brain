// `brain init` has to finish inside the public first-run bound.
//
// The 25 owned schemas were declared one at a time. Each `/api/apps/declare-
// schema` costs the node seconds against the catalog, so on a fresh isolated
// LastDB home on 2026-08-30 the pass alone ran ~450 s and the llms-txt install
// smoke's 120 s bound killed init mid-list. Because the config was written only
// after every step, a killed init left NO config, and one slow step reported as
// four separate failures: "Config not found at ~/.brain/config.json".
//
// Three behaviours keep that from recurring, and each is pinned here:
//   1. declarations run as a bounded concurrent pool,
//   2. the config is checkpointed DURING the pass, not only after it,
//   3. the best-effort deferred-409 retry cannot outlive its own budget.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_DECLARE_CONCURRENCY,
  DEFAULT_DEFERRED_RETRY_BUDGET_MS,
  declareConcurrency,
  deferredRetryBudgetMs,
  mapWithConcurrency,
  runInit,
  withDeadline,
} from "../../src/commands/init.ts";
import { UNIQUE_SCHEMAS } from "../../src/schemas.ts";
import type { Config } from "../../src/config.ts";

const realFetch = globalThis.fetch;
const savedConcurrency = process.env.FBRAIN_INIT_DECLARE_CONCURRENCY;
const savedBudget = process.env.FBRAIN_INIT_DEFERRED_RETRY_BUDGET_MS;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("mapWithConcurrency", () => {
  test("never exceeds the limit and keeps INPUT order, not completion order", async () => {
    const items = [40, 5, 30, 1, 20, 2, 10];
    let inFlight = 0;
    let peak = 0;
    const settled = await mapWithConcurrency(items, 3, async (ms) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(ms);
      inFlight -= 1;
      return ms;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
    expect(settled.map((r) => (r.ok ? r.value : null))).toEqual(items);
  });

  test("a thrown worker is captured per item — siblings still run", async () => {
    const settled = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    });
    expect(settled[0]).toEqual({ ok: true, value: 1 });
    expect(settled[1]?.ok).toBe(false);
    expect(settled[2]).toEqual({ ok: true, value: 3 });
  });

  test("an empty list resolves without starting a runner", async () => {
    let called = 0;
    const settled = await mapWithConcurrency([], 4, async () => {
      called += 1;
      return 1;
    });
    expect(settled).toEqual([]);
    expect(called).toBe(0);
  });
});

describe("withDeadline", () => {
  test("slow work resolves to the expiry value", async () => {
    const out = await withDeadline(sleep(10_000).then(() => "done"), 20, "expired");
    expect(out).toBe("expired");
  });

  test("fast work wins the race", async () => {
    const out = await withDeadline(sleep(1).then(() => "done"), 5_000, "expired");
    expect(out).toBe("done");
  });

  test("work that rejects AFTER the deadline does not surface as unhandled", async () => {
    // The whole point of the guard: the losing promise still settles, and an
    // unobserved rejection would crash init instead of skipping one schema.
    const late = sleep(30).then(() => {
      throw new Error("late failure");
    });
    expect(await withDeadline(late, 5, "expired")).toBe("expired");
    await sleep(60);
  });

  test("work that rejects BEFORE the deadline still rejects the caller", async () => {
    const boom = Promise.reject(new Error("immediate"));
    await expect(withDeadline(boom, 5_000, "expired")).rejects.toThrow("immediate");
  });
});

describe("tuning knobs", () => {
  afterEach(() => {
    if (savedConcurrency === undefined) delete process.env.FBRAIN_INIT_DECLARE_CONCURRENCY;
    else process.env.FBRAIN_INIT_DECLARE_CONCURRENCY = savedConcurrency;
    if (savedBudget === undefined) delete process.env.FBRAIN_INIT_DEFERRED_RETRY_BUDGET_MS;
    else process.env.FBRAIN_INIT_DEFERRED_RETRY_BUDGET_MS = savedBudget;
  });

  test("unset / empty / junk / zero all fall back to the default width", () => {
    delete process.env.FBRAIN_INIT_DECLARE_CONCURRENCY;
    expect(declareConcurrency()).toBe(DEFAULT_DECLARE_CONCURRENCY);
    for (const raw of ["", "nonsense", "0", "-3"]) {
      process.env.FBRAIN_INIT_DECLARE_CONCURRENCY = raw;
      expect(declareConcurrency()).toBe(DEFAULT_DECLARE_CONCURRENCY);
    }
    process.env.FBRAIN_INIT_DECLARE_CONCURRENCY = "9";
    expect(declareConcurrency()).toBe(9);
  });

  test("the deferred-retry budget takes an override, including 0 to skip it", () => {
    delete process.env.FBRAIN_INIT_DEFERRED_RETRY_BUDGET_MS;
    expect(deferredRetryBudgetMs()).toBe(DEFAULT_DEFERRED_RETRY_BUDGET_MS);
    process.env.FBRAIN_INIT_DEFERRED_RETRY_BUDGET_MS = "0";
    expect(deferredRetryBudgetMs()).toBe(0);
    process.env.FBRAIN_INIT_DEFERRED_RETRY_BUDGET_MS = "1500";
    expect(deferredRetryBudgetMs()).toBe(1500);
    process.env.FBRAIN_INIT_DEFERRED_RETRY_BUDGET_MS = "junk";
    expect(deferredRetryBudgetMs()).toBe(DEFAULT_DEFERRED_RETRY_BUDGET_MS);
  });
});

describe("runInit declaration pass", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
    if (savedConcurrency === undefined) delete process.env.FBRAIN_INIT_DECLARE_CONCURRENCY;
    else process.env.FBRAIN_INIT_DECLARE_CONCURRENCY = savedConcurrency;
  });

  // A node that supports local declare and answers every schema after a delay.
  // The delay is what makes the sequential-vs-concurrent difference measurable
  // without depending on a real node's registration cost.
  function installSlowDeclareMock(delayMs: number, peak: { inFlight: number; max: number }): void {
    globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const json = (status: number, body: unknown): Response =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });

      if (url.endsWith("/api/system/auto-identity")) {
        return json(200, { user_hash: "synthetic-user-hash-0001", provisioned: true });
      }
      if (url.endsWith("/api/apps/declare-schema") && method === "POST") {
        peak.inFlight += 1;
        peak.max = Math.max(peak.max, peak.inFlight);
        await sleep(delayMs);
        peak.inFlight -= 1;
        const body = typeof init?.body === "string" ? init.body : "{}";
        const name = String(body.match(/"descriptive_name"\s*:\s*"([^"]+)"/)?.[1] ?? "Unknown");
        return json(200, {
          app_id: "fbrain",
          schema: name,
          canonical: "c".repeat(64),
          resolution: "reuse",
        });
      }
      if (url.endsWith("/api/schemas")) return json(200, { schemas: [] });
      return json(200, {});
    }) as typeof fetch;
  }

  test("declares concurrently, and checkpoints the config before the pass ends", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "fbrain-init-concurrency-"));
    const configPath = join(tmpDir, "config.json");
    process.env.FBRAIN_INIT_DECLARE_CONCURRENCY = "5";
    const peak = { inFlight: 0, max: 0 };
    const perCallMs = 25;
    installSlowDeclareMock(perCallMs, peak);

    const lines: string[] = [];
    const started = Date.now();
    const result = await runInit({
      configPath,
      nodeUrl: "http://127.0.0.1:9001",
      schemaServiceUrl: "https://schema.example/v1",
      print: (l) => lines.push(l),
      consent: { isTty: () => false },
    });
    const elapsed = Date.now() - started;

    // The pool ran wide, and it respected its bound.
    expect(peak.max).toBeGreaterThan(1);
    expect(peak.max).toBeLessThanOrEqual(5);
    // Sequential would cost at least 25 x 25ms = 625ms of pure delay.
    expect(elapsed).toBeLessThan(UNIQUE_SCHEMAS.length * perCallMs);
    expect(lines.some((l) => l.includes("(5 at a time)"))).toBe(true);

    // The checkpoint landed BEFORE the last schema, so a first run killed at
    // the smoke's bound leaves a config behind instead of nothing.
    const checkpointAt = lines.findIndex((l) => l.includes("checkpointed config"));
    const lastSchemaAt = lines.findLastIndex((l) => l.includes(`[${UNIQUE_SCHEMAS.length}/`));
    expect(checkpointAt).toBeGreaterThanOrEqual(0);
    expect(lastSchemaAt).toBeGreaterThan(checkpointAt);

    // And the finished config is still complete and valid on disk.
    expect(existsSync(configPath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(configPath, "utf8")) as Config;
    expect(onDisk.designSchemaHash.length).toBeGreaterThan(0);
    expect(onDisk.taskSchemaHash.length).toBeGreaterThan(0);
    expect(result.config.schemaHashes.design).toBe("c".repeat(64));
  });

  test("a checkpointed config is readable on its own — the partial file is valid", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "fbrain-init-checkpoint-"));
    const configPath = join(tmpDir, "config.json");
    process.env.FBRAIN_INIT_DECLARE_CONCURRENCY = "2";
    const peak = { inFlight: 0, max: 0 };
    installSlowDeclareMock(1, peak);

    let snapshot: string | null = null;
    await runInit({
      configPath,
      nodeUrl: "http://127.0.0.1:9001",
      schemaServiceUrl: "https://schema.example/v1",
      // Read the file the moment init says it checkpointed — this is the state
      // a killed first run leaves on disk.
      print: (l) => {
        if (l.includes("checkpointed config") && snapshot === null) {
          snapshot = readFileSync(configPath, "utf8");
        }
      },
      consent: { isTty: () => false },
    });

    expect(snapshot).not.toBeNull();
    const partial = JSON.parse(snapshot as unknown as string) as Config;
    // The two legacy mirror fields are what `assertConfigShape` rejects when
    // empty, so writing any earlier would produce a file its own reader throws
    // on — worse than no file at all.
    expect(partial.designSchemaHash.length).toBeGreaterThan(0);
    expect(partial.taskSchemaHash.length).toBeGreaterThan(0);
    expect(partial.userHash.length).toBeGreaterThan(0);
    expect(partial.nodeUrl.length).toBeGreaterThan(0);
  });
});
