// Inline consent handshake for `fbrain init`.
//
// Removes the "two-terminal dance" on the brew happy path: today `fbrain init`
// stops at "schemas loaded" and the FIRST `fbrain put` (or design/task new)
// has to print "First-run setup — run: `folddb consent grant fbrain` in your
// terminal" and poll while the user opens a second terminal. For the
// single-user local CLI (the person running fbrain IS the node owner), that's
// a papercut.
//
// What this module adds at the END of init (after schemas load):
//   1. If a valid capability is already stored → silent no-op (idempotent
//      re-init never re-prompts).
//   2. Else, prompt the user once on a TTY: "Grant now? [Y/n]".
//   3. On yes: request-consent, then shell out to `folddb consent grant
//      <app_id> --yes` (guaranteed on PATH for brew installs), then poll
//      consent-status until the capability is stored on disk.
//   4. If `folddb` is NOT on PATH (contributor running from source), fall
//      back to printing the manual grant instruction exactly as today — the
//      polling loop still completes when the user runs it.
//   5. Non-TTY (CI/scripts) or declined prompt: skip with a one-line note;
//      the existing in-write polling path stays as the fallback.
//   6. `nonInteractiveGrant: true` (driven by `fbrain init --grant-consent`):
//      same handshake without a TTY — request-consent, shell out, poll —
//      so scripted / CI / agent installs reach a ready-to-write state in
//      one shot. The flag IS the explicit approval (the operator typed it),
//      so the [Y/n] prompt is bypassed but enforcement-off + already-granted
//      idempotency still hold.
//
// Security: consent stays EXPLICIT and owner-approved. The interactive
// prompt is one form of explicit approval; the `--grant-consent` flag is
// another (the operator typed it on the install command line). Neither path
// auto-grants silently — both fire only after the operator opts in.

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

import {
  acquireCapability,
  FBRAIN_APP_ID,
  hasValidCachedCapability,
  type CapabilityStore,
  type ConsentTransport,
} from "../capability.ts";
import { defaultCapabilityStore } from "../keychain.ts";
import { newNodeClient, type Verbose } from "../client.ts";
import { resolvePrintSink } from "../format.ts";
import { appIdentityEnforceEnabled } from "../write-context.ts";

export type EstablishConsentOptions = {
  nodeUrl: string;
  userHash: string;
  appId?: string;
  scope?: string;
  print?: (line: string) => void;
  verbose?: Verbose;
  // Injection seams for tests:
  store?: CapabilityStore;
  /** Override the consent transport (default: built from a NodeClient). */
  transport?: ConsentTransport;
  /** Prompt the user; default reads stdin/stdout via readline. */
  ask?: (question: string) => Promise<string>;
  /** Locate the folddb CLI; default scans PATH. */
  resolveFolddb?: () => string | null;
  /**
   * Invoke `folddb consent grant`. Receives the fbrain `--node-url` so the
   * default implementation can pin `FOLDDB_PORT` and avoid the grant landing on
   * a sibling daemon (see defaultRunFolddbGrant). Default: `spawnSync`-shells
   * out.
   */
  runFolddbGrant?: (
    folddbPath: string,
    appId: string,
    nodeUrl: string,
  ) => GrantResult;
  /** Treat the current process as a TTY (default: process.stdin.isTTY). */
  isTty?: () => boolean;
  /**
   * Drive the inline grant without a TTY (the operator's --grant-consent on
   * the install command line IS the explicit approval). Skips the [Y/n] ask
   * and the non-TTY skip; still honours enforce-off (no-op message) and the
   * already-granted idempotency.
   */
  nonInteractiveGrant?: boolean;
  // Consent polling tuning (forwarded to acquireCapability):
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  maxWaitMs?: number;
};

export type GrantResult = {
  status: number | null;
  stderr?: string;
  /**
   * The grant shell-out was killed because it exceeded the bounded timeout
   * (the folddb CLI hung — see defaultRunFolddbGrant). Callers map this to an
   * actionable "node may be wedged, grant manually" message instead of
   * treating it as a generic non-zero exit.
   */
  timedOut?: boolean;
};

