import { existsSync } from "node:fs";
// `brain doctor` — live health check for the local brain setup.
//
// Contract:
// - plain `brain doctor` is read-only and never creates consent requests,
//   records, schema loads, or child MCP processes.
// - Node-dependent checks keep a stable shape: unmet prerequisites render
//   neutral SKIP rows, not vanished rows and not FAILs.
// - WARN/SKIP are informational; only `ok:false` checks drive exit 1.
// - Opt-in probes live behind `--freshness`, `--write`, and `--mcp`.

import {
  defaultFolddbSocketPath,
  BrainError,
  isNodeReachableButErroring,
  newNodeClient,
  nodeDownHint,
  nodeHttpErrorHint,
  stripDoctorTip,
  type NodeClient,
  type Verbose,
} from "../client.ts";
import { tryReadConfig } from "../config.ts";
import { resolvePrintSink } from "../format.ts";
import {
  runEmbeddingProbe,
  type EmbeddingProbeDeps,
  runFreshnessProbe,
  runPollutionProbe,
  runRuntimeProbe,
  runWriteReadyProbe,
  runWriteRoundtripProbe,
} from "./doctor/g3-probes.ts";
import {
  type McpBootInput,
  type McpBootResult,
  runCliEntrypointProbe,
  runMcpEntrypointProbe,
  runMcpBootProbe,
  skippedByMcpUnresolved,
} from "./doctor/mcp-boot.ts";
import { runGraphEdgeLintProbe } from "./doctor/graph-lint.ts";
import {
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
  runCliEntrypointProbe,
  runMcpBootProbe,
  runMcpEntrypointProbe,
} from "./doctor/mcp-boot.ts";
export {
  validateConfigShape,
} from "./doctor/schema-drift.ts";

