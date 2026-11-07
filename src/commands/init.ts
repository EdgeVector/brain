import { syncOwnedModel } from "../owned-schema-init.ts";
// `brain init` — bootstrap a node (if needed), declare every brain-owned
// multi-key schema, persist the schema pins to ~/.brain/config.json.
//
//   1. probe /api/system/auto-identity
//   2. POST /api/setup/bootstrap if the node is not provisioned
//   3. declare the owned schemas (owned-schema-init.ts); the node must be
//      LastDB API 13 or later
//   4. persist config
//   5. confirm owner-socket access or the remote capability
//
// Idempotent. A re-run verifies an existing multi-key config and keeps its
// pins, and heals URLs that still point at the dead `:9101 / :9102`
// local-schema setup. Config load refuses a config in a retired storage
// model with `home_copy_required`, so init never rewrites one.

import { existsSync, readFileSync } from "node:fs";

import { newNodeClient, BrainError, nodeDownHint, defaultIsFolddbBinaryInstalled, defaultIsTargetPortListening, defaultFolddbSocketPath, isLoopbackNodeUrl, type Verbose } from "../client.ts";
import { OWNER_APP_ID, UNIQUE_SCHEMAS } from "../schemas.ts";
import {
  CONFIG_VERSION,
  ConfigInvalidError,
  defaultConfigPath,
  tryReadConfig,
  writeConfig,
  type Config,
} from "../config.ts";
import {
  establishConsentInline,
  type EstablishConsentOptions,
  type EstablishConsentResult,
} from "./init-consent.ts";
import { resolvePrintSink } from "../format.ts";

export type InitOptions = {
  // Optional — when undefined, the resolver below picks either the existing
  // config's URL (if it isn't a dead local-schema default) or the new
  // default. This lets `brain init` (no flags) auto-heal a stale config
  // without clobbering a user-supplied override.
  nodeUrl?: string;
  schemaServiceUrl?: string;
  configPath?: string;
  bootstrapName?: string;
  verbose?: Verbose;
  print?: (line: string) => void;
  // Retry controls:
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  /** Preserve the existing init flag while confirming owner-socket access. */
  grantConsent?: boolean;
  // Inline consent controls (Step 6/6). When omitted, init
  // runs the real `establishConsentInline` against the configured node.
  consent?: Pick<
    EstablishConsentOptions,
    "store" | "transport" | "isTty" | "pollIntervalMs" | "sleep" | "maxWaitMs"
  >;
};

// Local Mini is Unix-socket only. DEFAULT_NODE_URL is a loopback *marker*
// (hostname only) so clients select socket transport via isLoopbackNodeUrl —
// it is NOT a TCP endpoint. The retired :9001 control plane must never appear
// in new configs or user-facing first-run copy. Schema service is the prod
// cloud Lambda; the dev Lambda is separate from production.
export const DEFAULT_NODE_URL = "http://127.0.0.1";
export const DEFAULT_SCHEMA_SERVICE_URL =
  "https://axo709qs11.execute-api.us-east-1.amazonaws.com";

// Auto-heal triggers: any existing config carrying one of these URLs is
// treated as "still pointing at the dead pre-cloud local-schema setup".
// User overrides (any other URL, including a custom localhost port) are
// preserved verbatim.
const STALE_NODE_URLS: ReadonlySet<string> = new Set([
  "http://127.0.0.1:9101",
  "http://localhost:9101",
  // Retired Mini/full-node TCP control plane — heal to socket-only marker.
  "http://127.0.0.1:9001",
  "http://localhost:9001",
]);
const STALE_SCHEMA_URLS: ReadonlySet<string> = new Set([
  "http://127.0.0.1:9102",
  "http://localhost:9102",
]);

