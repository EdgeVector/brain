import { describe, expect, test } from "bun:test";
import { captureSentryException, initSentry, type SentryModule } from "../../src/observability/sentry";

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
});
