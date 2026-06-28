// `fbrain doctor` — live health check for the local fbrain setup.
//
// Checks (each prints PASS/FAIL with a fix-suggestion when FAIL):
//   1. config valid (~/.fbrain/config.json exists + schema-shape + hex64 hashes)
//   2. schema service reachable (GET /v1/schemas → 200)
//   3. node reachable (GET /api/system/auto-identity → 200 or 503)
//   4. node provisioned (auto-identity → 200, body has user_hash)
//   5. schemas loaded into the node (read-only: GET /api/schemas → each of
//      fbrain's 8 canonical hashes is present in the node DB)
//   6. schema drift — for Design + Task: GET /v1/schema/<canonicalHash>,
//      compare descriptive_name + fields + field_types against schemas.ts.
//   7. embedding-runtime — one-token search forces ONNX load.
//   8. write-ready — capability cached for this node + consent dry-run
//      returns 202 (not 404). Pre-this-PR doctor was all read-path
//      probes, so a node that rejected every write (cold app registry,
//      revoked grant, missing capability) still reported all-PASS. This
//      probe asks both questions a write needs to answer "yes" to and
//      surfaces a structured FAIL ("write-blocked") with an actionable
//      hint that distinguishes a missing grant from a cold registry.
//  9b. runtime — the running `Bun.version` meets fbrain's documented minimum
//      (README Prerequisites; single-sourced from package.json `engines.bun`).
//      Cheap + offline (string compare; never touches the node). FAIL (not
//      WARN) when too old, with a `brew upgrade bun` hint — a new dev whose
//      `fbrain init`/`fbrain <cmd>` failed cryptically on an old Bun gets a
//      clear diagnosis instead of an opaque low-level error.
//   9. mcp-entrypoint — the `fbrain-mcp` bin (the headline agent
//      integration `claude mcp add fbrain fbrain-mcp`) resolves on PATH.
//      Cheap + offline (Bun.which only; never spawns the server). WARN —
//      never FAIL — when missing, so a CLI-only or source-checkout user's
//      green verdict isn't flipped, but a silently-broken agent path is
//      surfaced with a re-link hint.
//
// With `--json`: emit the structured check results as a single JSON object
// on stdout (same verdict + exit code) for CI / script consumption.
//
// Always-WARN disclosure probes (G0 gate item #9 —
// see docs/g0-replacement-readiness-gate.md §6). These don't detect a
// condition; they declare a known limitation so a teammate dogfooding
// on a second machine sees it instead of inferring a silent fork:
//   - single-machine-slice — record set is local to this daemon.
//   - no-team-sync       — `fbrain share` is a placeholder.
//
// With `--freshness`: also runs two G3 probes (see docs/phase-7-search-latency-spike.md):
//   - freshness-probe — 5 trials of put → search against a
//     `doctor-freshness-probe-<nonce>` slug namespace, cleaning up
//     afterwards. Each trial passes when the fresh record surfaces at
//     score ≥ 0.5. The verdict is variance-tolerant: PASS when the average
//     score is healthy (≥ 0.5) AND a majority of trials surfaced; FAILs only
//     when writes don't surface at all or retrieval quality is systematically
//     low (so normal per-trial score noise no longer produces a flaky FAIL on
//     a healthy fresh brain).
//   - pollution-probe — one broad query (default "fbrain"); classifies each
//     hit as live / stale-fragment / orphan-schema. PASS if <25% polluted,
//     WARN at 25-50%, FAIL above 50%.
//
// With `--write`: also runs a real put → get → soft-delete round-trip
// under a reserved `doctor-write-roundtrip-<nonce>` slug. OFF by default
// so plain `fbrain doctor` never mutates.
//
// With `--mcp`: also BOOTS the resolved `fbrain-mcp` entrypoint and asserts
// the agent-integration surface end-to-end (the opt-in companion to check #9
// `mcp-entrypoint`, which is PATH-resolution only):
//   - mcp-boot — spawns `fbrain-mcp`, drives a JSON-RPC initialize +
//     tools/list handshake over stdio under a bounded deadline (kills the
//     child on timeout), and PASSes only when the server returns a valid
//     initialize result AND reports EXACTLY the 7 expected tool names. FAIL
//     (not WARN) on any boot/handshake/tool-set failure, with a re-link fix.
//     OFF by default so plain `fbrain doctor` never spawns the server.
//
// Exit code 0 on all-green, 1 if any check fails.

import { existsSync } from "node:fs";

import {
  defaultFolddbSocketPath,
  FbrainError,
  isNodeReachableButErroring,
  newNodeClient,
  newSchemaServiceClient,
  nodeDownHint,
  nodeHttpErrorHint,
  recordTypeForHash,
  stripDoctorTip,
  type NativeIndexHit,
  type NodeClient,
  type RegisteredSchema,
  type SchemaServiceClient,
  type Verbose,
} from "../client.ts";
import { tryReadConfig, type Config } from "../config.ts";
import { resolvePrintSink } from "../format.ts";
import { DEFAULT_SCHEMA_SERVICE_URL } from "./init.ts";
import {
  findBySlug,
  nowIso,
} from "../record.ts";
import {
  RECORD_TYPES,
  UNIQUE_SCHEMAS,
  type AddSchemaRequest,
  type RecordType,
} from "../schemas.ts";
import { buildTombstoneFields } from "./delete.ts";
import { runUsageReport, type UsageOptions } from "./usage.ts";
import { listManifests, type MigrationManifest } from "../migration.ts";
import {
  FBRAIN_APP_ID,
  decodeCapabilityBlob,
  tokenIntegrityValid,
  type CapabilityStore,
} from "../capability.ts";
import { defaultCapabilityStore } from "../keychain.ts";
import {
  appIdentityEnforceEnabled,
  newWriteNodeClient,
  type WriteNodeClient,
  type WriteNodeClientOptions,
} from "../write-context.ts";
import { FBRAIN_MCP_TOOL_NAMES } from "../mcp/server.ts";
import { getFbrainVersion } from "../version.ts";
import { MIN_BUN_VERSION, bunVersionMeetsMinimum } from "../runtime.ts";

export type DoctorOptions = {
  configPath?: string;
  verbose?: Verbose;
  print?: (line: string) => void;
  // For testing: inject prebuilt clients to bypass the real fetches.
  schemaClientFactory?: (url: string, v?: Verbose) => SchemaServiceClient;
  nodeClientFactory?: (opts: {
    baseUrl: string;
    userHash: string;
    verbose?: Verbose;
    socketPath?: string;
  }) => NodeClient;
  // --freshness probes (G3a in docs/phase-7-search-latency-spike.md).
  freshness?: boolean;
  freshnessTrials?: number;            // default 5
  freshnessMinScore?: number;          // default 0.5
  pollutionQuery?: string;             // default "fbrain"
  pollutionWarnThreshold?: number;     // default 0.25
  pollutionFailThreshold?: number;     // default 0.5
  pollutionMinSample?: number;         // default 10 — below this the ratio is low-N noise; report raw counts only
  nonceFn?: () => string;              // override for deterministic tests
  // --usage report (G13 team-adoption telemetry — see commands/usage.ts).
  // When set, doctor skips its health-check sequence and just prints the
  // usage report. Config + node-client wiring still validate first so the
  // user gets a useful error if init hasn't been run.
  usage?: boolean;
  usageOptions?: UsageOptions;
  // --write probe: do a real put → get → soft-delete round-trip under a
  // reserved slug to verify writes land end-to-end. Off by default so plain
  // `fbrain doctor` never mutates.
  write?: boolean;
  // Override for tests: the capability store the write-ready probe inspects
  // and the round-trip writes use. Defaults to the OS keychain store.
  capabilityStore?: CapabilityStore;
  // Override for tests: the write-node-client factory used by the round-trip
  // probe. Defaults to newWriteNodeClient.
  writeNodeFactory?: (opts: WriteNodeClientOptions) => WriteNodeClient;
  // Override for tests: resolve a bin name to its absolute path on PATH (or
  // null when unresolved). Defaults to Bun.which. Lets the mcp-entrypoint
  // probe be exercised in both the resolved + unresolved states without
  // mutating the test process's real PATH.
  whichBin?: (name: string) => string | null;
  // Override for tests: the running Bun version the `runtime` check compares
  // against fbrain's documented minimum (MIN_BUN_VERSION). Defaults to the live
  // `Bun.version`. An explicit seam (like `whichBin`) so doctor.test.ts can
  // drive both the too-old FAIL branch and the supported PASS branch
  // deterministically without depending on the host's installed Bun.
  bunVersion?: string;
  // --mcp boot probe: actually SPAWN the resolved `fbrain-mcp` entrypoint,
  // drive a JSON-RPC initialize + tools/list handshake over stdio, and assert
  // the 7-tool agent surface. OFF by default so plain `fbrain doctor` never
  // spawns the server (stays cheap + offline, like --write / --freshness).
  mcp?: boolean;
  // Override for tests: spawn the MCP boot probe against a fake transport
  // instead of the real `fbrain-mcp` child process. Receives the resolved
  // entrypoint + a deadline; returns the handshake outcome the PASS/FAIL
  // logic classifies. Defaults to a real child-process stdio handshake.
  mcpBootRunner?: (input: McpBootInput) => Promise<McpBootResult>;
  // Override for tests: the running CLI's version string the mcp-boot probe
  // compares against the booted agent surface's `serverInfo.version` to detect
  // a build skew (a stale `bun link`ed fbrain-mcp from a different checkout).
  // Defaults to `getFbrainVersion()` — the same single-sourced string the MCP
  // server reports — so a real run compares like-for-like.
  cliVersion?: string;
  // --json: emit the structured check results as a single JSON object on
  // stdout instead of the human PASS/WARN/FAIL lines, so the agent-facing
  // surfaces (CI, scripts) can read doctor's verdict programmatically.
  json?: boolean;
};

// `tag` overrides the printed tag when set; `ok` always drives the exit code.
// WARN entries set `ok: true` + `tag: "WARN"` so they surface visually but
// don't trip the doctor verdict. SKIP entries are the same neutral shape
// (`ok: true` + `tag: "SKIP"`): a check whose dependency was unreachable so it
// never ran — rendered like WARN, never a pass or a fail. Emitting an explicit
// SKIP keeps the check list a stable shape regardless of node state, instead
// of node-dependent checks silently vanishing when the node is down.
type CheckResult = {
  name: string;
  ok: boolean;
  tag?: "PASS" | "WARN" | "FAIL" | "SKIP";
  detail?: string;
  fix?: string;
};