// Default cold-build retry schedule. Two competing cases share one budget:
//   - The COMMON new-dev miss: the node just isn't running yet. init prints
//     socket-first recovery guidance immediately; the dev reads it, starts the
//     node, and wants init to notice *promptly*.
//   - The contributor-from-source case: first `fold/run.sh` compiles Rust and
//     can take a few minutes before the node starts listening, so the TOTAL
//     wait must stay generous.
// The old schedule (5s, 10s, 20s, 30s, 60s, 60s ≈ 3m) covered the build case
// but escalated the *gap* to 60s — a dev who started the daemon mid-wait could
// sit idle for up to a minute before the next probe. A health probe is just a
// cheap loopback GET, so there's no reason to back off that far: poll on a
// short ramp then a flat ~5s cadence. Same ~3m total budget, but the gap is
// capped at MAX_RETRY_GAP_MS so a just-started node is caught within ~5s.
const RETRY_RAMP_MS = [2000, 3000];
export const MAX_RETRY_GAP_MS = 5000;
export const RETRY_TOTAL_BUDGET_MS = 185_000; // matches the old schedule's total
// Non-interactive (no TTY) runs are the documented CI / agent / scripted
// install path (`brain init --grant-consent </dev/null`). For an unattended
// caller the node-down hint is already actionable on the FIRST probe, so a
// ~3-minute retry against a down node is pure dead time — it can't read the
// hint and start the daemon mid-wait. Fail fast after surfacing the hint:
// just the short ramp (~5s total) so the script gets a quick, actionable
// non-zero exit instead of a silent-looking hang. The long
// RETRY_TOTAL_BUDGET_MS still applies to interactive runs, where a
// from-source contributor watching a Rust cold build genuinely wants init to
// keep polling until the node comes up.
export const RETRY_TOTAL_BUDGET_MS_NONINTERACTIVE = 5000;
// On the flat cadence, only emit a "still retrying…" heartbeat every Nth
// attempt so the frequent polls don't spam the terminal (≈ every 30s at 5s).
const RETRY_LOG_EVERY = 6;
export const DEFAULT_RETRY_DELAYS_MS = buildRetrySchedule(RETRY_TOTAL_BUDGET_MS);
export const NONINTERACTIVE_RETRY_DELAYS_MS = buildRetrySchedule(RETRY_TOTAL_BUDGET_MS_NONINTERACTIVE);

// A short ramp (so the very first re-probe is quick) followed by a flat
// MAX_RETRY_GAP_MS cadence, filling out the given total budget. No single gap
// ever exceeds MAX_RETRY_GAP_MS.
function buildRetrySchedule(totalBudgetMs: number): number[] {
  const schedule: number[] = [];
  let total = 0;
  for (const gap of RETRY_RAMP_MS) {
    if (total >= totalBudgetMs) break;
    schedule.push(gap);
    total += gap;
  }
  while (total < totalBudgetMs) {
    schedule.push(MAX_RETRY_GAP_MS);
    total += MAX_RETRY_GAP_MS;
  }
  return schedule;
}

function envRetryDelays(): number[] | null {
  const raw = process.env.BRAIN_INIT_RETRY_DELAYS_MS;
  if (raw === undefined) return null;
  if (raw.length === 0) return [];
  return raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 0);
}

export type InitResult = {
  config: Config;
  bootstrapped: boolean;
  consent: EstablishConsentResult;
};