// How long to wait for `folddb consent grant` before giving up. Generous for a
// healthy grant (the daemon round-trip is sub-second), bounded so a wedged /
// slow CLI can't freeze `fbrain init --grant-consent` forever (the 0.15.0 brew
// binary hangs on ANY startup — see init-grant-consent-shellout-timeout). Env
// override `FBRAIN_FOLDDB_GRANT_TIMEOUT_MS` for slow machines / debugging.
const DEFAULT_FOLDDB_GRANT_TIMEOUT_MS = 45_000;

/**
 * Resolve the grant shell-out timeout in ms. Honours
 * `FBRAIN_FOLDDB_GRANT_TIMEOUT_MS` when it parses to a positive integer;
 * otherwise falls back to the default. Exported for tests.
 */
export function folddbGrantTimeoutMs(): number {
  const raw = process.env.FBRAIN_FOLDDB_GRANT_TIMEOUT_MS;
  if (raw !== undefined && raw.length > 0) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return DEFAULT_FOLDDB_GRANT_TIMEOUT_MS;
}

export type EstablishConsentResult =
  | { state: "skipped"; reason: SkipReason }
  | { state: "already_granted" }
  | { state: "granted_inline"; folddbUsed: boolean };

export type SkipReason = "enforce_off" | "non_tty" | "no_folddb_bin" | "declined";

// The node's CLI binary name. The FoldDB→LastDB rebrand renamed the binary to
// `lastdb` (fold#951), keeping `folddb` as a back-compat shim. We display and
// prefer `lastdb`; `defaultResolveFolddb` falls back to the legacy `folddb`
// name on older installs so a node that only ships the shim still resolves.
const FOLDDB_BIN = "lastdb";
const LEGACY_FOLDDB_BIN = "folddb";

/**
 * Run the inline consent handshake at the end of `fbrain init`. Returns a
 * structured result so callers (and tests) can introspect why init did or
 * didn't acquire a capability. Never throws on a "user said no" branch — only
 * a genuine consent error (denial, expiry, transport failure) propagates.
 */