export async function doctor(opts: DoctorOptions = {}): Promise<number> {
  const print = resolvePrintSink(opts);
  const verbose = opts.verbose;

  const checks: CheckResult[] = [];
  let schemasLoadedOk = false;

  // 1. config
  const cfg = tryReadConfig(opts.configPath);
  if (!cfg) {
    checks.push({
      name: "config",
      ok: false,
      detail: "no ~/.fbrain/config.json",
      fix: "run `fbrain init`",
    });
    // Break the init↔doctor dead-end: if init's step 3 keeps failing with
    // `401 cert_required`, the user has no config to load — pre-this-PR
    // doctor stopped here and told them to re-run init, which would loop
    // forever. Probe the schema-service publish gate independently so the
    // real cause surfaces with an actionable remedy instead of bouncing
    // them back to a command that can't succeed.
    const probe = await runSchemaPublishGateProbe(opts, verbose);
    if (probe) checks.push(probe);
    return finalize(checks, print, opts.json);
  }
  const cfgIssues = validateConfigShape(cfg);
  if (cfgIssues.length > 0) {
    checks.push({
      name: "config",
      ok: false,
      detail: cfgIssues.join("; "),
      fix: "re-run `fbrain init` to refresh canonical hashes",
    });
  } else {
    checks.push({
      name: "config",
      ok: true,
      detail: `nodeUrl=${cfg.nodeUrl} schemaServiceUrl=${cfg.schemaServiceUrl}`,
    });
  }
  verbose?.(`config: ${cfgIssues.length === 0 ? "ok" : `bad — ${cfgIssues.join("; ")}`}`);

  const schemaClient = (opts.schemaClientFactory ?? newSchemaServiceClient)(
    cfg.schemaServiceUrl,
    verbose,
  );
  const nodeSocketPath = defaultFolddbSocketPath(cfg.nodeSocketPath);
  const nodeClient = (opts.nodeClientFactory ?? newNodeClient)({
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
    verbose,
    socketPath: nodeSocketPath,
  });

  // --usage diverts to the team-adoption report (G13). It needs a valid
  // config + reachable node but doesn't depend on the schema-drift /
  // freshness checks, so we short-circuit before running them.
  if (opts.usage) {
    if (cfgIssues.length > 0) {
      print("usage report skipped — config is invalid (see [FAIL] above).");
      return finalize(checks, print, opts.json);
    }
    const usageOpts: UsageOptions = { ...(opts.usageOptions ?? {}) };
    if (!usageOpts.print) usageOpts.print = print;
    if (!usageOpts.verbose && verbose) usageOpts.verbose = verbose;
    try {
      await runUsageReport(nodeClient, cfg, usageOpts);
      return 0;
    } catch (err) {
      print(`usage report failed: ${doctorReachabilityDetail(err, "node", cfg.nodeUrl)}`);
      return 1;
    }
  }

  // 2. schema service reachable
  try {
    await schemaClient.listSchemas();
    checks.push({ name: "schema-service-reachable", ok: true });
    verbose?.(`schema-service-reachable: ok`);
  } catch (err) {
    checks.push({
      name: "schema-service-reachable",
      ok: false,
      detail: doctorReachabilityDetail(err, "schema service", cfg.schemaServiceUrl),
      fix: schemaServiceFixHint(cfg.schemaServiceUrl),
    });
    verbose?.(`schema-service-reachable: FAIL`);
  }

  // 3 + 4. node reachable + provisioned
  let provisioned = false;
  let nodeReachable = false;
  try {
    const identity = await nodeClient.autoIdentity();
    nodeReachable = true;
    // Surface the connected node's folddb version on the node-reachable line —
    // a developer can then spot a stale node (e.g. a 0.13.0 brew node bind-
    // fighting the desktop app on :9001) without reaching for `curl`. This is
    // best-effort and STRICTLY informational: a health-probe failure (older
    // node with no /api/health, transient hiccup) must NOT flip node-reachable
    // to FAIL — auto-identity already answered that the node is up — so we keep
    // PASS and just omit the version, falling back to the node URL alone.
    const nodeTransport = nodeReachabilityTransportDetail(cfg.nodeUrl, nodeSocketPath);
    let nodeReachableDetail = nodeTransport;
    try {
      const health = await nodeClient.health();
      if (health.version) nodeReachableDetail = `lastdb ${health.version} @ ${nodeTransport}`;
      verbose?.(`node health: version=${health.version ?? "—"}`);
    } catch (err) {
      verbose?.(`node health probe failed (non-fatal): ${errMsg(err)}`);
    }
    checks.push({ name: "node-reachable", ok: true, detail: nodeReachableDetail });
    verbose?.(`node-reachable: ok`);
    if (identity.provisioned) {
      provisioned = true;
      checks.push({
        name: "node-provisioned",
        ok: true,
        detail: `user_hash=${identity.userHash.slice(0, 8)}…`,
      });
      verbose?.(`node-provisioned: ok`);
    } else {
      checks.push({
        name: "node-provisioned",
        ok: false,
        detail: identity.reason,
        fix: "run `fbrain init` to bootstrap",
      });
      verbose?.(`node-provisioned: FAIL — ${identity.reason}`);
    }
  } catch (err) {
    // Distinguish a node that is genuinely DOWN (transport failure → "start
    // it") from one that is UP but returned an HTTP error (4xx/5xx → don't say
    // "start it"; the node answered, its own message is the real fix). The old
    // code lumped both into nodeDownHint, so a reachable node that 500s on
    // identity decryption was told to `brew services start folddb` even though
    // schema-service + every schema-drift check (same node) passed. (29ced)
    checks.push({
      name: "node-reachable",
      ok: false,
      detail: doctorReachabilityDetail(err, "node", cfg.nodeUrl),
      fix: isNodeReachableButErroring(err) ? nodeHttpErrorHint(err) : nodeDownHint(cfg.nodeUrl),
    });
    verbose?.(`node-reachable: FAIL`);
    // The node never answered, so node-provisioned can't be determined. Emit
    // an explicit SKIP (neutral, like WARN) rather than letting it silently
    // vanish — the schemas-loaded / schema-drift / embedding-runtime /
    // write-ready checks below SKIP for the same reason at their own gates,
    // so the check list keeps the same shape whether the node is up or down.
    checks.push(skippedByNodeUnreachable("node-provisioned"));
  }

  // 5. schemas loaded — verified via the READ path (GET /api/schemas), NOT by
  // POSTing /api/schemas/load. Two reasons the old active-reload was wrong:
  //   (a) A health check must not mutate. This file's own contract (see the
  //       header + the `--write` gate) is that plain `fbrain doctor` never
  //       writes; an unconditional /api/schemas/load violated that.
  //   (b) Since the app-isolation flip (fold#739), /api/schemas/load is an
  //       owner-attested verb. On a node whose owner-session attestation is
  //       unavailable — a stale daemon with a wedged control socket, or fbrain
  //       pointed at a node with no reachable local socket — the POST returns
  //       `403 transport_not_attested` and the old check misdiagnosed a fully
  //       healthy, fully-loaded node as "schemas not loaded — re-run init"
  //       (re-running init can't fix a wedged socket). The read path needs
  //       only X-User-Hash, so it answers the real question — "are fbrain's 8
  //       schemas present in the node's DB under the exact hashes we write
  //       against?" — accurately regardless of attestation state.
  if (provisioned) {
    try {
      const loaded = await nodeClient.listLoadedSchemas();
      const loadedHashes = new Set(
        loaded
          .map((s) => s.identity_hash)
          .filter((h): h is string => typeof h === "string" && h.length > 0),
      );
      const missing = UNIQUE_SCHEMAS.filter((entry) => {
        const hash = cfg.schemaHashes[entry.key];
        return !hash || !loadedHashes.has(hash);
      }).map((entry) => entry.schema.schema.descriptive_name);
      if (missing.length === 0) {
        schemasLoadedOk = true;
        checks.push({
          name: "schemas-loaded",
          ok: true,
          detail: `${UNIQUE_SCHEMAS.length}/${UNIQUE_SCHEMAS.length} fbrain schemas present in the node DB`,
        });
        verbose?.(`schemas-loaded: ok (${UNIQUE_SCHEMAS.length}/${UNIQUE_SCHEMAS.length})`);
      } else {
        checks.push({
          name: "schemas-loaded",
          ok: false,
          detail: `not loaded into the node: ${missing.join(", ")}`,
          fix: "re-run `fbrain init` (it loads fbrain's schemas into the node)",
        });
        verbose?.(`schemas-loaded: FAIL — ${missing.join(", ")}`);
      }
    } catch (err) {
      checks.push({
        name: "schemas-loaded",
        ok: false,
        detail: errMsg(err),
        fix: "re-run `fbrain init`",
      });
      verbose?.(`schemas-loaded: FAIL`);
    }
  } else if (!nodeReachable) {
    // Node is down — reading the node DB to confirm fbrain's schemas are
    // loaded is impossible. SKIP rather than drop the check.
    checks.push(skippedByNodeUnreachable("schemas-loaded", "can't read the node DB"));
  }

  // 6. schema drift — check each unique schema once. Iterates 8 entries:
  // Design + Task + six per-kind Phase 6 schemas. Two flavors of drift are
  // demoted to WARN instead of failing the verdict:
  //   - extras-only: the schema service expanded fbrain's canonical against
  //     an existing schema of the same descriptive_name (often a
  //     Schema.org starter_seed) and the registered schema now carries
  //     extra fields. `fbrain init` cannot shrink registered schemas —
  //     handled inside checkSchemaDrift().
  //   - migration-explained: a completed `fbrain migrate --add-field`
  //     manifest's to_hash matches the live config hash, so the registered
  //     schema's extra field is expected — softened here by
  //     softenDriftIfMigrated().
  const allManifests = safeListManifests();
  if (cfgIssues.length === 0 && !nodeReachable) {
    // checkSchemaDrift only reads the cloud schema-SERVICE, so it would still
    // PASS with the node dead — but the `schema-drift[…]` label promises a
    // comparison against the user's node, and eight green lines next to a red
    // `node-reachable` read as "my schemas are fine on my node," which was
    // never checked. Collapse to a single honest SKIP when the node is down.
    checks.push(
      skippedByNodeUnreachable("schema-drift", "can't compare against the node DB"),
    );
  } else if (cfgIssues.length === 0) {
    for (const entry of UNIQUE_SCHEMAS) {
      const hash = cfg.schemaHashes[entry.key];
      const label = entry.schema.schema.descriptive_name;
      if (!hash) {
        checks.push({
          name: `schema-drift[${label}]`,
          ok: false,
          detail: `no canonical hash for "${entry.key}" in config.schemaHashes`,
          fix: "re-run `fbrain init`",
        });
        continue;
      }
      const driftCheck = await checkSchemaDrift(
        schemaClient,
        label,
        entry.schema,
        hash,
      );
      const softened = softenDriftIfMigrated(driftCheck, entry.key, hash, allManifests);
      checks.push(softened);
      verbose?.(
        `schema-drift[${label}]: ${tagOf(softened)} — ${softened.detail ?? ""}`,
      );
    }
  }

  // Embedding-runtime probe — issue one trivial search query so the node
  // is forced to load its ONNX model. Surfaces the
  // `embedding_model_unavailable` failure as a structured FAIL, separate
  // from schema-drift, so `fbrain doctor` is the one source of truth for
  // "is search end-to-end usable?" — not just "are the schemas right?".
  // Cheap when it passes (one GET); the heavy freshness probe stays
  // gated behind --freshness.
  if (provisioned && schemasLoadedOk) {
    const embed = await runEmbeddingProbe(nodeClient, verbose);
    checks.push(embed);
  } else if (!nodeReachable) {
    // The probe issues a search against the node to force its ONNX load —
    // impossible with the node down. SKIP rather than drop it.
    checks.push(skippedByNodeUnreachable("embedding-runtime"));
  }

  // Write-readiness probe — capability + consent-path check. The pre-PR
  // doctor was all read-path probes, so a node that rejected every write
  // (cold app registry, revoked capability, missing grant, …) still
  // reported all-PASS. This probe asks both questions a write needs:
  //   (a) is a valid CapabilityToken cached for this node, and
  //   (b) does the node's app registry know about fbrain (does
  //       request-consent return 202, not 404)?
  // Read-only: it polls request-consent for the HTTP status but never
  // grants or waits, so the leftover pending request times out naturally.
  // Fails closed — any indeterminate state (consent endpoint 5xx, store
  // unreadable) surfaces as a WARN, not a silent PASS.
  if (provisioned && cfgIssues.length === 0) {
    const store = opts.capabilityStore ?? defaultCapabilityStore();
    const writeReady = await runWriteReadyProbe(nodeClient, cfg.nodeUrl, store, verbose);
    checks.push(writeReady);
  } else if (!nodeReachable) {
    // The probe POSTs request-consent to the node — impossible with the node
    // down. SKIP rather than drop it.
    checks.push(skippedByNodeUnreachable("write-ready"));
  }

  // Runtime probe — compare the running Bun against fbrain's documented
  // minimum (README Prerequisites: "Bun ≥ <MIN_BUN_VERSION>"). The README tells
  // every new dev to run `fbrain doctor`, but until this check nothing
  // enforced the version, so a dev on an older Bun hit an opaque low-level
  // failure with no pointer to the real cause. Cheap + offline (string compare
  // only; never touches the node) — fits the same slot as mcp-entrypoint. FAIL
  // (not WARN) when too old, with an actionable upgrade hint.
  const runtimeCheck = runRuntimeProbe(opts, verbose);
  checks.push(runtimeCheck);

  // MCP-entrypoint probe — the headline agent-integration path. The README
  // front-loads `claude mcp add fbrain fbrain-mcp`, which only works if the
  // `fbrain-mcp` bin (declared in package.json `bin` alongside `fbrain`) is
  // on PATH. On a real machine a stale hand-installed `fbrain` shim that
  // predates the `fbrain-mcp` bin leaves `fbrain` resolvable but `fbrain-mcp`
  // missing — and pre-this-check doctor was all-PASS, so a broken agent
  // integration failed silently. Cheap + offline (PATH resolution only; we
  // do NOT spawn the MCP server). WARN, never FAIL: MCP is optional for
  // CLI-only users and source-checkout users register the path-based form,
  // so absence must not flip doctor's exit code.
  const mcpCheck = runMcpEntrypointProbe(opts, verbose);
  checks.push(mcpCheck);

  // --mcp boot probe — actually BOOT the resolved `fbrain-mcp` entrypoint and
  // assert the live agent-integration surface, not just that the bin is on
  // PATH. `mcp-entrypoint` above is PATH-resolution only (cheap + offline), so
  // a resolved-but-broken server (crashes on boot, hangs, wrong/zero tools,
  // version skew) yields a GREEN mcp-entrypoint and the new dev only discovers
  // the dead server when their agent silently can't reach the brain. This
  // opt-in probe spawns the server, drives a JSON-RPC initialize + tools/list
  // handshake over stdio under a bounded deadline, and FAILs (not WARNs) on a
  // boot/handshake/tool-set mismatch — mirroring the --write / --freshness
  // opt-in-deep-probe pattern so plain `fbrain doctor` stays spawn-free. Kept
  // SKIPPED (not FAIL) when mcp-entrypoint itself didn't resolve, so the
  // verdict stays coherent: there is nothing to boot yet.
  if (opts.mcp) {
    const resolved = (opts.whichBin ?? ((name: string) => Bun.which(name)))(
      "fbrain-mcp",
    );
    if (resolved) {
      const bootProbe = await runMcpBootProbe(resolved, opts, verbose);
      checks.push(bootProbe);
      verbose?.(`mcp-boot: ${tagOf(bootProbe)} — ${bootProbe.detail ?? ""}`);
    } else {
      checks.push(skippedByMcpUnresolved());
    }
  }

  // Disclosure probes — always WARN, no detection. They surface the
  // multi-machine + team-sharing limits called out in
  // docs/g0-replacement-readiness-gate.md §6 so the gate stays honest
  // about what fbrain does and doesn't do today.
  checks.push({
    name: "single-machine-slice",
    ok: true,
    tag: "WARN",
    detail:
      "you're on this daemon; record set is local — multi-machine reads " +
      "require fbrain to drive fold_db's sync transport (deployed but not " +
      "yet wired up from fbrain; tracked as G16)",
  });
  checks.push({
    name: "no-team-sync",
    ok: true,
    tag: "WARN",
    detail:
      "no team-sync transport — `fbrain share` is a placeholder until " +
      "cloud sync is signed in and validated end-to-end",
  });

  // --write probe — real put → get → soft-delete round-trip under a
  // reserved slug. The write-ready probe above is a static check; this is
  // the active proof that capability headers attach + the consent path
  // resolves + the node accepts the mutation. OFF by default so plain
  // `fbrain doctor` never mutates.
  if (opts.write) {
    if (cfgIssues.length === 0 && schemasLoadedOk) {
      const writeProbe = await runWriteRoundtripProbe(cfg, opts, verbose);
      checks.push(writeProbe);
      verbose?.(
        `write-roundtrip: ${tagOf(writeProbe)} — ${writeProbe.detail ?? ""}`,
      );
    } else {
      checks.push(skippedByPrereqs("write-roundtrip"));
    }
  }

  // G3 freshness + pollution probes — only when --freshness is set and the
  // upstream checks confirmed the node is workable.
  if (opts.freshness) {
    if (cfgIssues.length === 0 && schemasLoadedOk) {
      const freshness = await runFreshnessProbe(nodeClient, cfg, opts, verbose);
      checks.push(freshness);
      verbose?.(
        `freshness-probe: ${freshness.ok ? "ok" : `FAIL — ${freshness.detail ?? ""}`}`,
      );

      const pollution = await runPollutionProbe(nodeClient, cfg, opts, verbose);
      checks.push(pollution);
      verbose?.(
        `pollution-probe: ${tagOf(pollution)} — ${pollution.detail ?? ""}`,
      );
    } else {
      checks.push(skippedByPrereqs("freshness-probe"));
    }
  }

  return finalize(checks, print, opts.json);
}

