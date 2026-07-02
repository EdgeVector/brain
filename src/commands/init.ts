// `fbrain init` — bootstrap a node (if needed), register every fbrain
// schema, load them, persist canonical hashes to ~/.fbrain/config.json.
//
// 6 steps:
//   0. probe /api/system/auto-identity
//   1. POST /api/setup/bootstrap if 503
//   2. obtain all 9 canonical hashes: POST each schema (maintainer w/ DevCert)
//      OR, when the cert gate returns 401 for a fresh consumer, defer and
//      resolve the already-published fbrain/* hashes from the node (step 3)
//   3. POST /api/schemas/load, then resolve any cert-gated hashes via
//      GET /api/schemas (the node's identity_hash IS the canonical hash)
//   4. verify failed_schemas empty + persist config
//   5. inline app-identity consent grant (prompt → folddb consent grant → poll)
//
// Idempotent. Step 0 makes a re-run skip bootstrap; step 2's POST is
// idempotent on the schema service side (identical re-POST returns 200
// with the same canonical hash). Re-running init is the prescribed
// remedy for `409 ambiguous_schema_name`, and also the way to upgrade
// older configs (v1 → current; v2 → current, with URL auto-heal if the
// existing URLs still point at the dead `:9101 / :9102` local-schema).

import { newNodeClient, newSchemaServiceClient, FbrainError, CERT_REQUIRED_HINT, nodeDownHint, defaultIsFolddbBinaryInstalled, defaultIsTargetPortListening, type Verbose } from "../client.ts";
import { OWNER_APP_ID, UNIQUE_SCHEMAS, resolveOwnedSchemaHash } from "../schemas.ts";
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
import { appIdentityEnforceEnabled } from "../write-context.ts";

export type InitOptions = {
  // Optional — when undefined, the resolver below picks either the existing
  // config's URL (if it isn't a dead local-schema default) or the new
  // default. This lets `fbrain init` (no flags) auto-heal a stale config
  // without clobbering a user-supplied override.
  nodeUrl?: string;
  schemaServiceUrl?: string;
  configPath?: string;
  bootstrapName?: string;
  verbose?: Verbose;
  print?: (line: string) => void;
  // Tuning hooks (mainly for tests):
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  /**
   * Drive Step 6's consent grant non-interactively (no TTY required) —
   * surfaced as `fbrain init --grant-consent`. Scripted / CI / agent
   * installs use this to reach a ready-to-write state in one shot. No-op
   * under FBRAIN_APP_IDENTITY_ENFORCE=off (printed clearly) and idempotent
   * when a live capability is already cached.
   */
  grantConsent?: boolean;
  // Inline consent (Step 6/6) injection seam for tests. When omitted, init
  // runs the real `establishConsentInline` against the configured node.
  consent?: Pick<
    EstablishConsentOptions,
    "store" | "transport" | "ask" | "resolveFolddb" | "runFolddbGrant" | "isTty" | "pollIntervalMs" | "sleep" | "maxWaitMs"
  >;
};

// New default targets — the loopback node URL is the canonical local-node
// marker (fbrain reaches a loopback node ONLY over its Unix socket; the `:9001`
// TCP listener is retired). The schema service moved off `:9102` to the prod
// cloud Lambda. The dev Lambda is reserved for the test harness so iteration
// doesn't pollute prod.
export const DEFAULT_NODE_URL = "http://127.0.0.1:9001";
export const DEFAULT_SCHEMA_SERVICE_URL =
  "https://axo709qs11.execute-api.us-east-1.amazonaws.com";