export async function establishConsentInline(
  opts: EstablishConsentOptions,
): Promise<EstablishConsentResult> {
  const print = resolvePrintSink(opts);
  const appId = opts.appId ?? FBRAIN_APP_ID;
  const store = opts.store ?? defaultCapabilityStore();

  // Enforcement off (FBRAIN_APP_IDENTITY_ENFORCE=false): no capability needed.
  // --grant-consent is a no-op here; print a friendly note so the operator
  // doesn't think the flag silently failed.
  if (!appIdentityEnforceEnabled()) {
    if (opts.nonInteractiveGrant) {
      print(`        app-identity enforcement off — --grant-consent is a no-op (no capability needed).`);
    } else {
      print(`        app-identity enforcement off — skipping consent step.`);
    }
    return { state: "skipped", reason: "enforce_off" };
  }

  // Idempotency: a live capability on disk → silent no-op so re-running init
  // never re-prompts (and --grant-consent is safe to re-run in scripts).
  if (await hasValidCachedCapability(store, opts.nodeUrl, appId)) {
    print(`        ${appId} consent already granted — skipping.`);
    return { state: "already_granted" };
  }

  const resolveFolddb = opts.resolveFolddb ?? defaultResolveFolddb;

  // --grant-consent in a non-TTY shell relies entirely on shelling out to
  // `folddb consent grant` — there's no human to grant in a second terminal.
  // If `folddb` isn't on PATH, the inline grant can never fire and the poll
  // would run for the full consent TTL (~5 min) before failing. Fast-fail with
  // an actionable message instead.
  if (
    opts.nonInteractiveGrant &&
    !(opts.isTty ?? defaultIsTty)() &&
    resolveFolddb() === null
  ) {
    print(
      `        \`${FOLDDB_BIN}\` not found on PATH — cannot complete \`--grant-consent\` non-interactively. Install the lastdb CLI (\`brew install edgevector/lastdb/lastdb\`) and re-run, or grant manually in a second terminal while your first write polls.`,
    );
    return { state: "skipped", reason: "no_folddb_bin" };
  }

  // --grant-consent: the operator typed the flag, so we skip the [Y/n] ask
  // and the non-TTY skip. Falls through to the inline grant block below.
  if (!opts.nonInteractiveGrant) {
    // Non-interactive (CI, scripted init) without --grant-consent: can't
    // prompt — leave the in-write fallback to handle it on first write.
    const isTty = (opts.isTty ?? defaultIsTty)();
    if (!isTty) {
      print(
        `        non-interactive shell — skipping consent prompt. Re-run \`fbrain init --grant-consent\` before your first write — it creates the consent request, grants it, and stores the capability headlessly. (A bare \`${FOLDDB_BIN} consent grant ${appId}\` needs a pending request first, so it dead-ends on a fresh node.)`,
      );
      return { state: "skipped", reason: "non_tty" };
    }

    // Explicit one-time approval.
    const ask = opts.ask ?? defaultAsk;
    const answer = await ask(
      `fbrain wants read/write access to its namespace on this node. Grant now? [Y/n] `,
    );
    if (!isAffirmative(answer)) {
      print(
        `        skipped — run \`${FOLDDB_BIN} consent grant ${appId}\` later, or fbrain will prompt on first write.`,
      );
      return { state: "skipped", reason: "declined" };
    }
  }

  // Build the consent transport (request-consent + consent-status against the
  // node) unless a test injects one. The capability provider is null — these
  // are unauthenticated handshake endpoints.
  const transport =
    opts.transport ??
    transportFromNode(opts.nodeUrl, opts.userHash, opts.verbose);

  const runFolddbGrant = opts.runFolddbGrant ?? defaultRunFolddbGrant;

  let folddbUsed = false;
  const acquireOpts: Parameters<typeof acquireCapability>[0] = {
    appId,
    nodeUrl: opts.nodeUrl,
    transport,
    store,
    print,
    onConsentRequested: async (ctx) => {
      const folddb = resolveFolddb();
      if (folddb === null) {
        ctx.print(
          `        \`${FOLDDB_BIN}\` not found on PATH — run \`${FOLDDB_BIN} consent grant ${ctx.appId}\` in another terminal to complete the grant.`,
        );
        return;
      }
      ctx.print(`        running \`${FOLDDB_BIN} consent grant ${ctx.appId} --yes\``);
      const result = runFolddbGrant(folddb, ctx.appId, opts.nodeUrl);
      if (result.status === 0) {
        folddbUsed = true;
      } else if (result.timedOut) {
        // The folddb CLI hung past the bounded timeout (a slow node binary —
        // 0.15.x brew can do this on a first/cold startup). Don't let init
        // freeze, and don't pre-judge the outcome: the very next step is
        // acquireCapability's poll, which is the AUTHORITATIVE verdict. The
        // grant frequently DID land despite the CLI being slow to return, in
        // which case the poll prints `Access granted. Capability stored.` and a
        // "grant manually / re-run fbrain doctor" instruction here would be
        // stale and contradictory. So print a neutral "the CLI was slow,
        // confirming whether the grant landed anyway" note and let the poll own
        // the guidance — success on success; `consent_timeout`/`consent_denied`/
        // `consent_expired` with their own actionable hints on genuine failure.
        const secs = Math.round(folddbGrantTimeoutMs() / 1000);
        ctx.print(
          `        \`${FOLDDB_BIN} consent grant ${ctx.appId}\` is taking longer than ${secs}s (the ${FOLDDB_BIN} CLI can be slow on a first / cold run) — confirming whether the grant landed anyway…`,
        );
      } else {
        const detail = result.stderr ? `: ${result.stderr.trim()}` : "";
        ctx.print(
          `        \`${FOLDDB_BIN} consent grant\` exited with status ${result.status ?? "unknown"}${detail}.`,
        );
        // Targeted diagnostic for the Lane-D durable-autostart pattern: the
        // node was provisioned with a plist-pinned FOLDDB_MASTER_KEY, but this
        // shell doesn't have the key exported, so the subprocess can't decrypt
        // the on-disk node identity. The raw folddb error names the env var
        // but not what fbrain operators should actually run — guide them.
        if (looksLikeMasterKeyFailure(result.stderr)) {
          ctx.print(
            `        this node was provisioned with \`FOLDDB_MASTER_KEY\` — re-run as \`FOLDDB_MASTER_KEY=<hex> fbrain init --grant-consent\`, or run \`${FOLDDB_BIN} consent grant ${ctx.appId}\` in a shell that has the key exported.`,
          );
        } else {
          ctx.print(
            `        retry manually with \`${FOLDDB_BIN} consent grant ${ctx.appId}\` while this command keeps polling.`,
          );
        }
      }
    },
  };
  if (opts.scope !== undefined) acquireOpts.scope = opts.scope;
  if (opts.verbose !== undefined) acquireOpts.verbose = opts.verbose;
  if (opts.pollIntervalMs !== undefined) acquireOpts.pollIntervalMs = opts.pollIntervalMs;
  if (opts.sleep !== undefined) acquireOpts.sleep = opts.sleep;
  if (opts.maxWaitMs !== undefined) acquireOpts.maxWaitMs = opts.maxWaitMs;

  await acquireCapability(acquireOpts);
  return { state: "granted_inline", folddbUsed };
}