function nodeReachabilityTransportDetail(nodeUrl: string, socketPath: string): string {
  if (existsSync(socketPath)) {
    return `unix:${socketPath} (TCP fallback ${nodeUrl})`;
  }
  return nodeUrl;
}

async function checkSchemaDrift(
  schemaClient: SchemaServiceClient,
  type: string,
  request: AddSchemaRequest,
  hash: string,
): Promise<CheckResult> {
  const name = `schema-drift[${type}]`;
  let registered: RegisteredSchema | null;
  try {
    registered = await schemaClient.getSchemaByHash(hash);
  } catch (err) {
    if (err instanceof FbrainError) {
      return {
        name,
        ok: false,
        detail: err.message,
        fix: "re-run `fbrain init`",
      };
    }
    throw err;
  }
  if (!registered) {
    return {
      name,
      ok: false,
      detail: `canonical hash ${hash} not found in schema service (deleted there?)`,
      fix: "re-run `fbrain init`",
    };
  }
  const classification = classifySchemaDrift(request, registered);
  switch (classification.kind) {
    case "none":
      return { name, ok: true, detail: `${registered.descriptive_name} @ ${hash.slice(0, 12)}…` };
    case "extras_only":
      // The schema service expanded fbrain's canonical schema against an
      // existing one (often a Schema.org starter_seed sharing the same
      // descriptive_name) and kept the extra fields. `fbrain init` cannot
      // shrink this — the service expands schemas, never deletes fields —
      // so the old fix-hint ("re-run init") was a dead end. The extras are
      // harmless: fbrain only writes the fields in schemas.ts. Demote to
      // WARN and explain the real recovery (bump descriptive_name) so the
      // user knows the doctor verdict isn't blocked on a re-init they've
      // already tried.
      return {
        name,
        ok: true,
        tag: "WARN",
        detail:
          `registered schema has extra field${classification.extras.length === 1 ? "" : "s"} ` +
          `not in schemas.ts: ${classification.extras.join(", ")}`,
        fix:
          "schema service expanded against an existing schema with the same descriptive_name; " +
          "extras are harmless (fbrain doesn't write them). `fbrain init` can't remove them — " +
          "the service grows fields via expansion only. To force a clean schema, bump " +
          `descriptive_name on the ${type} schema in src/schemas.ts and re-run \`fbrain init\`.`,
      };
    case "real_drift":
      return {
        name,
        ok: false,
        detail: classification.issues.join("; "),
        // Drift includes missing fields, type mismatches, or descriptive_name
        // changes — re-registering the canonical schema will either pick up
        // a new hash (genuinely fresh) or expand the existing one (returning
        // a hash that now reflects the union). Either way, init is the right
        // first step; if it persists, schemas.ts and the registered schema
        // have genuinely diverged and need a descriptive_name bump.
        fix:
          "re-run `fbrain init` so the config picks up the current canonical hash. " +
          "If drift persists, the schema service can't shrink registered schemas — " +
          "bump descriptive_name in src/schemas.ts to force a fresh registration.",
      };
  }
}

