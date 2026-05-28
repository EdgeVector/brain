// Integration-test harness — spawns a real fold_db_node against a unique
// tmpdir and points it at the dev cloud schema-service Lambda (us-west-2).
// The schema service is no longer spawned locally; it lives in the cloud,
// shared across all integration runs. Schemas register by canonical hash
// so identical schemas → identical hash → idempotent re-registration.
//
// All tests using this harness MUST run serially: even with separate
// --home directories per test, sharing the same Cargo target/ would be
// fine, but we explicitly serialize the spawn-up cost.
//
// `bun test` runs files sequentially by default; only intra-file
// concurrency exists, and our integration tests use a single global
// harness per file.

import { spawn, type Subprocess } from "bun";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  UNIQUE_SCHEMAS,
  type AddSchemaRequest,
  type RecordType,
} from "../src/schemas.ts";
import { newNodeClient, newSchemaServiceClient } from "../src/client.ts";
import { TEST_SCHEMA_SERVICE_URL } from "./util.ts";

export const FOLD_NODE_DIR =
  process.env.FOLD_NODE_DIR ?? "/Users/tomtang/code/edgevector/fold/fold_db_node";

export function isHarnessAvailable(): boolean {
  if (process.env.FBRAIN_SKIP_INTEGRATION === "1") return false;
  try {
    return statSync(join(FOLD_NODE_DIR, "run.sh")).isFile();
  } catch {
    return false;
  }
}

export type Harness = {
  nodeUrl: string;
  schemaServiceUrl: string;
  userHash: string;
  schemaHashes: Record<RecordType, string>;
  // Legacy mirrors — same values as schemaHashes.design / schemaHashes.task.
  designSchemaHash: string;
  taskSchemaHash: string;
  home: string;
  pid: number;
  teardown: () => Promise<void>;
};

const SLOT_DIR = join(homedir(), ".folddb-slots");

type SlotFile = {
  port: number;
  schema_port: number;
  vite_port: number;
  home: string;
  pid: number;
};

// Every node that's currently live, so the process-level teardown guard can
// reap it if the run is interrupted (Ctrl-C / SIGTERM) before its own
// teardown() runs. `port`/`pid` stay null until the slot file is read.
type LiveSlot = {
  child: Subprocess;
  home: string;
  port: number | null;
  pid: number | null;
};

const liveSlots = new Set<LiveSlot>();
let teardownGuardInstalled = false;

// Install once per process: when the test run is interrupted, SIGKILL every
// live run.sh process group and clean up its slot file + temp home. Without
// this, a `bun test` that's Ctrl-C'd or externally SIGTERM'd never runs the
// per-slot teardown and orphans every node it had spawned — made worse by
// `detached`, which puts run.sh in its own session so it no longer dies with
// the terminal's foreground group on Ctrl-C.
//
// SIGINT/SIGTERM are the load-bearing handlers here: empirically `bun test`
// fires those but does NOT fire process.on("exit"), so 'exit' is only a
// best-effort backstop for non-bun-test runners. (In-process throws are
// handled directly by startHarness's dispose(), not by this guard.) Each
// handler must be fully synchronous — SIGKILL is enough to stop the
// disposable nodes and free their ports.
function installTeardownGuard(): void {
  if (teardownGuardInstalled) return;
  teardownGuardInstalled = true;

  const reapAllSync = (): void => {
    for (const s of liveSlots) {
      try {
        // Negative pid → the whole process group (wrapper + folddb_server
        // grandchild + any vite/esbuild/tail children).
        process.kill(-s.child.pid, "SIGKILL");
      } catch {
        // group already gone
      }
      if (s.port !== null && s.pid !== null) cleanupSlotFile(s.port, s.pid);
      safeRm(s.home);
    }
    liveSlots.clear();
  };

  process.on("exit", reapAllSync);
  // Adding a SIGINT/SIGTERM listener suppresses the default terminate, so we
  // reap and then exit ourselves. process.exit re-fires the 'exit' handler,
  // but liveSlots is already cleared by then so it's a harmless no-op.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      reapAllSync();
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }
}