export type DoctorOptions = {
  configPath?: string;
  verbose?: Verbose;
  print?: (line: string) => void;
  // For testing: inject a prebuilt node client to bypass the real fetches.
  nodeClientFactory?: (opts: {
    baseUrl: string;
    userHash: string;
    verbose?: Verbose;
    socketPath?: string;
    schemaFieldAliases?: import("../field-alias-transport.ts").FieldAliasProfiles;
  }) => NodeClient;
  // For testing: inject the search plane. Without this seam the
  // embedding-runtime probe consults the REAL plane on the host, so a test that
  // mocks only the node is not hermetic — it passes or fails depending on
  // whether the machine running it happens to have LastSeek installed.
  searchPlane?: EmbeddingProbeDeps["queryPlane"];
  // --freshness probes (G3a in docs/phase-7-search-latency-spike.md).
  freshness?: boolean;
  freshnessTrials?: number;            // default 5
  freshnessMinScore?: number;          // default 0.5
  pollutionQuery?: string;             // default "brain"
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
  // `brain doctor` never mutates.
  write?: boolean;
  // Override for tests: the capability store the write-ready probe inspects
  // and the round-trip writes use. Defaults to the OS keychain store.
  capabilityStore?: CapabilityStore;
  // Override for tests: the write-node-client factory used by the round-trip
  // probe. Defaults to newWriteNodeClient.
  writeNodeFactory?: (opts: WriteNodeClientOptions) => WriteNodeClient;
  // Override for tests: resolve a bin name to its absolute path on PATH (or
  // null when unresolved). Defaults to Bun.which. Lets the brain-entrypoint
  // and mcp-entrypoint probes be exercised in both the resolved + unresolved
  // states without mutating the test process's real PATH.
  whichBin?: (name: string) => string | null;
  // Override for tests: HOME used when entrypoint probes inspect common Bun
  // global-bin locations for stale/dangling symlinks. Defaults to process.env.HOME.
  homeDir?: string;
  // Override for tests: the running Bun version the `runtime` check compares
  // against brain's documented minimum (MIN_BUN_VERSION). Defaults to the live
  // `Bun.version`. An explicit seam (like `whichBin`) so doctor.test.ts can
  // drive both the too-old FAIL branch and the supported PASS branch
  // deterministically without depending on the host's installed Bun.
  bunVersion?: string;
  // --mcp boot probe: actually SPAWN the resolved `brain-mcp` entrypoint,
  // drive a JSON-RPC initialize + tools/list handshake over stdio, and assert
  // the 10-tool agent surface. OFF by default so plain `brain doctor` never
  // spawns the server (stays cheap + offline, like --write / --freshness).
  mcp?: boolean;
  // Override for tests: spawn the MCP boot probe against a fake transport
  // instead of the real `brain-mcp` child process. Receives the resolved
  // entrypoint + a deadline; returns the handshake outcome the PASS/FAIL
  // logic classifies. Defaults to a real child-process stdio handshake.
  mcpBootRunner?: (input: McpBootInput) => Promise<McpBootResult>;
  // Override for tests: the running CLI's version string the mcp-boot probe
  // compares against the booted agent surface's `serverInfo.version` to detect
  // a build skew (a stale `bun link`ed brain-mcp from a different checkout).
  // Defaults to `getBrainVersion()` — the same single-sourced string the MCP
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
      detail: "no ~/.brain/config.json",
      fix: "run `brain init`",
    });
    return finalize(checks, print, opts.json);
  }
  const nodeSocketPath = defaultFolddbSocketPath(cfg.nodeSocketPath);
  const cfgIssues = validateConfigShape(cfg);
  if (cfgIssues.length > 0) {
    checks.push({
      name: "config",
      ok: false,
      detail: cfgIssues.join("; "),
      fix: "re-run `brain init` to refresh schema addresses and definition identities",
    });
  } else {
    checks.push({
      name: "config",
      ok: true,
      detail: doctorNodeConfigDetail(cfg.nodeUrl, nodeSocketPath),
    });
  }
  verbose?.(`config: ${cfgIssues.length === 0 ? "ok" : `bad — ${cfgIssues.join("; ")}`}`);

  const nodeClient = (opts.nodeClientFactory ?? newNodeClient)({
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
    verbose,
    socketPath: nodeSocketPath,
    schemaFieldAliases:cfg.schemaFieldAliases,
    // doctor describes an old node instead of refusing to look at it.
    skipApiVersionGate: true,
  });

  // --usage diverts to the team-adoption report (G13). It needs a valid
  // config + reachable node but doesn't depend on the freshness checks, so
  // we short-circuit before running them.
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

  // Reachability is one keyed read. Identity, health, and version routes are
  // not on the app socket.
  let provisioned = false;
  let nodeReachable = false;
  const designPin = cfg.schemaHashes.design;
  const probeSchema = designPin && !/^[a-f0-9]{64}$/.test(designPin) ? designPin : "brain/Design";
  try {
    if (!nodeClient.queryByKey) {
      throw new BrainError({ code: "keyed_read_required", message: "The doctor probe needs a keyed read." });
    }
    await nodeClient.queryByKey({ schemaHash: probeSchema, fields: ["slug"], keyHash: "__brain_doctor__" });
    nodeReachable = true;
    provisioned = true;
    checks.push({
      name: "node-reachable",
      ok: true,
      detail: nodeReachabilityTransportDetail(cfg.nodeUrl, nodeSocketPath),
    });
    checks.push({
      name: "node-api-version",
      ok: true,
      tag: "SKIP",
      detail: "Brain does not call GET /api/version.",
    });
    checks.push({
      name: "node-provisioned",
      ok: true,
      detail: "The app id authorizes Brain. Identity is not probed.",
    });
    verbose?.(`node-reachable: ok`);
  } catch (err) {
    const nameRequired = err instanceof BrainError && err.code === "schema_name_required" ? err.message : null;
    checks.push({
      name: "node-reachable",
      ok: false,
      detail: nameRequired ?? doctorReachabilityDetail(err, "node", cfg.nodeUrl),
      fix: nameRequired !== null ? "run `brain init`" : isNodeReachableButErroring(err) ? nodeHttpErrorHint(err) : nodeDownHint(),
    });
    checks.push({
      name: "node-api-version",
      ok: true,
      tag: "SKIP",
      detail: "Brain does not call GET /api/version.",
    });
    checks.push(skippedByNodeUnreachable("node-provisioned"));
    verbose?.(`node-reachable: FAIL`);
  }

  // Local pin check. A 64-hex pin cannot be used on the app API.
  if (cfgIssues.length === 0) {
    const wrong = DOCTOR_RECORD_SCHEMAS.filter((entry) => {
      const expected = `brain/${entry.schema.schema.name}`;
      return cfg.schemaHashes[entry.key] !== expected;
    }).map((entry) => entry.schema.schema.descriptive_name);
    if (wrong.length === 0) {
      schemasLoadedOk = true;
      checks.push({
        name: "schemas-loaded",
        ok: true,
        detail: `${DOCTOR_RECORD_SCHEMAS.length}/${DOCTOR_RECORD_SCHEMAS.length} record schemas pinned to brain/<Name>`,
      });
    } else {
      checks.push({
        name: "schemas-loaded",
        ok: false,
        detail: `re-run brain init to replace pins: ${wrong.join(", ")}`,
        fix: "re-run `brain init`",
      });
    }
  } else {
    checks.push(skippedByPrereqs("schemas-loaded", "config is invalid"));
  }

  // Embedding-runtime probe — issue one trivial Search app query so the node
  // is forced to load its ONNX model. Surfaces the
  // `embedding_model_unavailable` failure as a structured FAIL, so
  // `brain doctor` is the one source of truth for "is search end-to-end usable?"
  // Cheap when it passes (one app-search request); the heavy freshness probe stays
  // gated behind --freshness.
  if (provisioned && schemasLoadedOk) {
    const embed = await runEmbeddingProbe(nodeClient, verbose, {
      queryPlane: opts.searchPlane,
    });
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
  //   (b) does the node's app registry know about brain (does
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

  // Graph-edge lint — the typed edge substrate is dual-written into an
  // out-plane and an in-plane, and nothing before this check ever compared
  // them. A row present on one plane only is invisible from one direction, so
  // `graph neighbors` and `graph path` silently disagree depending on which
  // way they walked. Bounded and keyed: it seeds from a small slice of the
  // type-list index and issues point/range reads only — see graph-lint.ts for
  // why this samples rather than certifies.
  if (provisioned && schemasLoadedOk) {
    checks.push(await runGraphEdgeLintProbe(nodeClient, cfg, verbose));
  } else if (!nodeReachable) {
    checks.push(skippedByNodeUnreachable("graph-edge-lint"));
  } else {
    checks.push(skippedByPrereqs("graph-edge-lint"));
  }

  // Runtime probe — compare the running Bun against brain's documented
  // minimum (README Prerequisites: "Bun ≥ <MIN_BUN_VERSION>"). The README tells
  // every new dev to run `brain doctor`, but until this check nothing
  // enforced the version, so a dev on an older Bun hit an opaque low-level
  // failure with no pointer to the real cause. Cheap + offline (string compare
  // only; never touches the node) — fits the same slot as mcp-entrypoint. FAIL
  // (not WARN) when too old, with an actionable upgrade hint.
  const runtimeCheck = runRuntimeProbe(opts, verbose);
  checks.push(runtimeCheck);

  // CLI-entrypoint probe — catches the common "global install left a dangling
  // ~/.bun/bin/brain symlink" state before agent/routine shells fail with
  // `command not found`. WARN, never FAIL: source-checkout users can still run
  // `bun run src/cli.ts`, and the fix is local relinking rather than a node or
  // schema problem.
  const cliEntrypointCheck = runCliEntrypointProbe(opts, verbose);
  checks.push(cliEntrypointCheck);

  // MCP-entrypoint probe — the headline agent-integration path. The README
  // front-loads `claude mcp add brain brain-mcp`, which only works if the
  // `brain-mcp` bin (declared in package.json `bin` alongside `brain`) is
  // on PATH. On a real machine a stale hand-installed `brain` shim that
  // predates the `brain-mcp` bin leaves `brain` resolvable but `brain-mcp`
  // missing — and pre-this-check doctor was all-PASS, so a broken agent
  // integration failed silently. Cheap + offline (PATH resolution only; we
  // do NOT spawn the MCP server). WARN, never FAIL: MCP is optional for
  // CLI-only users and source-checkout users register the path-based form,
  // so absence must not flip doctor's exit code.
  const mcpCheck = runMcpEntrypointProbe(opts, verbose);
  checks.push(mcpCheck);

  // --mcp boot probe — actually BOOT the resolved `brain-mcp` entrypoint and
  // assert the live agent-integration surface, not just that the bin is on
  // PATH. `mcp-entrypoint` above is PATH-resolution only (cheap + offline), so
  // a resolved-but-broken server (crashes on boot, hangs, wrong/zero tools,
  // version skew) yields a GREEN mcp-entrypoint and the new dev only discovers
  // the dead server when their agent silently can't reach the brain. This
  // opt-in probe spawns the server, drives a JSON-RPC initialize + tools/list
  // handshake over stdio under a bounded deadline, and FAILs (not WARNs) on a
  // boot/handshake/tool-set mismatch — mirroring the --write / --freshness
  // opt-in-deep-probe pattern so plain `brain doctor` stays spawn-free. Kept
  // SKIPPED (not FAIL) when mcp-entrypoint itself didn't resolve, so the
  // verdict stays coherent: there is nothing to boot yet.
  if (opts.mcp) {
    const resolved = (opts.whichBin ?? ((name: string) => Bun.which(name)))(
      "brain-mcp",
    );
    if (resolved) {
      const bootProbe = await runMcpBootProbe(resolved, opts, verbose);
      checks.push(bootProbe);
      verbose?.(`mcp-boot: ${tagOf(bootProbe)} — ${bootProbe.detail ?? ""}`);
    } else {
      checks.push(skippedByMcpUnresolved());
    }
  }

  // Disclosure probe — always WARN, no detection. Brain reads and writes
  // the local node. This line says that, and it does not change the verdict.
  checks.push({
    name: "single-machine-slice",
    ok: true,
    tag: "WARN",
    detail:
      "you're on this daemon; record set is local — multi-machine reads " +
      "require brain to drive fold_db's sync transport (deployed but not " +
      "yet wired up from brain; tracked as G16)",
  });

  // --write probe — real put → get → soft-delete round-trip under a
  // reserved slug. The write-ready probe above is a static check; this is
  // the active proof that capability headers attach + the consent path
  // resolves + the node accepts the mutation. OFF by default so plain
  // `brain doctor` never mutates.
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

// The node serves every route (data, owner, and control) on its one owner
// socket, `<home>/data/folddb.sock`. Name that socket when it exists.
function nodeReachabilityTransportDetail(nodeUrl: string, socketPath: string): string {
  return existsSync(socketPath) ? `unix:${socketPath}` : nodeUrl;
}

function doctorNodeConfigDetail(nodeUrl: string, socketPath: string): string {
  return existsSync(socketPath) ? `node=unix:${socketPath}` : `nodeUrl=${nodeUrl}`;
}

// client.ts appends "— run `brain doctor` for a full diagnosis" to every
// BrainError message so non-doctor commands point users here. Doctor strips
// that circular tip from its own output.
function doctorReachabilityDetail(err: unknown, which: string, baseUrl: string): string {
  if (err instanceof BrainError && err.code === "service_unreachable") {
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