// Classify a drift comparison so doctor can tell "fbrain's canonical is a
// subset of the registered schema" (harmless expansion — schema service
// merged with a starter seed of the same descriptive_name) apart from
// genuine drift (missing fields, type mismatches). Extras-only never fails
// doctor's verdict because re-registering the canonical schema can't shrink
// the registered one — the schema service grows fields via expansion only.
export type DriftClassification =
  | { kind: "none" }
  | { kind: "extras_only"; extras: string[] }
  | { kind: "real_drift"; issues: string[] };

export function classifySchemaDrift(
  expected: AddSchemaRequest,
  actual: RegisteredSchema,
): DriftClassification {
  const issues = diffSchemas(expected, actual);
  if (issues.length === 0) return { kind: "none" };

  const expectedFields = new Set(expected.schema.fields);
  const actualFields = new Set(actual.fields);
  const extras: string[] = [];
  for (const f of actualFields) {
    if (!expectedFields.has(f)) extras.push(f);
  }
  // Extras-only iff the registered schema has extra fields AND every other
  // dimension matches (no missing fields, no type/name drift). diffSchemas
  // emits one line per drift dimension, so we identify the extras line by
  // prefix and treat any other line as a real drift signal.
  const nonExtraIssues = issues.filter(
    (i) => !i.startsWith("fields present only in registered schema"),
  );
  if (extras.length > 0 && nonExtraIssues.length === 0) {
    return { kind: "extras_only", extras };
  }
  return { kind: "real_drift", issues };
}

export function diffSchemas(
  expected: AddSchemaRequest,
  actual: RegisteredSchema,
): string[] {
  const issues: string[] = [];

  if (actual.descriptive_name !== expected.schema.descriptive_name) {
    issues.push(
      `descriptive_name mismatch: registered "${actual.descriptive_name}" vs schemas.ts "${expected.schema.descriptive_name}"`,
    );
  }

  const expectedFields = new Set(expected.schema.fields);
  const actualFields = new Set(actual.fields);
  const missingFromActual: string[] = [];
  for (const f of expectedFields) {
    if (!actualFields.has(f)) missingFromActual.push(f);
  }
  const extraInActual: string[] = [];
  for (const f of actualFields) {
    if (!expectedFields.has(f)) extraInActual.push(f);
  }
  if (missingFromActual.length > 0) {
    issues.push(`fields missing from registered schema: ${missingFromActual.join(", ")}`);
  }
  if (extraInActual.length > 0) {
    issues.push(`fields present only in registered schema: ${extraInActual.join(", ")}`);
  }

  for (const field of expected.schema.fields) {
    if (!actualFields.has(field)) continue;
    const exp = expected.schema.field_types[field];
    const act = actual.field_types[field];
    if (!sameFieldType(exp, act)) {
      issues.push(
        `field_types[${field}] mismatch: registered ${JSON.stringify(act)} vs schemas.ts ${JSON.stringify(exp)}`,
      );
    }
  }

  return issues;
}

function sameFieldType(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string") return a === b;
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as Record<string, unknown>);
    const bk = Object.keys(b as Record<string, unknown>);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return false;
    }
    return true;
  }
  return false;
}

// If a completed `migrate` manifest covers this schema and its to_hash
// matches the live config hash, the drift is documented and expected
// (schemas.ts hasn't been hand-edited yet to reflect the migration).
// Surface it as WARN with a fix pointer rather than failing the
// doctor verdict.
function softenDriftIfMigrated(
  drift: CheckResult,
  schemaKey: string,
  liveHash: string,
  manifests: MigrationManifest[],
): CheckResult {
  if (drift.ok) return drift;
  const matching = manifests.find(
    (m) =>
      m.scope.schema_key === schemaKey &&
      m.status === "complete" &&
      m.to_hash === liveHash,
  );
  if (!matching) return drift;
  return {
    ...drift,
    ok: true,
    tag: "WARN",
    detail: `${drift.detail ?? "drift detected"} — explained by migration ${matching.id}`,
    fix: `update src/schemas.ts to add "${matching.field_added}" to the ${schemaKey} schema so the next \`fbrain init\` keeps the new hash`,
  };
}

// Canonical deployed schema service Lambdas. Mirrored against the prod
// default in src/commands/init.ts and the dev URL in test/util.ts; kept
// inline here so the fix-hint stays self-contained (no cross-command
// import for one constant).
const SCHEMA_SERVICE_URL_DEV =
  "https://y0q3m6vk75.execute-api.us-west-2.amazonaws.com";
const SCHEMA_SERVICE_URL_PROD =
  "https://axo709qs11.execute-api.us-east-1.amazonaws.com";

// Branch the schema-service-reachable fix hint on the configured URL.
// Most fbrain users run against a deployed Lambda, so the original
// "start fold's schema service --local-schema" suggestion is only right
// for fold contributors pointing at localhost.
export function schemaServiceFixHint(url: string): string {
  if (/localhost|127\.0\.0\.1/.test(url)) {
    return "start fold's schema service (e.g. `./run.sh --local --local-schema`)";
  }
  if (url === SCHEMA_SERVICE_URL_DEV) {
    return `check your network or switch to prod (\`${SCHEMA_SERVICE_URL_PROD}\`)`;
  }
  if (url === SCHEMA_SERVICE_URL_PROD) {
    return `check your network or switch to dev (\`${SCHEMA_SERVICE_URL_DEV}\`)`;
  }
  return (
    `set \`schemaServiceUrl\` in ~/.fbrain/config.json to dev ` +
    `(\`${SCHEMA_SERVICE_URL_DEV}\`) or prod (\`${SCHEMA_SERVICE_URL_PROD}\`)`
  );
}

// client.ts appends "— run `fbrain doctor` for a full diagnosis" to every
// FbrainError message so non-doctor commands (list/put/etc.) point users
// here. Inside doctor's own output that tip is circular — the user is
// already running doctor. For the typed service_unreachable case
// synthesize a clean detail; for everything else (node_not_provisioned,
// missing_user_context, schema_http_*, …) strip the shared suffix off
// err.message via the helper exported from client.ts.
function doctorReachabilityDetail(err: unknown, which: string, baseUrl: string): string {
  if (err instanceof FbrainError && err.code === "service_unreachable") {
    return `${which} not reachable at ${baseUrl}`;
  }
  return stripDoctorTip(errMsg(err));
}

function safeListManifests(): MigrationManifest[] {
  try {
    return listManifests();
  } catch {
    return [];
  }
}

export function validateConfigShape(cfg: Config): string[] {
  const issues: string[] = [];
  for (const type of RECORD_TYPES as readonly RecordType[]) {
    const h = cfg.schemaHashes[type];
    if (!h || h.length === 0) {
      issues.push(`schemaHashes["${type}"] is missing`);
      continue;
    }
    if (!/^[0-9a-f]{64}$/i.test(h)) {
      issues.push(`schemaHashes["${type}"] "${h}" is not a 64-char hex string`);
    }
  }
  return issues;
}

function finalize(
  checks: CheckResult[],
  print: (line: string) => void,
  json = false,
): number {
  const failures = checks.filter((c) => !c.ok);
  // --json: emit one machine-readable object so agent-facing surfaces (CI,
  // scripts) can read the verdict + per-check tags programmatically. Each
  // entry mirrors the human line's components — name, tag (PASS/WARN/FAIL),
  // ok (drives the exit code; WARN is ok:true), detail, and fix.
  if (json) {
    const entries = checks.map((c) => ({
      name: c.name,
      tag: tagOf(c),
      ok: c.ok,
      ...(c.detail !== undefined ? { detail: c.detail } : {}),
      ...(c.fix !== undefined ? { fix: c.fix } : {}),
    }));
    print(
      JSON.stringify({
        ok: failures.length === 0,
        failures: failures.length,
        checks: entries,
      }),
    );
    return failures.length === 0 ? 0 : 1;
  }
  for (const check of checks) {
    const tag = tagOf(check);
    const detail = check.detail ? `  — ${check.detail}` : "";
    print(`[${tag}] ${check.name}${detail}`);
    if (check.fix && (tag === "FAIL" || tag === "WARN")) {
      print(`       fix:   ${check.fix}`);
    }
  }
  print("");
  if (failures.length === 0) {
    print("OK");
    return 0;
  }
  print(`FAIL: ${failures.length} issue${failures.length === 1 ? "" : "s"}`);
  return 1;
}

// One-token search probe: forces the node's lazy ONNX load so the
// `embedding_model_unavailable` failure surfaces as a structured FAIL in
// the doctor verdict rather than being hidden behind an `fbrain search`
// call. We don't care about the hit list — only whether the call
// completes. The probe is read-only and cheap, so it runs on every
// `fbrain doctor` invocation (no --freshness gate).
export async function runEmbeddingProbe(
  node: NodeClient,
  verbose: Verbose | undefined,
): Promise<CheckResult> {
  try {
    const hits = await node.search("fbrain", { localFallback: false });
    verbose?.(`embedding-runtime: ok (${hits.length} hits to probe query)`);
    return {
      name: "embedding-runtime",
      ok: true,
      detail: "one-token search returned without an embedding-model error",
    };
  } catch (err) {
    if (err instanceof FbrainError && err.code === "embedding_model_unavailable") {
      return {
        name: "embedding-runtime",
        ok: false,
        detail: stripDoctorTip(err.message),
        fix:
          err.hint ??
          "restart the node so it re-fetches the ONNX file (homebrew: `lastdb daemon stop && lastdb daemon start`)",
      };
    }
    if (err instanceof FbrainError && err.code === "node_http_404") {
      return {
        name: "embedding-runtime",
        ok: true,
        tag: "WARN",
        detail: "native semantic-search endpoint is unavailable; fbrain search will use local query fallback",
        fix:
          "upgrade the LastDB node to a build that serves native semantic search, or continue with local keyword fallback for Brain dedupe/search",
      };
    }
    return {
      name: "embedding-runtime",
      ok: false,
      detail: stripDoctorTip(errMsg(err)),
      fix: "check the node log; the native-index search endpoint is rejecting our probe query",
    };
  }
}

