#!/usr/bin/env python3
"""CI-only before/after read measurements on fresh generated LastDB homes."""
import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import time
from statistics import median

from brain_v2_spike import call, memory, save, start_node, stop_node, stats

OPERATIONS = ("get", "first_page", "all_summaries", "all_records", "snapshot_counts", "bulk_selection", "migration_read", "search_fallback")


def measure(args, layout, version, source, repeat):
    destination = args.output / f"{repeat:02d}-{version}-{layout}"
    destination.mkdir()
    root = Path(tempfile.mkdtemp(prefix="brr-", dir="/tmp")).resolve()
    owner = {"uid": os.getuid(), "inode": root.stat().st_ino, "pid": os.getpid()}
    save(root / "owner.json", owner)
    home, sock = root / "home", root / "q.sock"
    home.mkdir(mode=0o700)
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith(("LASTDB", "FOLD", "FBRAIN", "BRAIN", "LASTSEEK", "SENTRY", "OTEL"))
                   and key not in ("GH_TOKEN", "GITHUB_TOKEN", "ANTHROPIC_API_KEY")}
    environment.update(LASTDB_ISOLATED_COPY="1", LASTDB_SUPPRESS_RECOVERY_PHRASE="1",
                       LASTDB_HOME=str(home), FOLDDB_HOME=str(home), FBRAIN_FOLDDB_SOCKET=str(sock),
                       FBRAIN_APP_IDENTITY_ENFORCE="off", BRAIN_CONFIG=str(root / "config.json"),
                       BRAIN_READ_SOURCE=str(source), BRAIN_READ_VERSION=version, LAST_STACK_HEARTBEATS_FILE=str(root / "absent-heartbeats"),
                       LASTSEEK_BIN=str(root / "absent-lastseek"), RUST_MIN_STACK="16777216")
    log = (destination / "node.log").open("w")
    daemon, client = None, None
    receipts = []
    try:
        daemon, node_version = start_node(args, environment, home, sock, root, log)
        save(destination / "version.json", node_version)

        def workload(phase, count, label):
            nonlocal client
            save(root / "settings.json", {"socket": str(sock), "records": args.records, "samples": count})
            path = destination / f"{label}.json"
            with (destination / f"{label}.log").open("w") as output:
                started = time.monotonic()
                client = subprocess.Popen(["bun", "src/v2/read-workload.ts", layout, phase,
                                           str(root / "settings.json"), str(path)], env=environment,
                                          stdin=subprocess.DEVNULL, stdout=output, stderr=output)
                peak_node, peak_client = 0, 0
                while client.poll() is None:
                    if daemon.poll() is not None or time.monotonic() - started > 1200:
                        raise RuntimeError(f"{label}: daemon exit or workload deadline")
                    peak_node = max(peak_node, memory(daemon.pid).get("VmRSS", 0))
                    peak_client = max(peak_client, memory(client.pid).get("VmRSS", 0))
                    time.sleep(.05)
            if client.returncode:
                raise RuntimeError(f"{destination.name}/{label} failed; inspect its log")
            result = json.loads(path.read_text())
            result.update(node_peak_sampled_bytes=peak_node, client_peak_sampled_bytes=peak_client,
                          process_ms=(time.monotonic() - started) * 1000)
            save(path, result)
            return result

        def restart():
            nonlocal daemon
            receipt = stop_node(daemon, home)
            receipts.append(receipt)
            save(destination / "shutdowns.json", receipts)
            if receipt["exit_code"] != 0 or not receipt["receipt"] or receipt["receipt"].get("flush_ok") is not True:
                raise RuntimeError("Missing successful shutdown flush")
            daemon, _ = start_node(args, environment, home, sock, root, log)

        seeded = workload("setup", 0, "setup")
        if call(sock, "/api/db/flush", {}).get("durable") is not True:
            raise RuntimeError("Setup flush was not durable")
        results = []
        for operation in OPERATIONS:
            if layout == "v2" and operation == "search_fallback":
                continue
            restart()
            cold = workload(operation, 1, f"{operation}-restart")
            warm = workload(operation, args.samples, f"{operation}-warm")
            for state, result in (("restart", cold), ("warm", warm)):
                if result["input_sha256"] != seeded["input_sha256"]:
                    raise RuntimeError("Read corpus changed")
                results.append({"operation": operation, "state": state, **result})
            print(f"{destination.name}: {operation} complete", flush=True)
        return {"layout": layout, "version": version, "repeat": repeat, "results": results,
                "input_sha256": seeded["input_sha256"]}
    finally:
        if client and client.poll() is None:
            client.terminate()
            try:
                client.wait(timeout=10)
            except subprocess.TimeoutExpired:
                client.kill()
                client.wait(timeout=5)
        if daemon:
            receipts.append(stop_node(daemon, home))
            save(destination / "shutdowns.json", receipts)
        log.close()
        if root.is_symlink() or root.stat().st_uid != owner["uid"] or root.stat().st_ino != owner["inode"] or json.loads((root / "owner.json").read_text()) != owner:
            raise RuntimeError("Owned scratch identity changed; refuse cleanup")
        shutil.rmtree(root)


