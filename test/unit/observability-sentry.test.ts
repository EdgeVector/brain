import { describe, expect, test } from "bun:test";
import {
  captureSentryException,
  initSentry,
  parseObsSentryDsn,
  type SentryModule,
} from "../../src/observability/sentry";

/**
 * Capture everything written to BOTH std streams while `run` executes.
 *
 * stdout is the machine channel for every JSON CLI subcommand (`brain ask
 * --json | jq`). A diagnostic that lands there is a defect, so the test
 * asserts the stdout side too — flipping `process.stderr.write` back to
 * `console.log` must fail this test, not pass it quietly.
 */
async function captureStdio<T>(
  run: () => Promise<T>,
): Promise<{ result: T; stderr: string; stdout: string }> {
  const errWrites: string[] = [];
  const outWrites: string[] = [];
  const originalErr = process.stderr.write.bind(process.stderr);
  const originalOut = process.stdout.write.bind(process.stdout);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    errWrites.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    outWrites.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write;

  try {
    const result = await run();
    return { result, stderr: errWrites.join(""), stdout: outWrites.join("") };
  } finally {
    process.stderr.write = originalErr;
    process.stdout.write = originalOut;
  }
}

function mockSentry() {
  const initCalls: unknown[] = [];
  const captures: unknown[] = [];
  let flushes = 0;
  const module: SentryModule = {
    init(options) {
      initCalls.push(options);
    },
    captureException(error, context) {
      captures.push({ error, context });
    },
    async flush() {
      flushes += 1;
      return true;
    },
  };
  return {
    module,
    initCalls,
    captures,
    get flushes() {
      return flushes;
    },
  };
}

describe("Sentry observability helper", () => {
  test("no-ops when OBS_SENTRY_DSN is unset", async () => {
    const sentry = mockSentry();

    const result = await initSentry({
      service: "fbrain-cli",
      env: {},
      sentryModule: sentry.module,
      installProcessHandlers: false,
    });

    expect(result).toEqual({ enabled: false, reason: "missing_dsn" });
    expect(sentry.initCalls).toHaveLength(0);
  });

  test("initializes with service, release, environment, and event redaction", async () => {
    const sentry = mockSentry();

    const result = await initSentry({
      service: "fbrain-cli",
      env: {
        OBS_SENTRY_DSN: "https://public@example.invalid/1",
        OBS_SENTRY_ENVIRONMENT: "test",
        OBS_SENTRY_RELEASE: "fbrain@0.8.0",
      },
      sentryModule: sentry.module,
      installProcessHandlers: false,
    });

    expect(result).toEqual({
      enabled: true,
      service: "fbrain-cli",
      environment: "test",
      release: "fbrain@0.8.0",
    });
    expect(sentry.initCalls).toHaveLength(1);

    const options = (sentry.initCalls as Array<{
      dsn: string;
      environment: string;
      release: string;
      initialScope: { tags: Record<string, string> };
      beforeSend: (event: {
        request: { cookies: string; headers: Record<string, string> };
        extra: Record<string, string>;
      }) => unknown;
    }>)[0]!;

    expect(options.dsn).toBe("https://public@example.invalid/1");
    expect(options.initialScope.tags.service).toBe("fbrain-cli");

    const redacted = options.beforeSend({
      request: {
        cookies: "session=secret",
        headers: {
          Authorization: "Bearer secret",
          "X-Api-Key": "secret",
          Accept: "application/json",
        },
      },
      extra: {
        token: "secret",
        safe: "value",
      },
    }) as {
      request: { cookies: string; headers: Record<string, string> };
      extra: Record<string, string>;
    };

    expect(redacted.request.cookies).toBe("[redacted]");
    expect(redacted.request.headers.Authorization).toBe("[redacted]");
    expect(redacted.request.headers["X-Api-Key"]).toBe("[redacted]");
    expect(redacted.request.headers.Accept).toBe("application/json");
    expect(redacted.extra.token).toBe("[redacted]");
    expect(redacted.extra.safe).toBe("value");
  });

  test("captures top-level failures after initialization", async () => {
    const sentry = mockSentry();
    const error = new Error("synthetic top-level failure");

    await initSentry({
      service: "fbrain-cli",
      env: { OBS_SENTRY_DSN: "https://public@example.invalid/1" },
      sentryModule: sentry.module,
      installProcessHandlers: false,
    });
    await captureSentryException(error, { entrypoint: "cli", top_level: "true" });

    expect(sentry.captures).toEqual([
      {
        error,
        context: {
          tags: {
            service: "fbrain-cli",
            entrypoint: "cli",
            top_level: "true",
          },
        },
      },
    ]);
    expect(sentry.flushes).toBe(1);
  });

  test("parseObsSentryDsn rejects lastsecrets and non-DSN values", () => {
    expect(parseObsSentryDsn("")).toBeNull();
    expect(parseObsSentryDsn("lastsecrets://obs-sentry-dsn-routines")).toBeNull();
    expect(parseObsSentryDsn("not-a-sentry-dsn")).toBeNull();
    expect(parseObsSentryDsn("https://public@example.invalid/1")).toBe(
      "https://public@example.invalid/1",
    );
  });

  test("stays silent on a lastsecrets locator without OBS_SENTRY_DEBUG", async () => {
    const sentry = mockSentry();

    const { result, stderr, stdout } = await captureStdio(() =>
      initSentry({
        service: "fbrain-cli",
        env: { OBS_SENTRY_DSN: "lastsecrets://obs-sentry-dsn-routines" },
        sentryModule: sentry.module,
        installProcessHandlers: false,
      }),
    );

    expect(result).toEqual({ enabled: false, reason: "invalid_dsn" });
    expect(sentry.initCalls).toHaveLength(0);
    // A locator is the expected value in every routine shell. Printing it on
    // each CLI invocation is the fleet-wide noise this gate removes.
    expect(stderr).not.toContain("observability:");
    expect(stdout).toBe("");
  });

  test("warns on a lastsecrets locator when OBS_SENTRY_DEBUG=1 — stderr only", async () => {
    const sentry = mockSentry();

    const { result, stderr, stdout } = await captureStdio(() =>
      initSentry({
        service: "fbrain-cli",
        env: {
          OBS_SENTRY_DSN: "lastsecrets://obs-sentry-dsn-routines",
          OBS_SENTRY_DEBUG: "1",
        },
        sentryModule: sentry.module,
        installProcessHandlers: false,
      }),
    );

    expect(result).toEqual({ enabled: false, reason: "invalid_dsn" });
    expect(sentry.initCalls).toHaveLength(0);
    expect(stderr).toContain(
      "observability: OBS_SENTRY_DSN is lastsecrets locator (not a Sentry DSN)",
    );
    // The diagnostic must never reach the JSON channel.
    expect(stdout).toBe("");
  });

  test("no-ops without calling Sentry.init when DSN is garbage", async () => {
    const sentry = mockSentry();

    const { result, stderr, stdout } = await captureStdio(() =>
      initSentry({
        service: "fbrain-cli",
        env: { OBS_SENTRY_DSN: "not-a-sentry-dsn", OBS_SENTRY_DEBUG: "1" },
        sentryModule: sentry.module,
        installProcessHandlers: false,
      }),
    );

    expect(result).toEqual({ enabled: false, reason: "invalid_dsn" });
    expect(sentry.initCalls).toHaveLength(0);
    expect(stderr).toContain("not a valid https Sentry DSN");
    expect(stdout).toBe("");
  });
});
