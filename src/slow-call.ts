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
//   subprocess— time inside a helper process this CLI spawned and blocked on
//               (today: `lastseek query`). CARVED OUT of the segment it fell
//               in, not added alongside it, so the four segments still sum to
//               the total. Before this existed a 30 s `lastseek` reported as
//               `pre-send 30.7s` and read as brain's own boot — the CLI held
//               the fact and named the wrong owner
//               (`papercut-brain-ask-pre-send-35s-exceeds-agent-45s-bash-timeout-routines-idle-to-50-min-timeout-20260903`,
//               where the filer had to guess "embedding of the question, or
//               process start").
//
// The report is one stderr line, printed only when the total crosses
// `FBRAIN_SLOW_CALL_THRESHOLD_MS` (default 10 s; `0` disables) or always
// under `FBRAIN_PHASE_TIMING=1`. Threshold crossings are the papercut's
// stall shape, so the breakdown self-reports exactly when someone needs it,
// without anyone re-running a vanished stall under a debug flag.

const DEFAULT_THRESHOLD_MS = 10_000;

/** One blocking helper-process call, on the same clock as the fetches. */
export type SubprocessSpan = {
  startMs: number;
  endMs: number;
  label: string;
};

export type FetchTotals = {
  firstStartMs: number | null;
  lastEndMs: number | null;
  insideMs: number;
  count: number;
  slowestMs: number;
  slowestLabel: string;
  /** Spans are kept whole because attribution needs WHERE each one fell, not
   * just how long they were: a spawn before the first fetch is pre-send time,
   * one after it is between-requests time, and the report has to carve it out
   * of the right segment. */
  subprocess: SubprocessSpan[];
};

const totals: FetchTotals = {
  firstStartMs: null,
  lastEndMs: null,
  insideMs: 0,
  count: 0,
  slowestMs: 0,
  slowestLabel: "",
  subprocess: [],
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

/** Begin one blocking helper-process call; pair the return with `endSubprocess`. */
export function beginSubprocess(): number {
  return nowMs();
}

/** Finish one helper-process call (a timed-out spawn still spent the time). */
export function endSubprocess(startMs: number, label: string): void {
  totals.subprocess.push({ startMs, endMs: nowMs(), label });
}

/** Total helper-process wall clock so far, in ms. Callers use it to enforce a
 * cumulative budget across one CLI invocation. */
export function subprocessMsSoFar(t: FetchTotals = totals): number {
  let sum = 0;
  for (const s of t.subprocess) sum += Math.max(0, s.endMs - s.startMs);
  return sum;
}

/** Drop the accumulated spans. The helper budget is process-global because a
 * CLI invocation IS the process; tests that exercise the budget need to start
 * from zero, and there is no other way to get there in-process. */
export function resetSubprocessTotals(): void {
  totals.subprocess.length = 0;
}

/** Milliseconds of `spans` that fall inside the half-open window [from, to). */
function overlapMs(spans: SubprocessSpan[], from: number, to: number): number {
  if (!(to > from)) return 0;
  let sum = 0;
  for (const s of spans) {
    const lo = Math.max(s.startMs, from);
    const hi = Math.min(s.endMs, to);
    if (hi > lo) sum += hi - lo;
  }
  return sum;
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
  subprocessMs: number;
  subprocessCount: number;
  subprocessSlowestMs: number;
  subprocessSlowestLabel: string;
};

/** Pure segment math over the accumulated totals, at `totalMs` on the same clock. */
export function computeSegments(t: FetchTotals, totalMs: number): SlowCallSegments {
  const sub = t.subprocess ?? [];
  let subSlowestMs = 0;
  let subSlowestLabel = "";
  for (const s of sub) {
    const d = Math.max(0, s.endMs - s.startMs);
    if (d > subSlowestMs) {
      subSlowestMs = d;
      subSlowestLabel = s.label;
    }
  }
  const subTotals = {
    subprocessMs: overlapMs(sub, 0, totalMs),
    subprocessCount: sub.length,
    subprocessSlowestMs: subSlowestMs,
    subprocessSlowestLabel: subSlowestLabel,
  };

  if (t.firstStartMs === null || t.lastEndMs === null) {
    // No request ever went out, so the whole call is pre-send — minus whatever
    // of it a helper process held.
    return {
      totalMs,
      preSendMs: Math.max(0, totalMs - subTotals.subprocessMs),
      nodeMs: 0,
      betweenMs: 0,
      afterMs: 0,
      fetchCount: 0,
      slowestMs: 0,
      slowestLabel: "",
      ...subTotals,
    };
  }
  const spanMs = Math.max(0, t.lastEndMs - t.firstStartMs);
  // Carve each spawn out of the segment it actually fell in. A spawn that
  // straddles the first fetch is split across both, which is why this is an
  // overlap and not a subtraction of one total.
  const subBefore = overlapMs(sub, 0, t.firstStartMs);
  const subDuring = overlapMs(sub, t.firstStartMs, t.lastEndMs);
  const subAfter = overlapMs(sub, t.lastEndMs, totalMs);
  return {
    totalMs,
    preSendMs: Math.max(0, t.firstStartMs - subBefore),
    nodeMs: t.insideMs,
    // `subDuring` can only eat the idle part of the span: time inside a fetch
    // is the node's, and a spawn cannot overlap a blocking fetch on one thread.
    betweenMs: Math.max(0, spanMs - t.insideMs - subDuring),
    afterMs: Math.max(0, totalMs - t.lastEndMs - subAfter),
    fetchCount: t.count,
    slowestMs: t.slowestMs,
    slowestLabel: t.slowestLabel,
    ...subTotals,
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
  // Printed only when there WAS one, so the common line keeps its old shape
  // and a reader who sees `subprocess` knows a helper actually ran.
  const subprocess =
    s.subprocessCount > 0
      ? `, subprocess ${fmtS(s.subprocessMs)} across ${s.subprocessCount} spawn(s)` +
        (s.subprocessSlowestLabel !== ""
          ? `, slowest ${fmtS(s.subprocessSlowestMs)} (${s.subprocessSlowestLabel})`
          : "")
      : "";
  return (
    `brain: slow-call phases (${fmtS(s.totalMs)} total): ` +
    `pre-send ${fmtS(s.preSendMs)}, ` +
    `node ${fmtS(s.nodeMs)} across ${s.fetchCount} request(s)${slowest}, ` +
    `between-requests ${fmtS(s.betweenMs)}, ` +
    `after-last-response ${fmtS(s.afterMs)}${subprocess}`
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