function transportFromNode(
  nodeUrl: string,
  userHash: string,
  verbose: Verbose | undefined,
): ConsentTransport {
  const nodeOpts: Parameters<typeof newNodeClient>[0] = {
    baseUrl: nodeUrl,
    userHash,
    capability: () => null,
  };
  if (verbose !== undefined) nodeOpts.verbose = verbose;
  const node = newNodeClient(nodeOpts);
  return {
    requestConsent: (appId, scope) => node.requestConsent(appId, scope),
    consentStatus: (requestId) => node.consentStatus(requestId),
  };
}

function isAffirmative(answer: string): boolean {
  const v = answer.trim().toLowerCase();
  // Default ("just hit enter") → yes, per the [Y/n] prompt convention.
  return v === "" || v === "y" || v === "yes";
}

const defaultAsk = async (question: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
};

function defaultIsTty(): boolean {
  return Boolean(process.stdin.isTTY);
}

function defaultResolveFolddb(): string | null {
  // Honour an explicit override first (tests + contributors who have folddb
  // outside their PATH can point at it directly).
  const override = process.env.FBRAIN_FOLDDB_BIN;
  if (override && override.length > 0) return override;
  // Use `command -v` instead of `which` — it's POSIX and behaves identically
  // on macOS + Linux. Run via /bin/sh so PATH expansion uses the user's env.
  // Prefer the renamed `lastdb` binary; fall back to the legacy `folddb` name
  // so older installs that only ship the back-compat shim still resolve.
  for (const bin of [FOLDDB_BIN, LEGACY_FOLDDB_BIN]) {
    const probe = spawnSync("/bin/sh", ["-c", `command -v ${bin}`], {
      encoding: "utf8",
    });
    if (probe.status !== 0) continue;
    const path = (probe.stdout ?? "").trim();
    if (path.length > 0) return path;
  }
  return null;
}

/**
 * Default `runFolddbGrant`: shells out to `folddb consent grant <app> --yes`,
 * pinning FOLDDB_PORT for loopback nodes and bounding the call with a timeout
 * so a wedged CLI can't hang init. Exported for tests.
 */