// Auto-heal triggers: any existing config carrying one of these URLs is
// treated as "still pointing at the dead pre-cloud local-schema setup".
// User overrides (any other URL, including a custom localhost port) are
// preserved verbatim.
const STALE_NODE_URLS: ReadonlySet<string> = new Set([
  "http://127.0.0.1:9101",
  "http://localhost:9101",
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
// install path (`fbrain init --grant-consent </dev/null`). For an unattended
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
  const raw = process.env.FBRAIN_INIT_RETRY_DELAYS_MS;
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
  const bootstrapName = opts.bootstrapName ?? "fbrain";
  const configPath = opts.configPath ?? defaultConfigPath();

  // `tryReadConfig` returns null when the file is absent but THROWS when it
  // exists with malformed contents (truncated JSON, missing field, unknown
  // configVersion from a downgrade, …). Without this catch the throw escapes
  // before any bootstrap work runs — and ConfigInvalidError's own message
  // tells the user to "Re-run `fbrain init`", trapping them in a dead-end
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
      `fbrain: auto-upgraded config to v${CONFIG_VERSION} with new schema-service URL` +
        ` (replaced ${resolved.healed.join(", ")})`,
    );
  }
  const nodeUrl = resolved.nodeUrl;
  const schemaServiceUrl = resolved.schemaServiceUrl;
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
  print(`[1/${STEPS}] targeting node at ${nodeUrl} (${nodeUrlSource})`);

  // Step 0/6: probe identity (with cold-build retry).
  print(`[1/${STEPS}] probing node identity`);
  const probeUserHash = existing?.userHash ?? "init-probe";
  const probeClient = newNodeClient({ baseUrl: nodeUrl, userHash: probeUserHash, verbose: verbose ?? (() => {}) });
  const identity = await probeWithRetry(probeClient, { nodeUrl, sleep: opts.sleep, retryDelaysMs: opts.retryDelaysMs }, print);

  let userHash: string;
  let bootstrapped = false;
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
      // No usable config ⇒ rethrow the FbrainError so the user sees the
      // node's actual message (e.g. "POST /api/auth/restore …").
      if (
        err instanceof FbrainError &&
        err.code === "onboarding_already_complete" &&
        hasUsableExistingConfig(existing)
      ) {
        userHash = existing.userHash;
        print(
          `        bootstrap refused (node + auto-identity disagree); reusing existing config userHash=${userHash.slice(0, 8)}… and continuing`,
        );
      } else {
        throw err;
      }
    }
  }

  // Step 2/6: obtain canonical hashes for the nine per-kind schemas — Design
  // + Task + Concept/Preference/Reference/Agent/Project/Spike/Sop. Each entry has
  // exactly one RecordType, so the hash is written once under that key.
  //
  // New local-first nodes expose `/api/apps/declare-schema`: fbrain declares
  // its owned schema definitions directly with the node, receives deterministic
  // local-mint hashes, and skips the shared schema_service load path entirely.
  // That removes fresh-schema Lambda cache consistency from fbrain's hot path.
  //
  // Compatibility fallback: the fbrain/* schemas are pre-published org-wide on
  // the canonical schema
  // service, so for a fresh consumer (no DevCert) the re-POST is rejected
  // with `401 cert_required`. That is the EXPECTED, documented state — not a
  // fatal error. Rather than dead-end, we record each cert-gated schema and
  // RESOLVE its authoritative canonical hash from the node after the
  // cert-free catalog load below (the node's `identity_hash` IS the published
  // canonical hash). A maintainer who DOES hold a DevCert still publishes
  // here (POST 200) on the same code path.
  //
  // `FBRAIN_APP_IDENTITY_ENFORCE=off` does NOT change the schema identity:
  // bare (un-namespaced) publishing would produce hashes that don't match the
  // fbrain/* schemas the node already loaded, and is rejected outright by any
  // schema service with `APP_IDENTITY_ROOT_PUBKEYS` set (i.e. the cloud
  // service, which is the only allowed one). Enforce-off only governs the
  // WRITE side — no consent step, no capability headers, writes land as
  // NodeOwner — so on this read-side step it follows the same
  // namespaced-publish-or-resolve path as enforce-on.
  const enforceOn = appIdentityEnforceEnabled();
  print(`[3/${STEPS}] preparing ${UNIQUE_SCHEMAS.length} fbrain schemas`);
  if (!enforceOn) {
    print(
      `        FBRAIN_APP_IDENTITY_ENFORCE=off → namespaced fbrain/* schemas reused; consent + capability headers will be skipped (writes land as NodeOwner)`,
    );
  }
  const nodeClient = newNodeClient({ baseUrl: nodeUrl, userHash, verbose: verbose ?? (() => {}) });
  const schemaHashes: Record<string, string> = {};
  const localDeclare = await tryDeclareOwnedSchemasLocally(nodeClient, schemaHashes, print);
  if (!localDeclare.supported) {
    print(
      `        node does not expose local app-schema declaration yet (${localDeclare.reason}); ` +
        `falling back to schema_service publish/load`,
    );
    await registerAndLoadSchemasFromCatalog({
      nodeClient,
      schemaServiceUrl,
      schemaHashes,
      verbose,
      print,
    });
  }

  // Step 4/6: persist config (config file written before consent so a Ctrl-C
  // mid-grant doesn't lose schema state — the next init re-runs the consent
  // step idempotently).
  print(`[5/${STEPS}] writing config to ${configPath}`);
  const config: Config = {
    configVersion: CONFIG_VERSION,
    nodeUrl,
    schemaServiceUrl,
    userHash,
    schemaHashes,
    designSchemaHash: schemaHashes.design ?? "",
    taskSchemaHash: schemaHashes.task ?? "",
  };
  // Persist an explicit owner-session socket override (app-isolation flip,
  // fold#739) when one was provided via `FBRAIN_FOLDDB_SOCKET` — so later
  // commands attest against the same non-default node without re-supplying the
  // env. Unset → omitted, and attestation falls back to the default
  // `${FOLDDB_HOME ?? ~/.folddb}/data/folddb.sock`.
  const socketOverride = process.env.FBRAIN_FOLDDB_SOCKET;
  if (socketOverride && socketOverride.length > 0) {
    config.nodeSocketPath = socketOverride;
  }
  writeConfig(config, configPath);
  print(`        wrote config v${CONFIG_VERSION}`);

  // Step 5/6: inline consent — eliminate the "two-terminal dance" on first
  // write. Idempotent (skips silently when a live capability is already on
  // disk); non-TTY safe (skips with a one-line note for CI/scripts); falls
  // back to the manual instruction when `folddb` is not on PATH.
  print(`[6/${STEPS}] establishing consent (one-time grant for fbrain's namespace)`);
  const consentBase: EstablishConsentOptions = {
    nodeUrl,
    userHash,
    print,
  };
  if (verbose !== undefined) consentBase.verbose = verbose;
  if (opts.grantConsent) consentBase.nonInteractiveGrant = true;
  const consent = await establishConsentInline({ ...consentBase, ...(opts.consent ?? {}) });

  print(`[init] ok`);

  // Close the onboarding loop: a brand-new developer who reaches `[init] ok`
  // should know their very next move without leaving the terminal to re-read
  // the README. Emit a concise next-steps block on the same print stream.
  // Kept off any machine-parsed surface — init's structured result is the
  // return value; this is purely human guidance.
  printNextSteps(print, { nodeUrl, configPath, consent, reinitialized: existing !== null });

  return { config, bootstrapped, consent };
}

