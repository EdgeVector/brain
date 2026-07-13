import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { stripDoctorTip, type Verbose } from "../../client.ts";
import { FBRAIN_MCP_TOOL_NAMES } from "../../mcp/server.ts";
import { getFbrainVersion } from "../../version.ts";
import type { CheckResult, DoctorOptions } from "../doctor.ts";

export function runCliEntrypointProbe(
  opts: DoctorOptions,
  verbose: Verbose | undefined,
): CheckResult {
  const which = opts.whichBin ?? ((name: string) => Bun.which(name));
  const resolved = which("fbrain");
  if (resolved) {
    verbose?.(`fbrain-entrypoint: resolved fbrain -> ${resolved}`);
    return {
      name: "fbrain-entrypoint",
      ok: true,
      detail: `fbrain -> ${resolved}`,
    };
  }

  const staleBin = describeCommonBrokenBin("fbrain", opts.homeDir);
  verbose?.(
    `fbrain-entrypoint: fbrain not on PATH — emitting WARN${staleBin ? ` (${staleBin})` : ""}`,
  );
  return {
    name: "fbrain-entrypoint",
    ok: true,
    tag: "WARN",
    detail:
      "CLI entrypoint 'fbrain' is not on PATH — shelling out to bare " +
      "`fbrain get`/`fbrain put`/`fbrain ask` will fail with command not found" +
      (staleBin ? `; ${staleBin}` : ""),
    fix:
      "Re-run `bun add -g github:EdgeVector/fbrain` (or `bun link` from a stable " +
      "fbrain checkout), then verify with `zsh -lic 'fbrain --version'`. If " +
      "`~/.bun/bin/fbrain` is a dangling symlink, remove it before relinking.",
  };
}

function describeCommonBrokenBin(
  name: string,
  homeDir = process.env.HOME,
): string | null {
  if (!homeDir) return null;
  const binPath = resolve(homeDir, ".bun", "bin", name);
  let stat;
  try {
    stat = lstatSync(binPath);
  } catch {
    return null;
  }

  if (stat.isSymbolicLink()) {
    const linkTarget = readlinkSync(binPath);
    const resolvedTarget = resolve(dirname(binPath), linkTarget);
    if (!existsSync(resolvedTarget)) {
      return `found dangling ~/.bun/bin/${name} -> ${linkTarget} (missing ${resolvedTarget})`;
    }
  }

  return null;
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
// reports EXACTLY the expected tool names (the set, so a missing/renamed tool
// fails). Bounded by a deadline + child kill (mirrors #270's
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
export function skippedByMcpUnresolved(): CheckResult {
  return {
    name: "mcp-boot",
    ok: true,
    tag: "WARN",
    detail:
      "skipped — `fbrain-mcp` did not resolve on PATH, so there is nothing to boot " +
      "(see the mcp-entrypoint check above for the re-link fix)",
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