export async function startHarness(opts?: { name?: string }): Promise<Harness> {
  // Cloud schema service is shared and always-on, so we can fail fast if
  // it's unreachable instead of waiting the full node-cold-build window.
  const schemaServiceUrl = TEST_SCHEMA_SERVICE_URL;

  const home = mkdtempSync(join(tmpdir(), "fbrain-test-node-"));
  const child = spawn({
    // `--dev` routes the node at the dev cloud schema-service Lambda —
    // matches schemaServiceUrl above, and run.sh's --dev resolves the
    // same URL via environments.json. `--local-schema` is gone: we no
    // longer spawn a local schema_service binary.
    cmd: [
      "./run.sh",
      "--local",
      "--dev",
      "--empty-db",
      "--home",
      home,
    ],
    cwd: FOLD_NODE_DIR,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, FORCE_COLOR: "0" },
    // run.sh launches folddb_server (and vite) as nohup-backgrounded children
    // and only traps EXIT — never SIGTERM — so a SIGTERM to the wrapper kills
    // bash without firing its cleanup, orphaning the server. setsid() (via
    // detached) makes run.sh its own process-group leader so teardown can
    // signal the whole group at once and reap the grandchildren too.
    detached: true,
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  void readStream(child.stdout, (chunk) => {
    stdoutBuf += chunk;
  });
  void readStream(child.stderr, (chunk) => {
    stderrBuf += chunk;
  });

  const dumpLogs = () => {
    if (process.env.FBRAIN_HARNESS_VERBOSE === "1") {
      // eslint-disable-next-line no-console
      console.error("--- harness stdout ---\n" + stdoutBuf);
      // eslint-disable-next-line no-console
      console.error("--- harness stderr ---\n" + stderrBuf);
    }
  };

  // Register before any await so an interrupt during startup still reaps us.
  const liveSlot: LiveSlot = { child, home, port: null, pid: null };
  liveSlots.add(liveSlot);
  installTeardownGuard();

  // Single teardown path shared by every error branch and the returned
  // teardown(): group-kill the process tree, drop the slot file, delete the
  // temp home, and deregister from the interrupt guard.
  const dispose = async (): Promise<void> => {
    await killChild(child);
    if (liveSlot.port !== null && liveSlot.pid !== null) {
      cleanupSlotFile(liveSlot.port, liveSlot.pid);
    }
    safeRm(home);
    liveSlots.delete(liveSlot);
  };

  // Everything after the spawn runs under one try/catch so that ANY startup
  // failure — slot timeout, HTTP wait, bootstrap, schema registration (e.g. a
  // shared-cloud-schema-service 409), schema load — tears the node down via
  // dispose() instead of orphaning it. `bun test` does NOT fire
  // process.on("exit") handlers, so the teardown guard can't backstop an
  // in-process throw; dispose() must run here.
  try {
    const slot = await waitForSlotFile(home, 180_000);

    const nodeUrl = `http://127.0.0.1:${slot.port}`;
    liveSlot.port = slot.port;
    liveSlot.pid = slot.pid;

    await waitForHttp(`${nodeUrl}/api/system/auto-identity`, 180_000, (status) => status === 200 || status === 503);
    // Cloud Lambda is already deployed — short window is enough; a long
    // wait here would just mask a network/DNS issue we'd rather surface.
    await waitForHttp(`${schemaServiceUrl}/v1/schemas`, 5_000, (status) => status === 200);

    // Bootstrap. The node returns 503 from auto-identity until we do.
    const tmpNodeClient = newNodeClient({ baseUrl: nodeUrl, userHash: "bootstrap-tmp" });
    const identity = await tmpNodeClient.autoIdentity();
    let userHash: string;
    if (identity.provisioned) {
      userHash = identity.userHash;
    } else {
      const name = opts?.name ?? "fbrain-test";
      const result = await tmpNodeClient.bootstrap(name);
      userHash = result.userHash;
    }

    // Register every UNIQUE fbrain schema (3 total — Phase 6 types share
    // one) → capture canonical hashes and fan to all RecordType keys.
    const schemaClient = newSchemaServiceClient(schemaServiceUrl);
    const schemaHashes = {} as Record<RecordType, string>;
    for (const entry of UNIQUE_SCHEMAS) {
      const reg = await schemaClient.registerSchema(entry.schema);
      for (const type of entry.types) {
        schemaHashes[type] = reg.canonicalHash;
      }
    }

    // Load schemas into the node.
    const nodeClient = newNodeClient({ baseUrl: nodeUrl, userHash });
    const loadResult = await nodeClient.loadSchemas();
    if (loadResult.failed_schemas.length > 0) {
      throw new Error(
        `Schema load reported failed_schemas: ${loadResult.failed_schemas.join(", ")}`,
      );
    }

    const harness: Harness = {
      nodeUrl,
      schemaServiceUrl,
      userHash,
      schemaHashes,
      designSchemaHash: schemaHashes.design,
      taskSchemaHash: schemaHashes.task,
      home,
      pid: slot.pid,
      teardown: dispose,
    };

    return harness;
  } catch (err) {
    dumpLogs();
    await dispose();
    throw err;
  }
}

async function readStream(stream: ReadableStream<Uint8Array> | null, onChunk: (s: string) => void): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      onChunk(decoder.decode(value, { stream: true }));
    }
  } catch {
    // stream closed
  }
}

