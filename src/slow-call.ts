// Client-side phase accounting for slow CLI calls.
//
// The recurring incident this answers: a foreground `brain get`/`append`
// takes 90 s to 12 min while node telemetry records milliseconds of service
// time, and nothing says WHERE the other minutes went (brain
// `papercut-brain-cli-sequential-point-gets-stall-outside-node-service-time`).
// Every node/schema request already flows through one chokepoint
// (`boundedNodeFetch`), so this module splits a call's wall clock into the
// four segments that have distinct owners:
//
//   pre-send  — process start (bun boot + imports + config/session work)
//               until the first byte of the first request is attempted
//   node      — cumulative time inside deadline-bounded fetches (send →
//               body fully read), the only segment the node can be blamed for
//   between   — gaps between fetches (local compute, session repair, retries'
//               backoff) once the first fetch has started
//   after     — last response fully read until the process reports (output
//               rendering, stdout flush, exit path)
//
// The report is one stderr line, printed only when the total crosses
// `FBRAIN_SLOW_CALL_THRESHOLD_MS` (default 10 s; `0` disables) or always
// under `FBRAIN_PHASE_TIMING=1`. Threshold crossings are the papercut's
// stall shape, so the breakdown self-reports exactly when someone needs it,
// without anyone re-running a vanished stall under a debug flag.

const DEFAULT_THRESHOLD_MS = 10_000;

export type FetchTotals = {
  firstStartMs: number | null;
  lastEndMs: number | null;
  insideMs: number;
  count: number;
  slowestMs: number;
  slowestLabel: string;
};

const totals: FetchTotals = {
  firstStartMs: null,
  lastEndMs: null,
  insideMs: 0,
  count: 0,
  slowestMs: 0,
  slowestLabel: "",
};

/// Milliseconds since process start. `performance.now()`'s origin is the
/// process start in Bun, so bun boot + module-graph load land in `pre-send`
/// instead of vanishing — the 12-minute stall was never inside a fetch.
function nowMs(): number {
  return performance.now();
}

/** Begin one node/schema request; pair the return with `endFetch`. */
export function beginFetch(): number {
  const start = nowMs();
  if (totals.firstStartMs === null) totals.firstStartMs = start;
  return start;
}

/** Finish one request (success or failure — a timed-out fetch still spent the time). */
export function endFetch(startMs: number, label: string): void {
  const end = nowMs();
  const elapsed = Math.max(0, end - startMs);
  totals.lastEndMs = end;
  totals.insideMs += elapsed;
  totals.count += 1;
  if (elapsed > totals.slowestMs) {
    totals.slowestMs = elapsed;
    totals.slowestLabel = label;
  }
}

export type SlowCallSegments = {
  totalMs: number;
  preSendMs: number;
  nodeMs: number;
  betweenMs: number;
  afterMs: number;
  fetchCount: number;
  slowestMs: number;
  slowestLabel: string;
};

/** Pure segment math over the accumulated totals, at `totalMs` on the same clock. */
export function computeSegments(t: FetchTotals, totalMs: number): SlowCallSegments {
  if (t.firstStartMs === null || t.lastEndMs === null) {
    return {
      totalMs,
      preSendMs: totalMs,
      nodeMs: 0,
      betweenMs: 0,
      afterMs: 0,
      fetchCount: 0,
      slowestMs: 0,
      slowestLabel: "",
    };
  }
  const spanMs = Math.max(0, t.lastEndMs - t.firstStartMs);
  return {
    totalMs,
    preSendMs: Math.max(0, t.firstStartMs),
    nodeMs: t.insideMs,
    betweenMs: Math.max(0, spanMs - t.insideMs),
    afterMs: Math.max(0, totalMs - t.lastEndMs),
    fetchCount: t.count,
    slowestMs: t.slowestMs,
    slowestLabel: t.slowestLabel,
  };
}

function fmtS(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** The one report line. Segment naming mirrors the papercut's question. */
export function formatSlowCallReport(s: SlowCallSegments): string {
  const slowest =
    s.fetchCount > 0 && s.slowestLabel !== ""
      ? `, slowest ${fmtS(s.slowestMs)} (${s.slowestLabel})`
      : "";
  return (
    `brain: slow-call phases (${fmtS(s.totalMs)} total): ` +
    `pre-send ${fmtS(s.preSendMs)}, ` +
    `node ${fmtS(s.nodeMs)} across ${s.fetchCount} request(s)${slowest}, ` +
    `between-requests ${fmtS(s.betweenMs)}, ` +
    `after-last-response ${fmtS(s.afterMs)}`
  );
}

/** Threshold from env: `FBRAIN_PHASE_TIMING=1` → -1 (always print);
 * explicit non-negative `FBRAIN_SLOW_CALL_THRESHOLD_MS` wins; `0` disables. */
export function slowCallThresholdMs(env: Record<string, string | undefined>): number {
  if (env.FBRAIN_PHASE_TIMING === "1") return -1;
  const raw = env.FBRAIN_SLOW_CALL_THRESHOLD_MS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_THRESHOLD_MS;
}

/** Whether a call of `totalMs` should print, under `env`. */
export function shouldReport(totalMs: number, env: Record<string, string | undefined>): boolean {
  const threshold = slowCallThresholdMs(env);
  if (threshold < 0) return true; // FBRAIN_PHASE_TIMING=1: always
  if (threshold === 0) return false; // explicit opt-out
  return totalMs >= threshold;
}

/**
 * Print the breakdown to stderr when warranted. Called once from the CLI
 * exit paths; never throws (a timing report must not turn a green exit red).
 */
export function reportSlowCall(env: Record<string, string | undefined> = process.env): void {
  try {
    const total = nowMs();
    if (!shouldReport(total, env)) return;
    console.error(formatSlowCallReport(computeSegments(totals, total)));
  } catch {
    // Reporting is best-effort by design.
  }
}