type InitNodeClient = ReturnType<typeof newNodeClient>;

async function tryDeclareOwnedSchemasLocally(
  nodeClient: InitNodeClient,
  schemaHashes: Record<string, string>,
  print: (line: string) => void,
): Promise<{ supported: true } | { supported: false; reason: string }> {
  print(`[3/${STEPS}] declaring ${UNIQUE_SCHEMAS.length} fbrain-owned schemas locally`);
  if (!nodeClient.declareAppSchema) {
    return { supported: false, reason: "client does not support /api/apps/declare-schema" };
  }
  for (const entry of UNIQUE_SCHEMAS) {
    try {
      const declared = await nodeClient.declareAppSchema(OWNER_APP_ID, entry.schema.schema);
      if (declared.resolution !== "mint") {
        throw new FbrainError({
          code: "app_schema_declare_not_local_mint",
          message:
            `Node declared ${entry.schema.schema.descriptive_name} as ${declared.resolution} ` +
            `(${declared.canonical}), but fbrain-owned schemas must be local mints.`,
          hint: "Disable schema-link matching for fbrain-owned schemas or declare this schema as a local mint, then re-run `fbrain init`.",
        });
      }
      for (const type of entry.types) {
        schemaHashes[type] = declared.canonical;
      }
      print(
        `        ${entry.schema.schema.descriptive_name.padEnd(18)} → ${declared.canonical}  ` +
          `(local mint; covers ${entry.types.join(", ")})`,
      );
    } catch (err) {
      if (err instanceof FbrainError && err.code === "node_http_404") {
        return { supported: false, reason: "/api/apps/declare-schema returned 404" };
      }
      throw err;
    }
  }
  print(`[4/${STEPS}] loading schemas into the node`);
  print(`        local app-schema declarations persisted; schema_service load skipped ✓`);
  return { supported: true };
}