// G3a — freshness probe. Five trials of put → search; each trial passes
// when the freshly-written record surfaces in the top-K of a search for a
// unique marker word at score ≥ freshnessMinScore (default 0.5). The overall
// verdict is variance-tolerant: it PASSes on a healthy average score
// (≥ minScore) AND a majority of trials surfacing, so normal per-trial
// embedding-score noise on a healthy fresh brain does not flip it to a flaky
// FAIL — while writes that don't surface at all, or a systematically low
// average, still FAIL loudly. Probes are soft-deleted in a
// finally block so a thrown error mid-trial still cleans up. See
// docs/phase-7-search-latency-spike.md G3a.
export async function runFreshnessProbe(
  node: NodeClient,
  cfg: Config,
  opts: DoctorOptions,
  verbose: Verbose | undefined,
): Promise<CheckResult> {
  const trials = opts.freshnessTrials ?? 5;
  const minScore = opts.freshnessMinScore ?? 0.5;
  const nonce = (opts.nonceFn ?? defaultNonce)();
  const conceptHash = cfg.schemaHashes.concept;
  if (!conceptHash) {
    return {
      name: "freshness-probe",
      ok: false,
      detail: 'config has no schemaHashes["concept"]',
      fix: "re-run `fbrain init` so the config picks up all 8 schema hashes",
    };
  }

  type TrialResult = {
    slug: string;
    marker: string;
    found: boolean;
    score: number | null;
    pass: boolean;
  };
  const created: string[] = [];
  const trialResults: TrialResult[] = [];

  let searchError: string | null = null;
  try {
    for (let i = 0; i < trials; i++) {
      const slug = `doctor-freshness-probe-${nonce}-${i}`;
      const marker = `freshprobe${nonce}${i}`;
      const body =
        `Doctor freshness probe trial ${i}. Marker word: ${marker}. ` +
        `Generated by \`fbrain doctor --freshness\` — safe to delete.`;
      const now = nowIso();
      // Phase E per-kind Concept schema declares 7 fields: slug, title, body,
      // status, tags, created_at, updated_at. The legacy `kind` discriminator
      // and `v1_marker_a/b` structural markers are intentionally absent.
      const fields: Record<string, unknown> = {
        slug,
        title: `freshness probe ${i}`,
        body,
        status: "active",
        tags: [],
        created_at: now,
        updated_at: now,
      };
      await node.createRecord({ schemaHash: conceptHash, fields, keyHash: slug });
      created.push(slug);

      let hits: NativeIndexHit[];
      try {
        hits = await node.search(marker);
      } catch (err) {
        // The native-index search endpoint can fail independently of the
        // write path (e.g. node's embedding model.onnx is missing). Capture
        // the first failure as the probe's headline detail and stop trialing
        // — every subsequent trial would hit the same error. The `finally`
        // block still tombstones the records we already created.
        searchError = errMsg(err);
        verbose?.(
          `freshness trial ${i + 1}/${trials}: search threw — ${searchError}`,
        );
        break;
      }
      const own = hits.find(
        (h) => h.key_value.hash === slug && h.schema_name === conceptHash,
      );
      const score =
        own && typeof own.metadata?.score === "number" ? own.metadata.score : null;
      const found = own !== undefined;
      const pass = found && typeof score === "number" && score >= minScore;
      trialResults.push({ slug, marker, found, score, pass });
      verbose?.(
        `freshness trial ${i + 1}/${trials}: ${pass ? "PASS" : "FAIL"} ` +
          `slug=${slug} marker=${marker} found=${found} score=${score ?? "—"}`,
      );
    }
  } finally {
    for (const slug of created) {
      try {
        const cleanupFields = buildTombstoneFields("concept", slug, nowIso(), nowIso());
        await node.updateRecord({ schemaHash: conceptHash, fields: cleanupFields, keyHash: slug });
      } catch (err) {
        verbose?.(
          `freshness cleanup failed for ${slug}: ${errMsg(err)}`,
        );
      }
    }
  }

  if (searchError !== null) {
    return {
      name: "freshness-probe",
      ok: false,
      detail: `native-index search failed: ${searchError}`,
      fix: "the node's native-index search is unavailable (e.g. missing embedding model.onnx). Check the node log; restart the node with embeddings enabled.",
    };
  }

  const passed = trialResults.filter((t) => t.pass).length;
  const scored = trialResults.filter((t): t is TrialResult & { score: number } => t.score !== null);
  const avgScore =
    scored.length > 0
      ? scored.reduce((s, t) => s + t.score, 0) / scored.length
      : null;
  const detail =
    `${passed}/${trials} trial${trials === 1 ? "" : "s"} passed` +
    ` (min score ≥ ${minScore}; ` +
    (avgScore === null ? "no scores observed" : `avg observed score ${avgScore.toFixed(3)}`) +
    ")";

  // Variance-tolerant verdict. The all-trials-must-clear-0.5 gate was
  // non-deterministic on a perfectly healthy fresh brain: per-trial embedding
  // scores hover around ~0.6 and one (occasionally two) trials dipping below
  // the floor by normal noise flipped the whole verdict to a red FAIL/exit-1,
  // scaring off new devs who run the very health check `fbrain init`
  // recommends. (Empirically, on a healthy fresh brain ~3% of runs land at 3/5
  // and ~25% at 4/5 even though the average is consistently ~0.6 — the
  // all-or-nothing gate fired on all of those.) The genuine signal is "fresh
  // writes surface healthily", which is captured by a healthy *average* score
  // together with a majority of trials surfacing — NOT by every single trial
  // clearing the floor. (Same class as the pollution-probe low-N floor fixed in
  // doctor-pollution-probe-low-n-floor.)
  //
  // PASS when BOTH hold:
  //   - the average score is healthy (avgScore ≥ minScore) — the average is the
  //     stable signal; per-trial noise cancels out across trials; AND
  //   - a majority of trials surfaced at the floor (passed ≥ ceil(trials/2)) —
  //     so a high average carried by one or two outlier trials while most miss
  //     does NOT pass (that's a genuinely weak index, not noise).
  // This passes 5/5, 4/5, and the occasional 3/5 when the average is healthy,
  // while still failing a weak minority (≤ 2/5) or a systematically low average.
  const majorityThreshold = Math.ceil(trials / 2);
  const majoritySurfaced = passed >= majorityThreshold;
  const healthyAverage = avgScore !== null && avgScore >= minScore;
  if (majoritySurfaced && healthyAverage) {
    return { name: "freshness-probe", ok: true, detail };
  }

  // Genuine failure. Distinguish the two real causes so the fix line points
  // somewhere useful instead of blanket-recommending `fbrain reindex` (which
  // re-puts embeddings and does nothing for score variance or a node whose
  // writes aren't surfacing at all).
  const notSurfacing = avgScore === null || passed === 0;
  const fix = notSurfacing
    ? "fresh writes are not surfacing in search at all — this points at the node, not the index. Check the node log and confirm the embedding runtime is up (the native-index search must be returning our just-written record); restart the node with embeddings enabled if needed."
    : `fresh writes are surfacing but retrieval quality is systematically low (avg score < ${minScore} and/or only a weak minority of trials cleared the floor). Check the node's embedding model/runtime; if the live index has drifted, \`fbrain reindex\` re-puts every live record so its embedding is current (it does NOT de-duplicate the index or reduce pollution).`;
  return {
    name: "freshness-probe",
    ok: false,
    detail,
    fix,
  };
}

// G3a (pollution component) — issue one broad query and classify every hit
// into live / stale (record gone or tombstoned) / orphan (schema not an
// fbrain type). The ratio verdict (WARN above warnThreshold, default 25%)
// only applies once there are enough hits to be statistically meaningful:
// below `pollutionMinSample` (default 10) the percentage is dominated by a
// tiny denominator — a brand-new dev's own re-put/delete churn plus the
// freshness probe's own writes reads as "catastrophic" when nothing is
// wrong — so we report the raw counts with an explicit low-sample note and
// skip the threshold framing entirely. Mirrors the verbose `skip stale` /
// `skip schema_name matches no registered fbrain type` lines in `fbrain
// search`, and the same low-N discipline applied to the search weak-match
// advisory (card search-weak-match-sparse-brain-floor).
export async function runPollutionProbe(
  node: NodeClient,
  cfg: Config,
  opts: DoctorOptions,
  verbose: Verbose | undefined,
): Promise<CheckResult> {
  const query = opts.pollutionQuery ?? "fbrain";
  const warnThreshold = opts.pollutionWarnThreshold ?? 0.25;
  const failThreshold = opts.pollutionFailThreshold ?? 0.5;
  const minSample = opts.pollutionMinSample ?? 10;

  let hits: NativeIndexHit[];
  try {
    hits = await node.search(query);
  } catch (err) {
    return {
      name: "pollution-probe",
      ok: false,
      detail: `search "${query}" failed: ${errMsg(err)}`,
      fix: "check the node log; the native-index search endpoint is rejecting our query",
    };
  }
  const total = hits.length;
  if (total === 0) {
    return {
      name: "pollution-probe",
      ok: true,
      detail: `query "${query}" returned 0 hits — nothing to classify`,
    };
  }

  let stale = 0;
  let orphan = 0;
  let live = 0;
  for (const hit of hits) {
    const slug = hit.key_value.hash;
    const type = recordTypeForHash(hit.schema_name, cfg.schemaHashes);
    if (!type) {
      orphan++;
      verbose?.(
        `pollution: orphan schema_name="${hit.schema_name}" slug="${slug ?? "?"}"`,
      );
      continue;
    }
    if (!slug) {
      stale++;
      verbose?.(`pollution: stale (no slug) schema=${type}`);
      continue;
    }
    const schemaHash = cfg.schemaHashes[type]!;
    let record;
    try {
      record = await findBySlug(node, type, schemaHash, slug);
    } catch (err) {
      verbose?.(
        `pollution: findBySlug threw for ${type}/${slug}: ${errMsg(err)} — counting as stale`,
      );
      stale++;
      continue;
    }
    if (!record) {
      stale++;
      verbose?.(`pollution: stale ${type}/${slug}`);
    } else {
      live++;
      verbose?.(`pollution: live ${type}/${slug}`);
    }
  }

  // Small-sample floor: below `minSample` total hits the (stale+orphan)/total
  // ratio is low-N noise — a couple of stale embeddings from the dev's own
  // first re-put/delete (plus the freshness probe's own writes) reads as
  // "catastrophic" when nothing is wrong. Report the raw counts with an
  // explicit note and SKIP the warn/fail-threshold framing. Once there are
  // enough hits the ratio verdict below applies exactly as before.
  if (total < minSample) {
    return {
      name: "pollution-probe",
      ok: true,
      detail:
        `query "${query}" → ${total} hits: live ${live}, stale ${stale}, orphan ${orphan} ` +
        `— low sample (N=${total} < ${minSample}) — pollution % not meaningful on a small/new brain yet`,
    };
  }

  const stalePct = stale / total;
  const orphanPct = orphan / total;
  const combinedPct = (stale + orphan) / total;
  const detail =
    `query "${query}" → ${total} hits: ` +
    `live ${live}, stale ${stale} (${pct(stalePct)}), orphan ${orphan} (${pct(orphanPct)}) ` +
    `— pollution ${pct(combinedPct)}`;
  // Pollution = stale/superseded embeddings that fold_db's append-only index
  // does NOT purge on soft-delete or re-put. No fbrain-layer action can lower
  // it today (the purge is upstream G3d/G3e work), and `reindex` makes it
  // WORSE — each re-put appends a fresh embedding while the prior one persists
  // as stale. So a high ratio must surface as a WARN (visible, counted) and
  // must NOT fail the verdict or recommend `reindex`. See the honest hint.
  const pollutionHint =
    "stale/superseded embeddings — fold_db's append-only index does not purge them on soft-delete or re-put. " +
    "No fbrain command can lower this: `fbrain reindex` refreshes live embeddings but does NOT reduce pollution " +
    "(each re-put appends a new embedding and the prior one persists as stale). The index purge is tracked upstream. " +
    "User-facing search/ask is unaffected: they skip stale hits at query time; this is raw-index bloat, not wrong results.";
  if (combinedPct > failThreshold) {
    return {
      name: "pollution-probe",
      ok: true,
      tag: "WARN",
      detail: `${detail} (above ${pct(failThreshold)} fail-threshold, but not a verdict failure — see fix)`,
      fix: pollutionHint,
    };
  }
  if (combinedPct > warnThreshold) {
    return {
      name: "pollution-probe",
      ok: true,
      tag: "WARN",
      detail,
      fix: pollutionHint,
    };
  }
  return { name: "pollution-probe", ok: true, detail };
}

