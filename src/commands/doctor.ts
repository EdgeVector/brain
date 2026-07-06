// `fbrain doctor` — live health check for the local fbrain setup.
//
// Contract:
// - plain `fbrain doctor` is read-only and never creates consent requests,
//   records, schema loads, or child MCP processes.
// - Node-dependent checks keep a stable shape: unmet prerequisites render
//   neutral SKIP rows, not vanished rows and not FAILs.
// - WARN/SKIP are informational; only `ok:false` checks drive exit 1.
// - Opt-in probes live behind `--freshness`, `--write`, and `--mcp`.

import {
  defaultFolddbSocketPath,
  discoverFullSurfaceSocket,
  FbrainError,
  isNodeReachableButErroring,
  newNodeClient,
  newSchemaServiceClient,
  nodeDownHint,
  nodeHttpErrorHint,
  stripDoctorTip,
  type NodeClient,
  type SchemaServiceClient,
  type Verbose,
} from "../client.ts";
import { tryReadConfig } from "../config.ts";
import { resolvePrintSink } from "../format.ts";
import {
  runEmbeddingProbe,
  runFreshnessProbe,
  runPollutionProbe,
  runRuntimeProbe,
  runWriteReadyProbe,
  runWriteRoundtripProbe,
} from "./doctor/g3-probes.ts";
import {
  type McpBootInput,
  type McpBootResult,
  runMcpEntrypointProbe,
  runMcpBootProbe,
  skippedByMcpUnresolved,
} from "./doctor/mcp-boot.ts";
import {
  checkSchemaDrift,
  safeListManifests,
  schemaServiceFixHint,
  softenDriftIfMigrated,
  runSchemaPublishGateProbe,
  validateConfigShape,
} from "./doctor/schema-drift.ts";
import { runUsageReport, type UsageOptions } from "./usage.ts";
import { type CapabilityStore } from "../capability.ts";
import { defaultCapabilityStore } from "../keychain.ts";
import { UNIQUE_SCHEMAS } from "../schemas.ts";
import type { WriteNodeClient, WriteNodeClientOptions } from "../write-context.ts";

export {
  runEmbeddingProbe,
  runFreshnessProbe,
  runPollutionProbe,
  runRuntimeProbe,
  runWriteReadyProbe,
  runWriteRoundtripProbe,
} from "./doctor/g3-probes.ts";
export {
  type McpBootInput,
  type McpBootResult,
  runMcpBootProbe,
  runMcpEntrypointProbe,
} from "./doctor/mcp-boot.ts";
export {
  classifySchemaDrift,
  diffSchemas,
  schemaServiceFixHint,
  validateConfigShape,
} from "./doctor/schema-drift.ts";

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
  // the 10-tool agent surface. OFF by default so plain `fbrain doctor` never
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
export type CheckResult = {
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
  const nodeSocketPath = defaultFolddbSocketPath(cfg.nodeSocketPath);
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
      detail: `${doctorNodeConfigDetail(cfg.nodeUrl, nodeSocketPath)} schemaServiceUrl=${cfg.schemaServiceUrl}`,
    });
  }
  verbose?.(`config: ${cfgIssues.length === 0 ? "ok" : `bad — ${cfgIssues.join("; ")}`}`);

  const schemaClient = (opts.schemaClientFactory ?? newSchemaServiceClient)(
    cfg.schemaServiceUrl,
    verbose,
  );
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
      const missing = DOCTOR_RECORD_SCHEMAS.filter((entry) => {
        const hash = cfg.schemaHashes[entry.key];
        return !hash || !loadedHashes.has(hash);
      }).map((entry) => entry.schema.schema.descriptive_name);
      if (missing.length === 0) {
        schemasLoadedOk = true;
        checks.push({
          name: "schemas-loaded",
          ok: true,
          detail: `${DOCTOR_RECORD_SCHEMAS.length}/${DOCTOR_RECORD_SCHEMAS.length} fbrain record schemas present in the node DB`,
        });
        verbose?.(`schemas-loaded: ok (${DOCTOR_RECORD_SCHEMAS.length}/${DOCTOR_RECORD_SCHEMAS.length})`);
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
  } else {
    checks.push(skippedByPrereqs("schemas-loaded", "node is not provisioned"));
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
    // comparison against the user's node, and one green line per schema next to a red
    // `node-reachable` read as "my schemas are fine on my node," which was
    // never checked. Collapse to a single honest SKIP when the node is down.
    checks.push(
      skippedByNodeUnreachable("schema-drift", "can't compare against the node DB"),
    );
  } else if (cfgIssues.length === 0 && !provisioned) {
    checks.push(skippedByPrereqs("schema-drift", "node is not provisioned"));
  } else if (cfgIssues.length === 0) {
    for (const entry of DOCTOR_RECORD_SCHEMAS) {
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
  } else {
    checks.push(skippedByPrereqs("embedding-runtime"));
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
  } else {
    checks.push(skippedByPrereqs("write-ready"));
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
  const fullSocketPath = discoverFullSurfaceSocket(socketPath);
  // A pre-collapse node exposes a distinct folddb-full.sock beside the control
  // socket; name both.
  if (fullSocketPath && fullSocketPath !== socketPath) {
    return `unix:${socketPath} + unix:${fullSocketPath}`;
  }
  // fold #1246 collapsed the full-surface socket INTO the control socket, so a
  // current node serves every route (data-plane AND owner) on the one socket.
  if (fullSocketPath === socketPath) {
    return `unix:${socketPath}`;
  }
  return nodeUrl;
}

function doctorNodeConfigDetail(nodeUrl: string, socketPath: string): string {
  const fullSocketPath = discoverFullSurfaceSocket(socketPath);
  if (fullSocketPath && fullSocketPath !== socketPath) {
    return `node=unix:${socketPath} full=unix:${fullSocketPath}`;
  }
  if (fullSocketPath === socketPath) return `node=unix:${socketPath}`;
  return `nodeUrl=${nodeUrl}`;
}

// client.ts appends "— run `fbrain doctor` for a full diagnosis" to every
// FbrainError message so non-doctor commands point users here. Doctor strips
// that circular tip from its own output.
function doctorReachabilityDetail(err: unknown, which: string, baseUrl: string): string {
  if (err instanceof FbrainError && err.code === "service_unreachable") {
    return `${which} not reachable at ${baseUrl}`;
  }
  return stripDoctorTip(errMsg(err));
}

function finalize(
  checks: CheckResult[],
  print: (line: string) => void,
  json = false,
): number {
  const failures = checks.filter((c) => !c.ok);
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

function skippedByPrereqs(name: string, why = "config or schemas-loaded did not pass"): CheckResult {
  return {
    name,
    ok: true,
    tag: "SKIP",
    detail: `skipped — ${why}`,
  };
}
const DOCTOR_RECORD_SCHEMAS = UNIQUE_SCHEMAS.filter(
  (entry) => entry.types.length > 0,
);