async function registerAndLoadSchemasFromCatalog(opts: {
  nodeClient: InitNodeClient;
  schemaServiceUrl: string;
  schemaHashes: Record<string, string>;
  verbose?: Verbose;
  print: (line: string) => void;
}): Promise<void> {
  const { nodeClient, schemaServiceUrl, schemaHashes, verbose, print } = opts;
  const schemaClient = newSchemaServiceClient(schemaServiceUrl, verbose);
  const certBlocked: typeof UNIQUE_SCHEMAS = [];
  for (const entry of UNIQUE_SCHEMAS) {
    try {
      const reg = await schemaClient.registerSchema(entry.schema);
      for (const type of entry.types) {
        schemaHashes[type] = reg.canonicalHash;
      }
      print(`        ${entry.schema.schema.descriptive_name.padEnd(18)} → ${reg.canonicalHash}  (covers ${entry.types.join(", ")})`);
    } catch (err) {
      // Cert-gated re-POST of an already-published fbrain/* schema — defer it
      // and resolve the canonical hash from the node catalog after load. Same
      // behavior under enforce-on and enforce-off; the schema identity is
      // identical, only the write-time auth differs.
      if (err instanceof FbrainError && err.code === "schema_cert_required") {
        certBlocked.push(entry);
        print(`        ${entry.schema.schema.descriptive_name.padEnd(18)} → published already (cert-gated re-POST skipped; resolving from node)`);
      } else {
        throw err;
      }
    }
  }

  // Load schemas into the node — scoped to JUST fbrain's schemas (fold #877),
  // so a fresh node stays clean instead of pulling the entire global published
  // catalog. This is only the compatibility path for nodes that predate local
  // app-schema declaration.
  const loadScope = UNIQUE_SCHEMAS.map((entry) => {
    const firstType = entry.types[0];
    const hash = firstType ? schemaHashes[firstType] : undefined;
    return hash ?? entry.schema.schema.descriptive_name;
  });
  const loadResult = await nodeClient.loadSchemas(loadScope);
  if (loadResult.failed_schemas.length > 0) {
    throw new Error(
      `partial schema load — failed_schemas: ${loadResult.failed_schemas.join(", ")}`,
    );
  }
  const loaded = loadResult.schemas_loaded_to_db;
  if (loaded <= loadScope.length) {
    print(`[4/${STEPS}] loading schemas into the node (scoped to fbrain's ${loadScope.length})`);
    print(`        loaded ${loaded}/${loadScope.length} schemas (failed_schemas empty ✓)`);
  } else {
    print(`[4/${STEPS}] loading fbrain's ${loadScope.length} schemas into the node`);
    print(
      `        node predates scoped load (fold #877) — loaded the full published catalog (${loaded}); ` +
        `fbrain's ${loadScope.length} schemas resolved from it ✓`,
    );
  }

  if (certBlocked.length > 0) {
    const loaded = await nodeClient.listLoadedSchemas();
    const stillMissing: string[] = [];
    for (const entry of certBlocked) {
      const hash = resolveOwnedSchemaHash(entry.schema, loaded);
      if (hash) {
        for (const type of entry.types) {
          schemaHashes[type] = hash;
        }
        print(`        resolved ${entry.schema.schema.descriptive_name.padEnd(18)} → ${hash}  (published fbrain/* schema; no DevCert needed)`);
      } else {
        stillMissing.push(entry.schema.schema.descriptive_name);
      }
    }
    if (stillMissing.length > 0) {
      throw new FbrainError({
        code: "schema_cert_required",
        message:
          `Schema service rejected publish with 401 cert_required, and these schemas are not yet ` +
          `published on this schema service — so their canonical hashes could not be resolved from ` +
          `the node either: ${stillMissing.join(", ")}. A maintainer must publish them once.`,
        hint: CERT_REQUIRED_HINT,
      });
    }
  }
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
      `Already initialized on ${ctx.nodeUrl} (config: ${ctx.configPath}) — try \`fbrain list\` to see your records, or \`fbrain doctor\` to re-check health.`,
    );
    return;
  }

  print(``);
  print(`You're ready. Next steps:`);
  print(`  1. Create your first record:  fbrain design new my-first-idea --title "My first idea" --body "what this idea is"`);
  print(`        (also: concept/preference/reference/agent/project/spike/sop new, or pipe markdown to \`fbrain put <slug>\`)`);
  print(`  2. See what you've got:        fbrain list`);
  print(`  3. Find it again:              fbrain search "<term>"   ·   fbrain ask "<question>"`);
  print(`  4. Re-check health anytime:    fbrain doctor`);
  print(`  5. Connect it to your AI agent: fbrain mcp install`);
  print(`        (one shot — gives your agent the fbrain_* tools by registering fbrain with Claude Code AND appends the usage instructions to ./CLAUDE.md so it actually uses the brain; \`fbrain-mcp\` is already on your PATH from the global \`bun add -g\` install — from a contributor source checkout, run \`bun link\` first)`);
  print(`        → then \`fbrain doctor --mcp\` to confirm the agent surface boots and serves all 7 tools. (Doing it by hand instead? \`claude mcp add fbrain fbrain-mcp\` then \`fbrain mcp instructions >> CLAUDE.md\`.)`);
  print(`  Data lives on the node at ${ctx.nodeUrl} (config: ${ctx.configPath}).`);

  // When consent wasn't established (non-TTY scripted/CI run without
  // --grant-consent), the first write will need a grant — point at the
  // one-shot path so the operator isn't surprised mid-script.
  if (ctx.consent.state === "skipped" && ctx.consent.reason === "non_tty") {
    print(`  Note: running non-interactively — re-run \`fbrain init --grant-consent\` to authorize writes in one shot.`);
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
    // `retryDelaysMs` → the `FBRAIN_INIT_RETRY_DELAYS_MS` env override → the
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
  // reuse, default to the loopback node URL. fbrain reaches a loopback node
  // ONLY over its Unix socket (the retired :9001 TCP listener is gone); the URL
  // is just the loopback marker that selects socket transport.
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
  return err instanceof FbrainError && err.code === "service_unreachable";
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