function defaultNonce(): string {
  // Lowercase hex from Date.now() + a random 24-bit suffix. Stays inside
  // the slug character set ([a-z0-9-_]).
  const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  return `${Date.now().toString(36)}${rand}`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

// Write-readiness probe — asks the two questions any mutation needs to
// answer "yes" to:
//   (a) is a valid CapabilityToken cached locally for this node? (load it,
//       run the same JCS integrity check the write path uses before replay).
//   (b) does the node's app registry know about fbrain? (probe
//       POST /api/apps/request-consent and read the status — 202 means
//       known, 404 means the registry has no fbrain entry).
// Read-only: the leftover pending consent request times out naturally
// within the node's 5-min consent window — we never poll or grant.
// Fails closed: any indeterminate state (consent endpoint 5xx / throws,
// keychain unreadable) surfaces as WARN, never silently PASS.
export async function runWriteReadyProbe(
  node: NodeClient,
  nodeUrl: string,
  store: CapabilityStore,
  verbose: Verbose | undefined,
): Promise<CheckResult> {
  // Client-side enforcement OFF means fbrain won't attach capability headers,
  // and on a node ALSO running enforcement-off writes land as NodeOwner with
  // no consent step at all. We can't introspect the node's setting, so we
  // declare the limitation: WARN so the doctor verdict stays green for the
  // dogfood case but the user sees the half-configured state.
  if (!appIdentityEnforceEnabled()) {
    verbose?.(`write-ready: enforcement off — emitting WARN`);
    return {
      name: "write-ready",
      ok: true,
      tag: "WARN",
      detail:
        "client app-identity enforcement is OFF (FBRAIN_APP_IDENTITY_ENFORCE) — " +
        "no capability check performed; writes will succeed only if the node also has enforcement off",
    };
  }

  // (a) Local capability check — load from the store + JCS-integrity-validate.
  // Mirrors the gate in CapabilitySession.loadValidCached() so this probe
  // never reports PASS for a cached token the write path would discard.
  let capabilityValid = false;
  let capabilityDetail = "no capability stored for this node";
  try {
    const cached = await store.load(nodeUrl);
    if (cached === null) {
      capabilityDetail = "no capability stored for this node";
    } else {
      const token = decodeCapabilityBlob(cached.blob);
      if (token === null) {
        capabilityDetail = "stored capability blob did not decode";
      } else if (token.app_id !== FBRAIN_APP_ID) {
        capabilityDetail = `stored capability is for app_id "${token.app_id}", not "${FBRAIN_APP_ID}"`;
      } else if (!(await tokenIntegrityValid(token))) {
        capabilityDetail = "stored capability failed JCS integrity check (tampered or stale)";
      } else {
        capabilityValid = true;
      }
    }
  } catch (err) {
    // The store path itself failed (keychain locked, file unreadable, …)
    // — we can't tell if writes would work or not, so WARN.
    verbose?.(
      `write-ready: capability store load threw — ${errMsg(err)}`,
    );
    return {
      name: "write-ready",
      ok: true,
      tag: "WARN",
      detail: `could not read capability store: ${errMsg(err)}`,
      fix: "check OS keychain access and ~/.fbrain/capabilities.json, then re-run `fbrain doctor`",
    };
  }
  verbose?.(`write-ready: capability=${capabilityValid ? "valid" : `absent (${capabilityDetail})`}`);

  // (b) Node app-registration check — POST request-consent and read the
  // status. We do NOT poll consent-status (that's an interactive grant).
  // 202 → app is known; 404 → registry has no fbrain entry; anything else
  // means we can't decide and the probe degrades to WARN.
  let registered: boolean;
  let registrationDetail = "";
  try {
    const res = await node.requestConsent(FBRAIN_APP_ID, "wildcard");
    if (res.status === 202) {
      registered = true;
    } else if (res.status === 404) {
      registered = false;
      const err = bodyErrorString(res.body);
      registrationDetail = err ?? "node returned 404 from /api/apps/request-consent";
    } else {
      verbose?.(`write-ready: consent dry-run returned HTTP ${res.status} — emitting WARN`);
      return {
        name: "write-ready",
        ok: true,
        tag: "WARN",
        detail: `consent dry-run returned HTTP ${res.status}; cannot determine write-readiness`,
        fix: "inspect the node log; once /api/apps/request-consent responds 202 / 404 cleanly, re-run `fbrain doctor`",
      };
    }
  } catch (err) {
    verbose?.(
      `write-ready: consent dry-run threw — ${errMsg(err)}`,
    );
    return {
      name: "write-ready",
      ok: true,
      tag: "WARN",
      detail: `consent dry-run threw: ${stripDoctorTip(errMsg(err))}`,
      fix: "inspect the node log; the consent endpoint is rejecting fbrain's probe",
    };
  }

  // Verdict — registration is the more actionable failure (capability is
  // moot without it), so it sorts first.
  if (!registered) {
    return {
      name: "write-blocked",
      ok: false,
      detail: `node does not recognise app "${FBRAIN_APP_ID}"${registrationDetail ? ` (${registrationDetail})` : ""}`,
      fix:
        "the node's app registry has no fbrain entry — every write will fail with `app_not_registered`. " +
        "Restart the daemon to warm the registry, or wait for the app_identity publish path to land if you're mid-migration " +
        "(`folddb-dev app publish --id fbrain` on the dev side).",
    };
  }
  if (!capabilityValid) {
    return {
      name: "write-blocked",
      ok: false,
      detail: capabilityDetail,
      fix:
        "run `fbrain init --grant-consent` to grant consent and store a capability — it works whether or not you have an interactive terminal (bare `fbrain init` skips the consent prompt without a TTY, so it no-ops here and loops). " +
        "It's idempotent, so it's safe interactively too (or run any write command — they all run the consent handshake on first use). " +
        "On the daemon side the grant is confirmed with `lastdb consent grant fbrain`.",
    };
  }
  return {
    name: "write-ready",
    ok: true,
    detail: "capability cached + JCS-valid for this node; consent dry-run returned 202",
  };
}

// MCP-entrypoint probe — resolve the `fbrain-mcp` bin on PATH so a new dev
// can see whether `claude mcp add fbrain fbrain-mcp` (the headline agent
// integration the README front-loads) will actually work. package.json `bin`
// declares both `fbrain` and `fbrain-mcp`, but a stale hand-installed `fbrain`
// shim can leave `fbrain` resolvable while `fbrain-mcp` is missing — and that
// breakage is otherwise invisible (the agent just can't reach the brain).
//
// Cheap + offline: PATH resolution via Bun.which only — we never spawn the
// MCP server. WARN (never FAIL) when unresolved so the verdict stays green
// for CLI-only users and source-checkout users (who register the path-based
// form), with an actionable re-link hint. PASS message carries the resolved
// path.
// Runtime probe — compare the running Bun against fbrain's documented minimum.
// PASS when `Bun.version >= MIN_BUN_VERSION` (single-sourced from
// package.json `engines.bun`); FAIL (not WARN — too old a runtime is a real
// blocker, not an optional nicety) with an actionable upgrade hint when older.
// The running version is injected via `bunVersion` (defaults to `Bun.version`)
// so both branches are testable without depending on the host's installed Bun.
// Cheap + offline: a pure version string compare, never touches the node.
export function runRuntimeProbe(
  opts: DoctorOptions,
  verbose: Verbose | undefined,
): CheckResult {
  const found = opts.bunVersion ?? Bun.version;
  if (bunVersionMeetsMinimum(found, MIN_BUN_VERSION)) {
    verbose?.(`runtime: Bun ${found} (>= ${MIN_BUN_VERSION})`);
    return {
      name: "runtime",
      ok: true,
      detail: `Bun ${found} (>= ${MIN_BUN_VERSION})`,
    };
  }
  verbose?.(`runtime: Bun ${found} is older than ${MIN_BUN_VERSION} — FAIL`);
  return {
    name: "runtime",
    ok: false,
    detail: `Bun ${found} is older than fbrain's minimum (${MIN_BUN_VERSION})`,
    fix:
      `your Bun (${found}) is older than fbrain's minimum (${MIN_BUN_VERSION}). ` +
      "Upgrade: `brew upgrade bun` (or `bun upgrade`), then re-run.",
  };
}

export function runMcpEntrypointProbe(
  opts: DoctorOptions,
  verbose: Verbose | undefined,
): CheckResult {
  const which = opts.whichBin ?? ((name: string) => Bun.which(name));
  const resolved = which("fbrain-mcp");
  if (resolved) {
    verbose?.(`mcp-entrypoint: resolved fbrain-mcp -> ${resolved}`);
    return {
      name: "mcp-entrypoint",
      ok: true,
      detail: `fbrain-mcp -> ${resolved}`,
    };
  }
  verbose?.(`mcp-entrypoint: fbrain-mcp not on PATH — emitting WARN`);
  return {
    name: "mcp-entrypoint",
    ok: true,
    tag: "WARN",
    detail:
      "MCP entrypoint 'fbrain-mcp' is not on PATH — agent integration " +
      "(`claude mcp add fbrain fbrain-mcp`) won't work",
    fix:
      "MCP entrypoint 'fbrain-mcp' not on PATH — agent integration won't work. " +
      "Re-run 'bun link' in the fbrain repo, then 'claude mcp add fbrain fbrain-mcp'. " +
      'From a source checkout: claude mcp add fbrain bun "$(realpath src/mcp/main.ts)".',
  };
}

// --mcp boot probe — the active proof the headline agent-integration surface
// actually works. `mcp-entrypoint` (above) only confirms the bin resolves on
// PATH; this BOOTS it. We spawn the resolved `fbrain-mcp` entrypoint, write a
// JSON-RPC `initialize` then `tools/list` to its stdin over stdio, read the
// responses, and assert the server returns a valid initialize result AND
// reports EXACTLY the 7 expected tool names (the set, so a missing/renamed
// tool fails). Bounded by a deadline + child kill (mirrors #270's
// attestOwnerSession discipline): a wedged server surfaces a clean FAIL, never
// a hung doctor. FAIL (not WARN) on any boot/handshake/tool-set failure, with
// an actionable re-link `fix`. Skipped (not FAIL) by the caller when
// `mcp-entrypoint` didn't resolve.

// Inputs handed to the boot runner so a test can stub the transport without
// re-resolving PATH or re-deriving the deadline.
export type McpBootInput = {
  // Absolute path the `mcp-entrypoint` probe resolved for `fbrain-mcp`.
  entrypoint: string;
  // Hard deadline for the whole spawn → handshake → tools/list round-trip.
  deadlineMs: number;
  verbose?: Verbose;
};

// Outcome of the boot handshake the PASS/FAIL classifier reads. `ok:false`
// carries a human reason; `serverInfo` + `tools` are present on a successful
// handshake (tools may still be the wrong set — the classifier checks that).
export type McpBootResult = {
  ok: boolean;
  // Failure reason (boot crash, handshake error, timeout). Set when ok:false.
  reason?: string;
  // `name`/`version` from the `initialize` result's serverInfo, when reached.
  serverInfo?: { name: string; version: string };
  // Tool names reported by `tools/list`, when reached.
  tools?: string[];
};

// Bounded deadline for the boot probe, env-overridable via the same
// FBRAIN_HTTP_TIMEOUT_MS knob the node transports honor (kept consistent with
// client.ts defaultTimeoutMs; replicated here because that helper is private).
function mcpBootDeadlineMs(): number {
  const raw = process.env.FBRAIN_HTTP_TIMEOUT_MS;
  const n = raw === undefined ? NaN : parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
}

export async function runMcpBootProbe(
  entrypoint: string,
  opts: DoctorOptions,
  verbose: Verbose | undefined,
): Promise<CheckResult> {
  const input: McpBootInput = {
    entrypoint,
    deadlineMs: mcpBootDeadlineMs(),
  };
  if (verbose) input.verbose = verbose;

  let result: McpBootResult;
  try {
    result = await (opts.mcpBootRunner ?? defaultMcpBootRunner)(input);
  } catch (err) {
    // The runner is expected to convert failures into a structured
    // McpBootResult, but a genuinely unexpected throw still becomes a clean
    // FAIL rather than an uncaught rejection that hangs/aborts doctor.
    result = { ok: false, reason: stripDoctorTip(errMsg(err)) };
  }

  const relinkFix =
    "boot fbrain-mcp by hand to see why: `printf '{}' | fbrain-mcp` should not crash. " +
    "Re-run `bun link` in the fbrain repo, then re-add via `claude mcp add fbrain fbrain-mcp`. " +
    'From a source checkout: claude mcp add fbrain bun "$(realpath src/mcp/main.ts)".';

  if (!result.ok) {
    return {
      name: "mcp-boot",
      ok: false,
      detail: `fbrain-mcp boot/handshake failed: ${result.reason ?? "unknown error"}`,
      fix: relinkFix,
    };
  }

  const expected = [...FBRAIN_MCP_TOOL_NAMES];
  const got = result.tools ?? [];
  const gotSet = new Set(got);
  const expectedSet = new Set<string>(expected);
  const missing = expected.filter((t) => !gotSet.has(t));
  const unexpected = got.filter((t) => !expectedSet.has(t));

  if (missing.length > 0 || unexpected.length > 0) {
    const parts: string[] = [`reported ${got.length} tool(s)`];
    if (missing.length > 0) parts.push(`missing: ${missing.join(", ")}`);
    if (unexpected.length > 0) parts.push(`unexpected: ${unexpected.join(", ")}`);
    return {
      name: "mcp-boot",
      ok: false,
      detail: `fbrain-mcp tool surface mismatch — ${parts.join("; ")} (expected exactly ${expected.length})`,
      fix: relinkFix,
    };
  }

  const info = result.serverInfo;
  const infoStr = info ? `serverInfo ${info.name} ${info.version}` : "serverInfo (none)";

  // Version-skew WARN: the agent surface is the same fbrain *codebase* but a
  // DIFFERENT *build* than the CLI we're running. `serverInfo.version` and the
  // CLI's `getFbrainVersion()` are single-sourced (mcp/server.ts +
  // version.ts), so they can't drift WITHIN one checkout — but `fbrain-mcp` on
  // PATH can resolve to a stale `bun link`ed checkout / second worktree at a
  // different commit. When the version strings differ, the AI agent may be
  // serving stale `fbrain_*` tool behavior while the human CLI is current — a
  // real, hard-to-diagnose state. WARN (ok:true, doesn't trip the verdict),
  // never the tool-surface FAIL above.
  const cliVersion = opts.cliVersion ?? getFbrainVersion();
  if (info && info.version !== cliVersion) {
    return {
      name: "mcp-boot",
      ok: true,
      tag: "WARN",
      detail:
        `fbrain-mcp booted + served the full agent surface (tools=${got.length}), ` +
        `but it's a DIFFERENT fbrain build than this CLI (CLI ${cliVersion}, agent ${info.version}) — ` +
        "your AI agent may be serving stale fbrain_* tools.",
      fix: relinkFix,
    };
  }

  return {
    name: "mcp-boot",
    ok: true,
    detail: `fbrain-mcp booted + served the full agent surface — tools=${got.length}, ${infoStr}`,
  };
}

// Default boot runner: spawn the resolved `fbrain-mcp` entrypoint, drive a
// line-delimited JSON-RPC initialize + tools/list handshake over its stdio,
// and tear the child down in a finally. Bounded by `input.deadlineMs` via a
// timer that kills the child — a wedged/hung server surfaces a clean timeout
// FAIL instead of hanging doctor.
async function defaultMcpBootRunner(
  input: McpBootInput,
): Promise<McpBootResult> {
  const { entrypoint, deadlineMs, verbose } = input;

  const proc = Bun.spawn([entrypoint], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  // The deadline is enforced by RACING every blocking read against a timer
  // promise — NOT by relying on proc.kill() to unblock a pending
  // `reader.read()`. Killing the child does not reliably reject an in-flight
  // read of a piped stream in Bun, so a wedged server that never writes a byte
  // would otherwise hang the read (and thus doctor) forever despite the kill.
  // The race resolves the moment the deadline fires; the finally then
  // SIGKILLs the child so even a SIGTERM-deaf / sleeping server is reaped.
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve("timeout");
    }, deadlineMs);
  });

  try {
    // JSON-RPC over stdio: one request object per line. `initialize` first
    // (required by the protocol), then `tools/list`. We don't send the
    // `notifications/initialized` notice — `tools/list` works without it for
    // this read-only probe and keeps the exchange minimal.
    const initReq = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "fbrain-doctor-mcp-probe", version: "1" },
      },
    };
    const listReq = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

    const writer = proc.stdin;
    // Writing to a stalled/full pipe could itself block; race it too so a
    // server that never drains its stdin can't wedge the probe before we even
    // start reading.
    writer.write(`${JSON.stringify(initReq)}\n`);
    writer.write(`${JSON.stringify(listReq)}\n`);
    await Promise.race([writer.flush(), deadline]);

    // Read stdout until we've seen responses for both ids (or the stream ends
    // / the deadline fires). Each blocking read is raced against `deadline`,
    // so a server that goes silent surfaces a bounded timeout instead of an
    // unbounded hang. The SDK emits one JSON object per line.
    const responses = new Map<number, Record<string, unknown>>();
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = proc.stdout.getReader();
    try {
      while (responses.size < 2 && !timedOut) {
        const next = await Promise.race([reader.read(), deadline]);
        if (next === "timeout") break;
        const { value, done } = next;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line.length === 0) continue;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(line) as Record<string, unknown>;
          } catch {
            // Non-JSON line on stdout (stray log); ignore and keep reading.
            continue;
          }
          const id = msg.id;
          if (typeof id === "number") responses.set(id, msg);
        }
      }
    } finally {
      // cancel() (not just releaseLock) so the underlying read is abandoned
      // and the stream torn down even if a read is still pending behind the
      // race we abandoned.
      try {
        await reader.cancel();
      } catch {
        // stream already errored/closed.
      }
    }

    if (timedOut) {
      return {
        ok: false,
        reason: `boot/handshake exceeded the ${deadlineMs}ms deadline (server hung or never spoke MCP)`,
      };
    }

    const initRes = responses.get(1);
    if (!initRes || initRes.error || !isRecord(initRes.result)) {
      const errMessage = describeRpcError(initRes, "initialize");
      verbose?.(`mcp-boot: initialize failed — ${errMessage}`);
      return { ok: false, reason: errMessage };
    }
    const listRes = responses.get(2);
    if (!listRes || listRes.error || !isRecord(listRes.result)) {
      const errMessage = describeRpcError(listRes, "tools/list");
      verbose?.(`mcp-boot: tools/list failed — ${errMessage}`);
      return { ok: false, reason: errMessage };
    }

    const serverInfo = readServerInfo(initRes.result);
    const tools = readToolNames(listRes.result);
    const out: McpBootResult = { ok: true, tools };
    if (serverInfo) out.serverInfo = serverInfo;
    return out;
  } catch (err) {
    if (timedOut) {
      return {
        ok: false,
        reason: `boot/handshake exceeded the ${deadlineMs}ms deadline`,
      };
    }
    return { ok: false, reason: stripDoctorTip(errMsg(err)) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // SIGKILL (not the default SIGTERM): a wedged or SIGTERM-deaf server must
    // die immediately so the probe never leaves an orphaned child behind.
    try {
      proc.kill("SIGKILL");
    } catch {
      // already exited.
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function describeRpcError(
  msg: Record<string, unknown> | undefined,
  method: string,
): string {
  if (!msg) return `${method}: no response before stream end`;
  const err = msg.error;
  if (isRecord(err)) {
    const m = typeof err.message === "string" ? err.message : JSON.stringify(err);
    return `${method} returned an error: ${m}`;
  }
  return `${method}: malformed response (no result)`;
}

function readServerInfo(
  result: Record<string, unknown>,
): { name: string; version: string } | undefined {
  const info = result.serverInfo;
  if (!isRecord(info)) return undefined;
  const name = typeof info.name === "string" ? info.name : "?";
  const version = typeof info.version === "string" ? info.version : "?";
  return { name, version };
}

function readToolNames(result: Record<string, unknown>): string[] {
  const tools = result.tools;
  if (!Array.isArray(tools)) return [];
  const names: string[] = [];
  for (const t of tools) {
    if (isRecord(t) && typeof t.name === "string") names.push(t.name);
  }
  return names;
}

// Skipped-by-prereq variant for the boot probe: distinct from the generic
// skippedByPrereqs (config/schemas) because the boot probe's only prereq is
// that `mcp-entrypoint` resolved the bin. Keeping it a coherent skip (ok:true,
// WARN) rather than a FAIL means `--mcp` on a CLI-only / source-checkout user
// who hasn't put `fbrain-mcp` on PATH doesn't flip the verdict — the
// mcp-entrypoint WARN above already carries the re-link fix.
function skippedByMcpUnresolved(): CheckResult {
  return {
    name: "mcp-boot",
    ok: true,
    tag: "WARN",
    detail:
      "skipped — `fbrain-mcp` did not resolve on PATH, so there is nothing to boot " +
      "(see the mcp-entrypoint check above for the re-link fix)",
  };
}

// --write round-trip probe — the active proof that writes land end-to-end.
// Puts a sentinel concept under a reserved `doctor-write-roundtrip-<nonce>`
// slug, reads it back via findBySlug, then soft-deletes in a finally so a
// thrown error mid-trip still cleans up. Uses the same capability-aware
// write path the real `fbrain put` uses, so it actually exercises the
// CapabilitySession → consent → mutate pipeline.
export async function runWriteRoundtripProbe(
  cfg: Config,
  opts: DoctorOptions,
  verbose: Verbose | undefined,
): Promise<CheckResult> {
  const conceptHash = cfg.schemaHashes.concept;
  if (!conceptHash) {
    return {
      name: "write-roundtrip",
      ok: false,
      detail: 'config has no schemaHashes["concept"]',
      fix: "re-run `fbrain init` so the config picks up all 8 schema hashes",
    };
  }

  const nonce = (opts.nonceFn ?? defaultNonce)();
  const slug = `doctor-write-roundtrip-${nonce}`;

  const wnOpts: WriteNodeClientOptions = {
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
  };
  if (verbose) wnOpts.verbose = verbose;
  if (opts.capabilityStore) wnOpts.store = opts.capabilityStore;
  const { node } = (opts.writeNodeFactory ?? newWriteNodeClient)(wnOpts);

  let created = false;
  try {
    const now = nowIso();
    await node.createRecord({
      schemaHash: conceptHash,
      keyHash: slug,
      fields: {
        slug,
        title: `doctor write-roundtrip probe ${nonce}`,
        body:
          `Doctor --write round-trip probe. Slug: ${slug}. ` +
          `Generated by \`fbrain doctor --write\` — safe to delete.`,
        status: "active",
        tags: [],
        created_at: now,
        updated_at: now,
      },
    });
    created = true;

    const echo = await findBySlug(node, "concept", conceptHash, slug);
    if (!echo) {
      return {
        name: "write-roundtrip",
        ok: false,
        detail: `wrote ${slug} but a subsequent read returned null`,
        fix: "the create reported success but the record isn't readable — inspect the node log",
      };
    }
    return {
      name: "write-roundtrip",
      ok: true,
      detail: `put → get → soft-delete round-trip succeeded under slug "${slug}"`,
    };
  } catch (err) {
    return {
      name: "write-roundtrip",
      ok: false,
      detail: stripDoctorTip(errMsg(err)),
      fix: "the round-trip write failed — see the error above and the node log; check `fbrain doctor` for the write-ready / consent status",
    };
  } finally {
    if (created) {
      try {
        const cleanupFields = buildTombstoneFields("concept", slug, nowIso(), nowIso());
        await node.updateRecord({ schemaHash: conceptHash, fields: cleanupFields, keyHash: slug });
      } catch (err) {
        verbose?.(
          `write-roundtrip cleanup failed for ${slug}: ${errMsg(err)}`,
        );
      }
    }
  }
}

// Schema-service publish-gate probe used when there is no config yet (init
// hasn't completed). Issues one POST /v1/schemas against the configured
// schema service and translates the discriminated `cert_required` response
// into a structured FAIL with the same remedy text the init error carries.
// Other outcomes are squashed to a single WARN so the probe never overstates
// confidence on a network-flaky run — the real publish path is `fbrain init`.
//
// `schemaClientFactory` (from opts) lets tests stub the schema service; in
// production we use the default factory pointed at the URL from opts.nodeUrl
// / opts.schemaServiceUrl or the init defaults when the user has no config.
export async function runSchemaPublishGateProbe(
  opts: DoctorOptions,
  verbose: Verbose | undefined,
): Promise<CheckResult | null> {
  const url = DEFAULT_SCHEMA_SERVICE_URL;
  const factory = opts.schemaClientFactory ?? newSchemaServiceClient;
  const client = factory(url, verbose);
  // Pick a fbrain-namespaced schema with a stable hash; any of the 8 schemas
  // would trip the same cert_required gate, since the schema service checks
  // for a DevCert before deciding the operation is idempotent.
  const probe = UNIQUE_SCHEMAS.find((s) => s.key === "design") ?? UNIQUE_SCHEMAS[0];
  if (!probe) return null;
  try {
    await client.registerSchema(probe.schema);
    // EXPECTED on prod: fbrain's 8 schemas are ALREADY published there (that's
    // how `init` resolves their canonical hashes without a DevCert), so this
    // re-register is idempotent and succeeds. Success means the publish gate
    // isn't blocking onboarding — a calm PASS, not an alarm. Don't imply
    // doctor "published" anything; the no-config `[FAIL] config`
    // (→ "run `fbrain init`") line already drives doctor's red verdict.
    verbose?.(`schema-publish-gate: fbrain/* already published (idempotent re-register) PASS`);
    return {
      name: "schema-publish-gate",
      ok: true,
      detail:
        `schema service at ${url} already has fbrain/* published ` +
        `(idempotent re-register succeeded) — the publish gate isn't blocking; ` +
        `run \`fbrain init\` to finish onboarding`,
    };
  } catch (err) {
    if (err instanceof FbrainError && err.code === "schema_cert_required") {
      // `cert_required` is the EXPECTED state for a fresh consumer, NOT a
      // blocker. The schema service gates POST /v1/schemas behind a DevCert
      // for the namespaced `fbrain/*` schemas — but `fbrain init` never needs
      // to publish: it loads the cert-free catalog and resolves the
      // already-published canonical hashes from the node (proven by the
      // init.ts "cert_required POST → resolves all 8 hashes, no throw" path).
      // Reporting this as a FAIL with "init cannot complete" is a false
      // dead-end that scares fresh adopters away before they've even run
      // init. Surface it as a calm PASS; the no-config `[FAIL] config` line
      // (→ "run `fbrain init`") already drives doctor's red verdict.
      verbose?.(`schema-publish-gate: cert_required (expected consumer state) PASS`);
      return {
        name: "schema-publish-gate",
        ok: true,
        detail:
          `schema service at ${url} gates fbrain/* publishing behind a DevCert ` +
          `(cert_required) — expected for a consumer; \`fbrain init\` resolves the ` +
          `already-published canonical hashes from the node, no DevCert needed`,
      };
    }
    // Anything else (schema service unreachable, 5xx, unknown 401 body) —
    // emit a WARN so the user sees we tried, without claiming we know what's
    // wrong. The probe is a diagnostic, not a verdict.
    verbose?.(
      `schema-publish-gate: probe inconclusive — ${errMsg(err)}`,
    );
    return {
      name: "schema-publish-gate",
      ok: true,
      tag: "WARN",
      detail: `could not probe schema service at ${url}: ${stripDoctorTip(errMsg(err))}`,
    };
  }
}

function bodyErrorString(body: unknown): string | undefined {
  if (body && typeof body === "object" && "error" in body) {
    const v = (body as Record<string, unknown>).error;
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function tagOf(check: CheckResult): "PASS" | "WARN" | "FAIL" | "SKIP" {
  return check.tag ?? (check.ok ? "PASS" : "FAIL");
}

// A node-dependent check that couldn't run because `node-reachable` FAILed.
// Neutral (ok: true, tag "SKIP" — rendered like WARN, never a pass or a
// fail) so the verdict stays a single node-reachable FAIL, but the check
// still appears in the list with an honest "node unreachable" reason instead
// of silently vanishing the way it did pre-this-change.
function skippedByNodeUnreachable(name: string, why?: string): CheckResult {
  return {
    name,
    ok: true,
    tag: "SKIP",
    detail: `node unreachable${why ? `; ${why}` : ""}`,
  };
}

function skippedByPrereqs(name: string): CheckResult {
  return {
    name,
    ok: false,
    detail: "skipped — config or schemas-loaded did not pass",
    fix: "resolve the earlier failures and retry",
  };
}