def report(args, runs):
    lines = [f"## Brain read latency: {args.records:,} records", "",
             f"Baseline source: `{args.baseline_revision}`. Candidate source: `{os.environ['GITHUB_SHA']}`.",
             "Restart means a fresh daemon on the same generated disk files; the OS file cache is not cleared.",
             "Warm calls follow the restart call. Module import and process startup are outside operation time.",
             f"Each cell pools {args.repeats} paired runs; warm cells contain {args.repeats * args.samples} calls.", "",
             "| Layout | Operation | State | Before p50 ms | After p50 ms | Before p95 ms | After p95 ms | Before calls | After calls |",
             "|---|---|---|---:|---:|---:|---:|---:|---:|"]
    comparisons = []
    for layout in ("current", "v2"):
        for operation in OPERATIONS:
            if layout == "v2" and operation == "search_fallback":
                continue
            for state in ("restart", "warm"):
                pair = []
                for version in ("before", "after"):
                    records = [result for run in runs if run["layout"] == layout and run["version"] == version
                               for result in run["results"] if result["operation"] == operation and result["state"] == state]
                    samples = [sample for record in records for sample in record["samples"]]
                    successful = [sample for sample in samples if sample.get("verified")]
                    summary = stats(successful) if successful else {"p50_ms": None, "p95_ms": None, "p99_ms": None, "operations": 0}
                    summary.update(failed=len(samples) - len(successful), attempted=len(samples),
                                   failed_p50_ms=median(sample["elapsed_ms"] for sample in samples if not sample.get("verified")) if len(samples) != len(successful) else None,
                                   requests_per_operation=median(sample["requests"] for sample in samples))
                    summary.update(response_bytes=median(sample["response_bytes"] for sample in samples),
                                   client_peak_sampled_bytes=max(record["client_peak_sampled_bytes"] for record in records),
                                   node_peak_sampled_bytes=max(record["node_peak_sampled_bytes"] for record in records))
                    pair.append(summary)
                before, after = pair
                comparisons.append({"layout": layout, "operation": operation, "state": state, "before": before, "after": after})
                def cell(value, key):
                    return f"{value[key]:.2f}" if value[key] is not None else f"failed {value['failed']}/{value['attempted']}"
                lines.append(f"| {layout} | {operation} | {state} | {cell(before, 'p50_ms')} | {cell(after, 'p50_ms')} | "
                             f"{cell(before, 'p95_ms')} | {cell(after, 'p95_ms')} | {before['requests_per_operation']:.1f} | {after['requests_per_operation']:.1f} |")
    lines += ["", "Read results require exact generated membership and field values. Raw samples include response bytes and sampled memory sizes.",
              "Migration read measures the source read, without schema publication or migration writes. Bulk selection does not delete data.",
              "V2 snapshot counts use a complete summary traversal; V2 has no maintained count schema or snapshot command.",
              "Only the current Brain keyword fallback is measured. LastSeek is absent. V2 search is unsupported and is not compared.",
              "Low sample counts limit tail estimates. No primary, primary copy, local benchmark, or test suite is used."]
    save(args.output / "metrics.json", {"records": args.records, "baseline_revision": args.baseline_revision,
                                      "source": os.environ["GITHUB_SHA"], "lastdb_revision": args.lastdb_revision,
                                      "comparisons": comparisons, "runs": runs})
    with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as output:
        output.write("\n".join(lines) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lastdbd", type=Path, required=True)
    parser.add_argument("--lastdb-revision", required=True)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--baseline-revision", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--records", type=int, choices=(1000, 10000), required=True)
    parser.add_argument("--samples", type=int, default=5)
    parser.add_argument("--repeats", type=int, default=3)
    args = parser.parse_args()
    if os.environ.get("CI") != "true" or platform.system() != "Linux":
        parser.error("Measurements run only in Linux CI")
    if not 1 <= args.samples <= 20 or not 1 <= args.repeats <= 5:
        parser.error("Use 1..20 samples and 1..5 paired repeats")
    args.lastdbd, args.baseline = args.lastdbd.resolve(strict=True), args.baseline.resolve(strict=True)
    args.output.mkdir(parents=True, exist_ok=False)
    runs = []
    for repeat in range(1, args.repeats + 1):
        cases = [(version, layout) for version in ("before", "after") for layout in ("current", "v2")]
        if repeat % 2 == 0:
            cases.reverse()
        for version, layout in cases:
            source = args.baseline if version == "before" else Path.cwd()
            runs.append(measure(args, layout, version, source, repeat))
            save(args.output / "checkpoints.json", runs)
    if len({run["input_sha256"] for run in runs}) != 1:
        raise RuntimeError("Paired corpora differ")
    report(args, runs)


if __name__ == "__main__":
    main()