export function defaultRunFolddbGrant(
  folddbPath: string,
  appId: string,
  nodeUrl: string,
): GrantResult {
  // Pin `FOLDDB_PORT` when fbrain is talking to a local node on a parseable
  // port — otherwise `folddb consent grant` discovers its target by reading
  // `$FOLDDB_HOME/port`, which reflects the LAST daemon started under that
  // HOME, not the one fbrain init was pointed at. Without this, running
  // `fbrain init --node-url http://127.0.0.1:<slot>` while a brew daemon is
  // also up on 9001 silently grants on 9001 and fbrain's first write stalls.
  //
  // Defensive: only pin when nodeUrl is loopback with a numeric port. Remote
  // hosts and unparseable URLs fall back to today's discovery behavior so we
  // don't break setups where pinning would be wrong (e.g. an SSH-tunneled
  // node whose local port doesn't match the daemon's own port).
  const env = { ...process.env };
  const port = loopbackPortFromUrl(nodeUrl);
  if (port !== null) {
    env.FOLDDB_PORT = String(port);
  }
  // Inherit stdio so the user sees folddb's own progress + any TUI it emits
  // (the grant is fast but the daemon may print a one-line confirmation).
  //
  // Bound the call with a timeout: without it, a wedged folddb CLI (the 0.15.0
  // brew binary hangs on ANY startup) freezes `fbrain init --grant-consent`
  // forever at step [6/6] with zero feedback. On timeout spawnSync sends
  // SIGTERM and surfaces it via res.error (code "ETIMEDOUT") + res.signal
  // ("SIGTERM") with res.status === null.
  const res = spawnSync(folddbPath, ["consent", "grant", appId, "--yes"], {
    stdio: ["ignore", "inherit", "pipe"],
    encoding: "utf8",
    env,
    timeout: folddbGrantTimeoutMs(),
  });
  if (isTimeoutResult(res)) {
    const out: GrantResult = { status: null, timedOut: true };
    if (typeof res.stderr === "string" && res.stderr.length > 0) {
      out.stderr = res.stderr;
    }
    return out;
  }
  const out: GrantResult = { status: res.status };
  if (typeof res.stderr === "string" && res.stderr.length > 0) {
    out.stderr = res.stderr;
  }
  return out;
}

/**
 * Detect the spawnSync timeout shape. Node kills the child with SIGTERM when
 * `timeout` elapses and reports it via `res.error` (an Error whose `code` is
 * "ETIMEDOUT") with `res.signal === "SIGTERM"` and a null status. We accept
 * either signal — the env var override allows callers to swap the kill signal
 * in principle — so we key primarily on the ETIMEDOUT error code, with the
 * SIGTERM-on-null-status shape as a defensive fallback.
 */
function isTimeoutResult(
  res: ReturnType<typeof spawnSync>,
): boolean {
  const err = res.error as (Error & { code?: string }) | undefined;
  if (err && err.code === "ETIMEDOUT") return true;
  // Fallback: spawnSync killed the child via signal with no exit status. A
  // bare SIGTERM with a null status is the timeout shape on platforms where
  // the error code doesn't surface cleanly.
  if (res.status === null && res.signal === "SIGTERM") return true;
  return false;
}

/**
 * Return the numeric port from a loopback `nodeUrl` (127.0.0.1 / ::1 /
 * localhost). Returns null if the URL is unparseable, points at a non-loopback
 * host, or has no explicit numeric port — those cases keep folddb's portfile
 * discovery in charge.
 *
 * Exported for tests.
 */
export function loopbackPortFromUrl(nodeUrl: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(nodeUrl);
  } catch {
    return null;
  }
  if (!isLoopbackHost(parsed.hostname)) return null;
  if (parsed.port === "") return null;
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return port;
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
}

/**
 * Heuristic for the `folddb consent grant` failure where the target node was
 * provisioned with `FOLDDB_MASTER_KEY` (its on-disk identity is encrypted)
 * but the shell running `fbrain init` doesn't have the key exported — the
 * exact Lane-D durable-autostart shape. Matches on either the env-var name
 * or the keychain-feature phrasing so we catch the message regardless of
 * minor wording drift in folddb's error text.
 *
 * Exported for tests.
 */
export function looksLikeMasterKeyFailure(stderr: string | undefined): boolean {
  if (!stderr) return false;
  return stderr.includes("FOLDDB_MASTER_KEY") || stderr.includes("os-keychain");
}
