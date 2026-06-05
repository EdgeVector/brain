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
  /** Invoke `folddb consent grant`; default `spawnSync`-shells out. */
  runFolddbGrant?: (folddbPath: string, appId: string) => GrantResult;
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
};

export type EstablishConsentResult =
  | { state: "skipped"; reason: SkipReason }
  | { state: "already_granted" }
  | { state: "granted_inline"; folddbUsed: boolean };

export type SkipReason = "enforce_off" | "non_tty" | "declined";

const FOLDDB_BIN = "folddb";

/**
 * Run the inline consent handshake at the end of `fbrain init`. Returns a
 * structured result so callers (and tests) can introspect why init did or
 * didn't acquire a capability. Never throws on a "user said no" branch — only
 * a genuine consent error (denial, expiry, transport failure) propagates.
 */
export async function establishConsentInline(
  opts: EstablishConsentOptions,
): Promise<EstablishConsentResult> {
  const print = opts.print ?? ((line: string) => console.log(line));
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

  // --grant-consent: the operator typed the flag, so we skip the [Y/n] ask
  // and the non-TTY skip. Falls through to the inline grant block below.
  if (!opts.nonInteractiveGrant) {
    // Non-interactive (CI, scripted init) without --grant-consent: can't
    // prompt — leave the in-write fallback to handle it on first write.
    const isTty = (opts.isTty ?? defaultIsTty)();
    if (!isTty) {
      print(
        `        non-interactive shell — skipping consent prompt. Run \`folddb consent grant ${appId}\` before your first write, or re-run \`fbrain init --grant-consent\`.`,
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
        `        skipped — run \`folddb consent grant ${appId}\` later, or fbrain will prompt on first write.`,
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

  const resolveFolddb = opts.resolveFolddb ?? defaultResolveFolddb;
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
      const result = runFolddbGrant(folddb, ctx.appId);
      if (result.status === 0) {
        folddbUsed = true;
      } else {
        const detail = result.stderr ? `: ${result.stderr.trim()}` : "";
        ctx.print(
          `        \`${FOLDDB_BIN} consent grant\` exited with status ${result.status ?? "unknown"}${detail}.`,
        );
        ctx.print(
          `        retry manually with \`${FOLDDB_BIN} consent grant ${ctx.appId}\` while this command keeps polling.`,
        );
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
  const probe = spawnSync("/bin/sh", ["-c", `command -v ${FOLDDB_BIN}`], {
    encoding: "utf8",
  });
  if (probe.status !== 0) return null;
  const path = (probe.stdout ?? "").trim();
  return path.length > 0 ? path : null;
}

function defaultRunFolddbGrant(folddbPath: string, appId: string): GrantResult {
  // Inherit stdio so the user sees folddb's own progress + any TUI it emits
  // (the grant is fast but the daemon may print a one-line confirmation).
  const res = spawnSync(folddbPath, ["consent", "grant", appId, "--yes"], {
    stdio: ["ignore", "inherit", "pipe"],
    encoding: "utf8",
  });
  const out: GrantResult = { status: res.status };
  if (typeof res.stderr === "string" && res.stderr.length > 0) {
    out.stderr = res.stderr;
  }
  return out;
}