const STEPS = 6;

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const print = resolvePrintSink(opts);
  const verbose = opts.verbose;
  const bootstrapName = opts.bootstrapName ?? "brain";
  const configPath = opts.configPath ?? defaultConfigPath();
  const priorConfig = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;

  // `tryReadConfig` returns null when the file is absent but THROWS when it
  // exists with malformed contents (truncated JSON, missing field, unknown
  // configVersion from a downgrade, …). Without this catch the throw escapes
  // before any bootstrap work runs — and ConfigInvalidError's own message
  // tells the user to "Re-run `brain init`", trapping them in a dead-end
  // loop where the documented remedy can't recover. Init's whole job is to
  // write a valid config, so treat a corrupt existing file as a fresh init
  // (with a visible notice — silently overwriting user data is worse than
  // the loop).
  let existing: Config | null;
  try {
    existing = tryReadConfig(configPath);
  } catch (err) {
    if (err instanceof ConfigInvalidError) {
      print(`[init] existing config at ${configPath} is invalid (${err.message}) — discarding and re-initializing`);
      existing = null;
    } else {
      throw err;
    }
  }
  if (existing) {
    print(`[init] existing config at ${configPath} — verifying`);
  }

  const resolved = resolveUrls(opts, existing);
  if (resolved.healed.length > 0) {
    print(
      `brain: auto-upgraded config to v${CONFIG_VERSION} with new schema-service URL` +
        ` (replaced ${resolved.healed.join(", ")})`,
    );
  }
  const nodeUrl = resolved.nodeUrl;
  const schemaServiceUrl = resolved.schemaServiceUrl;
  // Resolve the socket path that will actually be used for owner-session
  // attestation. This is what newNodeClient will use internally when
  // connecting, so we persist it to the config so later commands use the same
  // socket without needing to re-supply BRAIN_FOLDDB_SOCKET or LASTDB_HOME.
  const nodeSocketPath = isLoopbackNodeUrl(nodeUrl)
    ? defaultFolddbSocketPath(existing?.nodeSocketPath)
    : undefined;
  // Always echo which node we're targeting and where the URL came from — a dev
  // re-running `init` to confirm "which node am I actually pointed at?" needs
  // the answer on every run.
  let nodeUrlSource: string;
  if (opts.nodeUrl) {
    nodeUrlSource = "from --node-url";
  } else if (existing) {
    nodeUrlSource = `from ${configPath}`;
  } else {
    nodeUrlSource = "default";
  }
  print(`[1/${STEPS}] targeting node at ${formatNodeTarget(nodeUrl)} (${nodeUrlSource})`);

  // Step 0/6: probe identity (with cold-build retry).
  print(`[1/${STEPS}] probing node identity`);
  const probeUserHash = existing?.userHash ?? "init-probe";
  const probeClient = newNodeClient({ 
    baseUrl: nodeUrl, 
    userHash: probeUserHash, 
    verbose: verbose ?? (() => {}),
    socketPath: nodeSocketPath,
  });
  const identity = await probeWithRetry(probeClient, { nodeUrl, sleep: opts.sleep, retryDelaysMs: opts.retryDelaysMs }, print);

  let userHash: string;
  let bootstrapped = false;
  let recoveredIdentity = false;
  if (identity.provisioned) {
    userHash = identity.userHash;
    print(`[2/${STEPS}] node already provisioned (user_hash=${userHash.slice(0, 8)}…) — skipping bootstrap`);
  } else {
    print(`[2/${STEPS}] node not provisioned (${identity.reason}); running bootstrap`);
    try {
      const result = await probeClient.bootstrap(bootstrapName);
      userHash = result.userHash;
      bootstrapped = true;
      print(`        bootstrap ok (user_hash=${userHash.slice(0, 8)}…)`);
    } catch (err) {
      // Option C: the daemon is in the contradictory state where
      // auto-identity says "not provisioned" but bootstrap returns 410
      // "already provisioned". If our local config has a usable userHash
      // from a previous successful init against this node, treat the
      // config as authoritative and continue — the downstream
      // schemas-load step exercises X-User-Hash and will surface
      // `missing_user_context` if the saved userHash is genuinely wrong.
      // No usable config ⇒ rethrow the BrainError so the user sees the
      // node's actual message (e.g. "POST /api/auth/restore …").
      if (
        err instanceof BrainError &&
        err.code === "onboarding_already_complete" &&
        hasUsableExistingConfig(existing)
      ) {
        userHash = existing.userHash;
        recoveredIdentity = true;
        print(
          `        bootstrap refused (node + auto-identity disagree); reusing existing config userHash=${userHash.slice(0, 8)}… and continuing`,
        );
      } else {
        throw err;
      }
    }
  }

  // Step 3/6: declare every brain-owned schema on the node
  // (owned-schema-init.ts). The node returns each runtime address and its
  // definition identity; local mint and the schema_service publish fallback
  // are retired.
  //
  print(`[3/${STEPS}] preparing ${UNIQUE_SCHEMAS.length} brain schemas`);
  // Existing configs retain their data identities. A fresh home may opt in.
  const loadedBefore = existing ? [] : await probeClient.listLoadedSchemas();
  const canonicalVocabulary = existing ? Boolean(existing.schemaFieldAliases)
    : !loadedBefore.some((schema) => schema.owner_app_id === OWNER_APP_ID &&
      schema.fields?.some((field) => ["slug", "body", "blp_h"].includes(field)));
  const nodeClient = newNodeClient({ 
    canonicalVocabulary, schemaFieldAliases:existing?.schemaFieldAliases,
    baseUrl: nodeUrl, 
    userHash, 
    verbose: verbose ?? (() => {}),
    socketPath: nodeSocketPath,
  });
  const config = await syncOwnedModel(nodeClient, {
    configVersion: CONFIG_VERSION, nodeUrl, schemaServiceUrl, userHash, schemaHashes: {},
    designSchemaHash: "", taskSchemaHash: "", ...(nodeSocketPath ? { nodeSocketPath } : {}),
  }, existing, canonicalVocabulary);
  writeConfig(config, configPath, priorConfig);
  const consent = await establishConsentInline({
    nodeUrl, userHash, print, verbose, socketPath: nodeSocketPath,
    recoveredIdentity,
    nonInteractiveGrant: opts.grantConsent, ...opts.consent,
  });
  printNextSteps(print, { nodeUrl, configPath, consent, reinitialized: existing !== null });
  return { config, bootstrapped, consent };
}

