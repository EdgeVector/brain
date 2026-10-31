#!/usr/bin/env python3
"""CI-only normal-app latency: the earlier app and this app, each on its own fresh home."""
import argparse
import json
import math
import os
from pathlib import Path
import platform
import re
import statistics
import subprocess
import sys
import time

OPERATIONS = ("get", "first_page", "all_summaries", "all_records", "snapshot_counts",
              "bulk_selection", "migration_read", "search_fallback")


def save(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def memory(pid):
    try:
        for line in Path(f"/proc/{pid}/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) * 1024
    except FileNotFoundError:
        pass
    return 0


def app(args, node, destination, label, phase, samples=0, tag=None):
    settings = {"label": label, "baseline": str(args.baseline), "candidate": str(args.candidate),
                "socket": str(node.socket) if node else None, "config": str(destination / "config.json"),
                "records": args.records, "samples": samples, "bodyBytes": args.body_bytes,
                "seedProof": str(destination / "seed.json"),
                "partialProof": str(destination / "partial.json"),
                "lastdbSource": str(args.lastdb_source)}
    name = tag or phase
    settings_path, output = destination / f"{name}-settings.json", destination / f"{name}.json"
    save(settings_path, settings)
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith(("LASTDB", "FOLD", "BRAIN", "LASTSEEK", "SENTRY", "OTEL"))
                   and key not in ("GH_TOKEN", "GITHUB_TOKEN", "ANTHROPIC_API_KEY")}
    environment.update(LASTDB_ISOLATED_COPY="1", LASTDB_SUPPRESS_RECOVERY_PHRASE="1",
                       BRAIN_CONFIG=str(destination / "config.json"),
                       BRAIN_FOLDDB_SOCKET=str(node.socket) if node else "",
                       LASTSEEK_BIN=str(destination / "absent-lastseek"),
                       LAST_STACK_HEARTBEATS_FILE=str(destination / "absent-heartbeats"))
    peak_node, peak_client = 0, 0
    with (destination / f"{name}.log").open("w") as log:
        process = subprocess.Popen(["bun", str(args.driver), phase, str(settings_path), str(output)],
                                   env=environment, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 3600
            while process.poll() is None:
                if node and (not node.process or node.process.poll() is not None):
                    raise RuntimeError("The owned daemon exited during an app operation")
                if time.monotonic() >= deadline:
                    raise RuntimeError(f"{label}/{phase} exceeded its operation deadline")
                peak_client = max(peak_client, memory(process.pid))
                if node:
                    peak_node = max(peak_node, node.memory_bytes() or 0)
                time.sleep(.05)
            if process.returncode:
                raise RuntimeError(f"{label}/{phase} failed; inspect its CI log and result")
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
    result = json.loads(output.read_text())
    result.update(node_peak_sampled_bytes=peak_node, client_peak_sampled_bytes=peak_client)
    save(output, result)
    return result


def cloud_off(node, destination, phase):
    status = node.call("/api/sync/byte-backup-v2", {"action": "status"})[0]
    if any(status.get(name) is not False for name in ("enabled", "automatic_backup_enabled", "running")):
        raise RuntimeError("The generated node did not confirm that cloud sync stays OFF")
    if status.get("manual_connection") is not None:
        raise RuntimeError("The generated node has a cloud connection")
    save(destination / f"cloud-off-{phase}.json", status)


def run_case(args, Node, finish_setup, label, repeat):
    destination = args.output / f"{repeat:02d}-{label}"
    destination.mkdir()
    binary, revision = ((args.binary, args.revision) if label == "after"
                        else (args.baseline_binary, args.baseline_revision))
    node = Node(binary, revision, destination, full_socket_name="folddb-full.sock",
                temporary_directory=Path(os.environ["RUNNER_TEMP"]).resolve(), environment={
                    "LASTDB_SELF_METRICS_TO_DB": "false",
                    "LASTDB_BYTE_BACKUP_V2_ENABLED": "false", "LASTDB_TTL_SWEEP": "0"})
    result = {"label": label, "repeat": repeat, "results": []}
    try:
        node.start()
        cloud_off(node, destination, "start")
        app(args, node, destination, label, "setup")
        if args.mode == "read":
            seeded = app(args, node, destination, label, "seed")
            result.update(input_sha256=seeded["input_sha256"], body_bytes=seeded["body_bytes"])
        cloud_off(node, destination, "setup")
        finish_setup(node, destination)
        node.stop()
        node.start()
        cloud_off(node, destination, "reopen")
        if args.mode == "read":
            for operation in OPERATIONS:
                node.stop()
                node.start()
                for state, count in (("restart", 1), ("warm", args.samples)):
                    measured = app(args, node, destination, label, operation, count, f"{operation}-{state}")
                    if measured["input_sha256"] != result["input_sha256"] or measured["body_bytes"] != result["body_bytes"]:
                        raise RuntimeError("The app read corpus changed")
                    if len(measured["samples"]) != count or any(not sample.get("verified") for sample in measured["samples"]):
                        raise RuntimeError("The app read lacks complete valid samples")
                    result["results"].append({"operation": operation, "state": state, **measured})
                print(f"{destination.name}: {operation} complete", flush=True)
        else:
            for phase in ("create", "update", "delete", "verify", "partial", "reopen_partial"):
                if phase in ("verify", "reopen_partial"):
                    if node.call("/api/db/flush", {})[0].get("durable") is not True:
                        raise RuntimeError("The operational checkpoint lacks a durable flush")
                    node.stop()
                    node.start()
                measured = app(args, node, destination, label, phase)
                if measured.get("failure") or any(not sample.get("verified") for sample in measured["samples"]):
                    raise RuntimeError("An operational mutation failed")
                result["results"].append({"operation": phase, "state": "operations", **measured})
                result.update(input_sha256=measured["input_sha256"], body_bytes=measured["body_bytes"])
                print(f"{destination.name}: {phase} complete", flush=True)
        cloud_off(node, destination, "final")
        result["cloud_sync_off"] = True
        result["disk"] = node.disk_breakdown()
        save(destination / "metrics.json", result)
        return result
    finally:
        node.close()


def summarize(args, runs):
    def percentile(samples, fraction):
        ordered = sorted(sample["elapsed_ms"] for sample in samples)
        return ordered[math.ceil(len(ordered) * fraction) - 1]

    rows = []
    operations = OPERATIONS if args.mode == "read" else ("create", "update", "delete", "partial")
    states = ("restart", "warm") if args.mode == "read" else ("operations",)
    lines = [f"## Brain {args.mode} comparison: {args.records:,} records", "",
             f"Before app: `{args.app_baseline_revision}`. After app: `{args.app_revision}`.",
             f"Compatible daemon: `{args.baseline_revision}`. Native daemon: `{args.revision}`.",
             "Each app creates its own generated home on its own daemon. No home is converted in place.",
             "An existing home moves to this app only by the home copy. This comparison does not measure that copy.",
             "Canonical definitions remain shared. Record values belong to each schema.",
             f"Paired repeats: {args.repeats}. Each pair uses equal generated records and full body bytes.",
             "Restart uses the same generated files and a fresh daemon. The OS file cache is not cleared.",
             "Warm calls follow the restart call. Process startup and module import are outside operation latency.",
             "Each creation, update, delete, and partial sample contains one record, as `brain put` writes it.",
             "Latency changes are advisory. Missing operations, failed values, incomplete samples, or failed uploads stop the gate.", "",
             "| Operation | State | Before p50 ms | After p50 ms | Before p95 ms | After p95 ms | Calls before / after |",
             "|---|---|---:|---:|---:|---:|---:|"]
    for operation in operations:
        for state in states:
            cells = []
            for label in ("before", "after"):
                records = [record for run in runs if run["label"] == label
                           for record in run["results"] if record["operation"] == operation and record["state"] == state]
                if len(records) != args.repeats:
                    raise RuntimeError("The comparison lacks a complete paired cell")
                samples = [sample for record in records for sample in record["samples"]]
                if not samples or any(not sample.get("verified") for sample in samples):
                    raise RuntimeError("The comparison contains missing or failed samples")
                expected = (args.repeats * (1 if state == "restart" else args.samples)) if args.mode == "read" else args.repeats * {
                    "create": args.records, "update": args.records // 4, "delete": 8, "partial": 64}[operation]
                if len(samples) != expected:
                    raise RuntimeError("The operation count differs from the declared workload")
                cells.append({"p50_ms": percentile(samples, .5), "p95_ms": percentile(samples, .95),
                              "p99_ms": percentile(samples, .99), "samples": len(samples),
                              "requests_per_operation": statistics.median(sample["requests"] for sample in samples),
                              "response_bytes": statistics.median(sample["response_bytes"] for sample in samples),
                              "node_peak_sampled_bytes": max(record["node_peak_sampled_bytes"] for record in records),
                              "client_peak_sampled_bytes": max(record["client_peak_sampled_bytes"] for record in records)})
            before, after = cells
            rows.append({"operation": operation, "state": state, "before": before, "after": after})
            lines.append(f"| {operation} | {state} | {before['p50_ms']:.3f} | {after['p50_ms']:.3f} | "
                         f"{before['p95_ms']:.3f} | {after['p95_ms']:.3f} | {before['samples']} / {after['samples']} |")
    if len({run["input_sha256"] for run in runs}) != 1 or len({run["body_bytes"] for run in runs}) != 1:
        raise RuntimeError("The paired generated corpora differ")
    lines += ["", "Each read verifies exact generated membership and selected field values, including full bodies where requested.",
              "Bulk selection previews deletion without a write. Migration read measures the real app source read.",
              "The keyword fallback uses the real app with LastSeek absent. It does not claim LastSeek latency.",
              "Operational runs verify body atoms across title edits, deletion membership, exact counts, and restart recovery.",
              "The after arm uses normal app initialization on the native daemon." if args.mode == "operations" else
              "Every read cell includes one restart call and five warm calls per paired repeat.",
              "This measures the app and daemon change. A same-layout LastDB benchmark isolates engine cost separately.",
              "Raw profiles, response sizes, memory samples, disk sizes, and source identities remain in CI artifacts.",
              "No primary data, primary copy, local benchmark, or test suite participates."]
    save(args.output / "comparison.json", {"records": args.records, "app_before": args.app_baseline_revision,
         "app_after": args.app_revision, "daemon_before": args.baseline_revision, "daemon_after": args.revision,
         "rows": rows, "runs": runs})
    summary = "\n".join(lines) + "\n"
    (args.output / "summary.md").write_text(summary)
    with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as output:
        output.write(summary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("catalog", "read", "operations"), required=True)
    for name in ("binary", "baseline-binary", "lastdb-source", "baseline", "candidate", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    for name in ("revision", "baseline-revision", "app-revision", "app-baseline-revision"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--records", type=int, choices=(128, 1024, 1000), required=True)
    parser.add_argument("--body-bytes", type=int, default=0)
    parser.add_argument("--samples", type=int, default=5)
    parser.add_argument("--repeats", type=int, default=3)
    args = parser.parse_args()
    if os.environ.get("GITHUB_ACTIONS") != "true" or platform.system() != "Linux":
        parser.error("Measurements run only in Linux GitHub Actions")
    if not 1 <= args.samples <= 20 or not 1 <= args.repeats <= 5:
        parser.error("Use 1..20 samples and 1..5 repeats")
    if args.mode == "read" and (args.records != 1000 or args.samples != 5 or args.repeats != 3 or args.body_bytes != 0):
        parser.error("Reads require 1000 records, original full bodies, five warm calls, and three repeats")
    if args.mode == "operations" and (args.body_bytes != 4096 or (args.records, args.repeats) not in ((128, 1), (1024, 3))):
        parser.error("Operations require 128 records once or 1024 records three times, with 4096-byte bodies")
    for value in (args.revision, args.baseline_revision, args.app_revision, args.app_baseline_revision):
        if not re.fullmatch(r"[0-9a-f]{40}", value):
            parser.error("Every source identity must be a full revision")
    for root, revision in ((args.baseline, args.app_baseline_revision), (args.candidate, args.app_revision),
                           (args.lastdb_source, args.revision)):
        observed = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
        if observed != revision:
            parser.error("A source checkout differs from its selected revision")
    args.baseline, args.candidate = args.baseline.resolve(), args.candidate.resolve()
    args.driver = args.candidate / "scripts/brain_latency.mjs"
    args.output.mkdir(parents=True, exist_ok=False)
    if args.mode == "catalog":
        app(args, None, args.output, "after", "catalog")
        return
    sys.path.insert(0, str(args.lastdb_source.resolve() / "scripts/benchmarks"))
    from node import Node
    from app_multi_key_compare import finish_setup

    runs, failures = [], {}
    for repeat in range(1, args.repeats + 1):
        for label in (("before", "after") if repeat % 2 else ("after", "before")):
            # A failed arm stops its own later repeats. The other arm still runs, so CI shows
            # its result too. Any failure still fails this job after the loop.
            if label in failures:
                continue
            try:
                runs.append(run_case(args, Node, finish_setup, label, repeat))
            except Exception as error:
                failures[label] = f"{label} repeat {repeat}: {error}"
                print(f"FAILED {failures[label]}", flush=True)
            save(args.output / "checkpoints.json", {"runs": runs, "failures": failures})
    if failures:
        with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as output:
            output.write(f"## Brain {args.mode} comparison: {args.records:,} records\n\n"
                         + "".join(f"- Failed: {failure}\n" for failure in failures.values())
                         + "".join(f"- Completed: {run['label']} repeat {run['repeat']}\n" for run in runs))
        raise RuntimeError("; ".join(failures.values()))
    summarize(args, runs)


if __name__ == "__main__":
    main()