async function waitForSlotFile(home: string, timeoutMs: number): Promise<SlotFile> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(SLOT_DIR)) {
      let entries: string[] = [];
      try {
        entries = readdirSync(SLOT_DIR);
      } catch {
        // race with slot churn; retry
      }
      for (const name of entries) {
        if (!name.endsWith(".json")) continue;
        const path = join(SLOT_DIR, name);
        try {
          const parsed: SlotFile = JSON.parse(readFileSync(path, "utf8"));
          if (parsed.home === home && typeof parsed.port === "number" && typeof parsed.schema_port === "number") {
            return parsed;
          }
        } catch {
          // partial slot write; retry
        }
      }
    }
    await sleep(250);
  }
  throw new Error(`Timed out (${timeoutMs}ms) waiting for slot file matching home=${home}`);
}

async function waitForHttp(
  url: string,
  timeoutMs: number,
  ok: (status: number) => boolean,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: string | null = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (ok(res.status)) return;
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await sleep(500);
  }
  throw new Error(`Timed out (${timeoutMs}ms) waiting for ${url}: ${lastErr ?? "?"}`);
}

async function killChild(child: Subprocess): Promise<void> {
  const pid = child.pid;
  // run.sh is spawned detached, so it leads its own process group; the
  // folddb_server it nohup-backgrounds (plus any vite/esbuild/tail children)
  // share that pgid. Signalling the NEGATIVE pid hits the whole group —
  // child.kill() alone would signal only the bash wrapper, orphaning the
  // server (the leak this guards against).
  const killGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-pid, signal);
    } catch {
      // ESRCH (group already gone) or detached not honored — fall back to
      // signalling just the wrapper pid.
      try {
        child.kill(signal);
      } catch {
        // already exited
      }
    }
  };

  killGroup("SIGTERM");
  // run.sh has no SIGTERM trap, so the wrapper dies near-instantly; wait
  // (bounded) for Bun to reap it before we force-kill the group.
  const exitDeadline = Date.now() + 10_000;
  while (Date.now() < exitDeadline) {
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  // SIGKILL the whole group to reap the folddb_server grandchild and any
  // other children that survived (or ignored) the SIGTERM. No-op if the
  // group already drained.
  killGroup("SIGKILL");
}

function cleanupSlotFile(port: number, pid: number): void {
  const path = join(SLOT_DIR, `${port}.json`);
  try {
    if (!existsSync(path)) return;
    const parsed: SlotFile = JSON.parse(readFileSync(path, "utf8"));
    if (parsed.pid === pid) rmSync(path, { force: true });
  } catch {
    // best-effort
  }
}

function safeRm(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type ProbeSchemas = {
  design: AddSchemaRequest;
  task: AddSchemaRequest;
};