export function formatNodeTarget(nodeUrl: string): string {
  if (!isLoopbackNodeUrl(nodeUrl)) return nodeUrl;
  // Socket-first: never advertise the retired TCP control plane to users.
  return `unix:${defaultFolddbSocketPath()}`;
}

/**
 * Print the post-init "you're ready — here's your first record" nudge.
 *
 * Exported so tests can assert the exact guidance without re-running a full
 * init. Lines are emitted on init's `print` sink (stderr-class human output),
 * never on the machine-parsed result, so scripts/CI that consume stdout are
 * unaffected. Re-running init against an already-configured node prints a
 * shorter variant instead of the full first-record walkthrough.
 */
export function printNextSteps(
  print: (line: string) => void,
  ctx: {
    nodeUrl: string;
    configPath: string;
    consent: EstablishConsentResult;
    reinitialized: boolean;
  },
): void {
  // Already-configured re-run: keep it terse — the full walkthrough is noise.
  if (ctx.reinitialized) {
    print(``);
    print(
      `Already initialized on ${formatNodeTarget(ctx.nodeUrl)} (config: ${ctx.configPath}) — try \`brain ask "<question>"\` to find a record, or \`brain list\` for a sample of what's there.`,
    );
    return;
  }

  print(``);
  print(`You're ready. Next steps:`);
  print(`  1. Create your first record:  brain design new my-first-idea --title "My first idea" --body "what this idea is"`);
  print(`        (also: concept/preference/reference/agent/project/spike/sop new, or pipe markdown to \`brain put <slug>\`)`);
  print(`  2. See a sample of what's there: brain list   (a sample, not a full census — use \`brain search\`/\`brain ask\` to find a specific record)`);
  print(`  3. Find it again:              brain search "<term>"   ·   brain ask "<question>"`);
  print(`  4. If something looks wrong:   brain doctor`);
  print(`  5. Connect it to your AI agent: brain mcp install`);
  print(`        (one shot — gives your agent the brain_* tools by registering brain with Claude Code AND appends the usage instructions to ./CLAUDE.md so it actually uses the brain; \`brain-mcp\` is already on your PATH from the global \`bun add -g\` install — from a contributor source checkout, run \`bun link\` first)`);
  print(`        → then \`brain doctor --mcp\` to confirm the agent surface boots and serves the brain_* tools. (Doing it by hand instead? \`claude mcp add brain brain-mcp\` then \`brain mcp instructions >> CLAUDE.md\`.)`);
  print(`  Data lives on the node at ${formatNodeTarget(ctx.nodeUrl)} (config: ${ctx.configPath}).`);

  // Remote approval is performed by the target node owner.
  if (ctx.consent.state === "skipped" && ctx.consent.reason === "non_tty") {
    print("  Remote writes require approval from the target node owner before retrying.");
  }

}

type ProbeResult = Awaited<ReturnType<ReturnType<typeof newNodeClient>["autoIdentity"]>>;

type ProbeOpts = {
  nodeUrl: string;
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  // Injectable probes forwarded to `nodeDownHint` so the printed guidance is
  // deterministic in tests (otherwise it would read the host's live PATH /
  // socket table). Default to the real probes in production.
  isFolddbBinaryInstalled?: () => boolean;
  isTargetPortListening?: (url: string) => boolean;
  // Treat the current process as a TTY (default: process.stdin.isTTY). Gates
  // the down-node retry budget: interactive runs keep the long compile-wait,
  // non-interactive (CI/agent/scripted) runs fail fast. Injectable so the
  // budget selection stays unit-testable — mirrors init-consent.ts's idiom.
  isTty?: () => boolean;
};

export async function probeWithRetry(
  probeClient: ReturnType<typeof newNodeClient>,
  opts: ProbeOpts,
  print: (line: string) => void,
): Promise<ProbeResult> {
  try {
    return await probeClient.autoIdentity();
  } catch (err) {
    if (!isUnreachable(err)) throw err;
    // Budget precedence (most explicit wins): a test/caller-injected
    // `retryDelaysMs` → the `BRAIN_INIT_RETRY_DELAYS_MS` env override → the
    // interactivity-aware default. Non-interactive runs (no TTY — the CI /
    // agent / scripted install path) fail fast on a down node after surfacing
    // the actionable hint; interactive runs keep the long compile-wait budget.
    const isTty = (opts.isTty ?? defaultIsTty)();
    const interactivityDefault = isTty ? DEFAULT_RETRY_DELAYS_MS : NONINTERACTIVE_RETRY_DELAYS_MS;
    const delays = opts.retryDelaysMs ?? envRetryDelays() ?? interactivityDefault;
    if (delays.length === 0) throw err;
    const sleep = opts.sleep ?? defaultSleep;
    print(
      `        node not reachable at ${opts.nodeUrl}. ${nodeDownHint(
        opts.nodeUrl,
        opts.isFolddbBinaryInstalled ?? defaultIsFolddbBinaryInstalled,
        opts.isTargetPortListening ?? defaultIsTargetPortListening,
      )}`,
    );
    for (let i = 0; i < delays.length; i++) {
      const delay = delays[i] ?? 0;
      // The fast cadence means many attempts; don't print a line for every one
      // or the terminal floods. Always show the first few (so the dev sees the
      // quick re-probe ramp), the last, and then a terse heartbeat every
      // RETRY_LOG_EVERY attempts.
      const isLast = i === delays.length - 1;
      if (i < RETRY_RAMP_MS.length + 1 || isLast || (i + 1) % RETRY_LOG_EVERY === 0) {
        print(`        retrying in ${Math.round(delay / 1000)}s (attempt ${i + 1}/${delays.length})…`);
      }
      await sleep(delay);
      try {
        return await probeClient.autoIdentity();
      } catch (e2) {
        if (isLast || !isUnreachable(e2)) throw e2;
      }
    }
    throw err;
  }
}

type ResolvedUrls = {
  nodeUrl: string;
  schemaServiceUrl: string;
  // Human-readable descriptors of what we replaced, for the heal notice.
  // Empty when no heal happened (fresh init, or existing URLs are already
  // current / are user overrides).
  healed: string[];
};

export function resolveUrls(
  opts: Pick<InitOptions, "nodeUrl" | "schemaServiceUrl">,
  existing: Config | null,
): ResolvedUrls {
  const healed: string[] = [];

  // When no explicit --node-url is given and there's no existing config URL to
  // reuse, default to the loopback marker. brain reaches a local node ONLY
  // over its Unix socket; the URL is not dialed as TCP.
  let nodeUrl: string;
  if (opts.nodeUrl) {
    nodeUrl = opts.nodeUrl;
  } else if (!existing) {
    nodeUrl = DEFAULT_NODE_URL;
  } else if (STALE_NODE_URLS.has(existing.nodeUrl)) {
    nodeUrl = DEFAULT_NODE_URL;
    healed.push(`nodeUrl ${existing.nodeUrl} → ${DEFAULT_NODE_URL}`);
  } else {
    nodeUrl = existing.nodeUrl;
  }

  let schemaServiceUrl: string;
  if (opts.schemaServiceUrl) {
    schemaServiceUrl = opts.schemaServiceUrl;
  } else if (!existing) {
    schemaServiceUrl = DEFAULT_SCHEMA_SERVICE_URL;
  } else if (STALE_SCHEMA_URLS.has(existing.schemaServiceUrl)) {
    schemaServiceUrl = DEFAULT_SCHEMA_SERVICE_URL;
    healed.push(`schemaServiceUrl ${existing.schemaServiceUrl} → ${DEFAULT_SCHEMA_SERVICE_URL}`);
  } else {
    schemaServiceUrl = existing.schemaServiceUrl;
  }

  return { nodeUrl, schemaServiceUrl, healed };
}

function isUnreachable(err: unknown): boolean {
  return err instanceof BrainError && err.code === "service_unreachable";
}

// Option C gate: only reuse a saved userHash when the config carries
// enough state (userHash + at least one schema hash) to look like a
// completed init against this node. Insufficient state ⇒ the user is
// genuinely stuck and should see the node's own recovery message.
export function hasUsableExistingConfig(cfg: Config | null): cfg is Config {
  if (!cfg) return false;
  if (typeof cfg.userHash !== "string" || cfg.userHash.length === 0) return false;
  return Object.keys(cfg.schemaHashes).length > 0;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function defaultIsTty(): boolean {
  return Boolean(process.stdin.isTTY);
}
