#!/usr/bin/env python3
"""Paired CI spike: exact LastDB programs, both Brain layouts, no added disk space."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
from statistics import median
from types import SimpleNamespace

import brain_read_latency as reads
import brain_v2_spike as storage


OPERATIONS = (*reads.OPERATIONS, "get_untyped", "get_many", "tag_page", "status_page")
PHASES = ("create", "update", "delete", "verify", "partial", "reopen_partial")


def case_args(args, version):
    before = version == "before"
    return SimpleNamespace(**vars(args), version=version, lastdbd=args.baseline_daemon if before else args.candidate_daemon,
                           lastdb_revision=args.baseline_core if before else args.candidate_core,
                           source=args.baseline_source if before else Path.cwd(), native_reads=True,
                           body_bytes=4096, extended=True, operations=OPERATIONS)


def disk_gate(runs, kind):
    points = ("seeded_disk", "final_disk") if kind == "read" else PHASES
    compared = []
    for point in points:
        for category, measure in (("whole_home", "allocated_bytes"), ("database", "logical_bytes")):
            values = {}
            for version in ("before", "after"):
                selected = [run for run in runs if run["layout"] == "v2" and run["version"] == version]
                values[version] = [(run[point] if kind == "read" else run["phases"][point]["disk"])[category][measure]
                                   for run in selected]
            before, after = values["before"], values["after"]
            passed = median(after) <= median(before) and max(after) <= max(before)
            compared.append({"checkpoint": point, "category": category, "measure": measure,
                             "before": before, "after": after, "passed": passed})
    if kind == "storage":
        for point in points:
            for category, measure in (("whole_home", "allocated_bytes"), ("database", "logical_bytes")):
                values = {layout: [run["phases"][point]["disk"][category][measure] for run in runs
                                   if run["version"] == "after" and run["layout"] == layout] for layout in ("current", "v2")}
                before, after = values["current"], values["v2"]
                compared.append({"checkpoint": point, "category": category + " versus current Brain", "measure": measure,
                                 "before": before, "after": after, "passed": median(after) <= median(before) and max(after) <= max(before)})
    return {"passed": all(point["passed"] for point in compared), "points": compared,
            "rule": "V2 candidate median and maximum must not exceed accepted V2; whole-home allocated bytes and database logical bytes"}


def latency_gate(comparisons):
    points = []
    for operation in ("all_summaries", "snapshot_counts"):
        for state in ("restart", "warm"):
            pair = {layout: next(c["after"] for c in comparisons if c["layout"] == layout
                                 and c["operation"] == operation and c["state"] == state) for layout in ("current", "v2")}
            for metric in ("p50_ms", "p95_ms"):
                current, v2 = pair["current"], pair["v2"]
                passed = not current["failed"] and not v2["failed"] and v2[metric] < current[metric]
                points.append({"operation": operation, "state": state, "metric": metric,
                               "current": current[metric], "v2": v2[metric], "passed": passed})
    return {"passed": all(p["passed"] for p in points), "points": points}


def require_shutdowns(output):
    # Exact known case folders, with at most eight receipt files per case.
    receipts = []
    for case in output.iterdir():
        if not case.is_dir():
            continue
        for name in ("shutdown.json", "shutdowns.json", "verify-restart-shutdown.json", "reopen_partial-restart-shutdown.json"):
            path = case / name
            if not path.exists():
                continue
            value = json.loads(path.read_text())
            receipts.extend(value if isinstance(value, list) else [value])
    if not receipts or any(value["exit_code"] != 0 or value.get("receipt", {}).get("flush_ok") is not True for value in receipts):
        raise RuntimeError("A generated node lacks a successful shutdown flush")
    return len(receipts)


def write_storage_summary(args, runs):
    for repeat in range(1, args.repeats + 1):
        pair = [run for run in runs if run["repeat"] == repeat]
        for phase in ("create", "update", "delete"):
            if len({run["phases"][phase]["input_sha256"] for run in pair}) != 1:
                raise RuntimeError("Paired storage inputs differ")
    lines = ["## Shared atom spike: durable writes and resources", "",
             "Each version uses both real Brain layouts on fresh generated homes. Order alternates per repeat.",
             "64 summary edits follow the original operation proof. They retain content atoms through key moves and restart.",
             "Memory is the sampled process size every 50 ms, including the workload's result checks.", "",
             "| Layout | Phase | Before p50 ms | After p50 ms | Before p95 ms | After p95 ms | Before node MiB | After node MiB | Before client MiB | After client MiB |",
             "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    comparisons = []
    for layout in ("current", "v2"):
        for phase in ("create", "update", "delete", "partial"):
            pair = []
            for version in ("before", "after"):
                selected = [run["phases"][phase] for run in runs if run["layout"] == layout and run["version"] == version]
                samples = [sample for run in runs if run["layout"] == layout and run["version"] == version
                           for sample in run["raw_samples"][phase]]
                result = storage.stats(samples)
                result.update(node_peak_sampled_bytes=max(item["node_peak_sampled_bytes"] for item in selected),
                              client_peak_sampled_bytes=max(item["client_peak_sampled_bytes"] for item in selected),
                              allocated_bytes=median(item["disk"]["whole_home"]["allocated_bytes"] for item in selected),
                              database_logical_bytes=median(item["disk"]["database"]["logical_bytes"] for item in selected))
                pair.append(result)
            before, after = pair
            comparisons.append({"layout": layout, "operation": phase, "before": before, "after": after})
            lines.append(f"| {layout} | {phase} | {before['p50_ms']:.3f} | {after['p50_ms']:.3f} | {before['p95_ms']:.3f} | {after['p95_ms']:.3f} | "
                         f"{before['node_peak_sampled_bytes']/2**20:.2f} | {after['node_peak_sampled_bytes']/2**20:.2f} | "
                         f"{before['client_peak_sampled_bytes']/2**20:.2f} | {after['client_peak_sampled_bytes']/2**20:.2f} |")
    lines += ["", "Disk checkpoints follow one durable flush and a fixed three-second idle. No forced compaction or repeat-until-small pass runs.",
              "All generated homes stop and are removed. The primary and its archive are not read or copied.",
              "V2 has no search adapter. Body files, attachments, production registration, and migration writes remain outside the spike."]
    lines += ["", "### Older-record operation after restart", ""]
    for run in runs:
        lines.append(f"- Repeat {run['repeat']}, {run['version']}/{run['layout']}: {run['phases']['verify']['verification']['older_record_update']}.")
    with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as summary:
        summary.write("\n".join(lines) + "\n")
    return comparisons


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kind", choices=("read", "storage"), required=True)
    parser.add_argument("--records", type=int, required=True)
    parser.add_argument("--baseline-source", type=Path, required=True)
    parser.add_argument("--baseline-revision", required=True)
    parser.add_argument("--baseline-daemon", type=Path, required=True)
    parser.add_argument("--candidate-daemon", type=Path, required=True)
    parser.add_argument("--baseline-core", required=True)
    parser.add_argument("--candidate-core", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--samples", type=int, default=5)
    args = parser.parse_args()
    if os.environ.get("CI") != "true" or platform.system() != "Linux":
        parser.error("Run only in Linux CI")
    if (not 1 <= args.repeats <= 5 or not 1 <= args.samples <= 20
            or args.records not in ((1000, 10000) if args.kind == "read" else (128, 1024))):
        parser.error("Use bounded spike sizes and sample counts")
    if any(not re.fullmatch(r"[0-9a-f]{40}", revision) for revision in
           (args.baseline_revision, args.baseline_core, args.candidate_core, os.environ["BRAIN_CANDIDATE"])):
        parser.error("All source identities must be complete commits")
    args.baseline_source = args.baseline_source.resolve(strict=True)
    args.baseline_daemon, args.candidate_daemon = args.baseline_daemon.resolve(strict=True), args.candidate_daemon.resolve(strict=True)
    args.output.mkdir(parents=True, exist_ok=False)
    identities = {"brain_before": args.baseline_revision, "brain_after": os.environ["BRAIN_CANDIDATE"],
                  "lastdb_before": args.baseline_core, "lastdb_after": args.candidate_core,
                  "program_sha256": {version: hashlib.sha256(path.read_bytes()).hexdigest()
                                     for version, path in (("before", args.baseline_daemon), ("after", args.candidate_daemon))}}
    storage.save(args.output / "sources.json", identities)
    runs = []
    for repeat in range(1, args.repeats + 1):
        cases = [(version, layout) for version in ("before", "after") for layout in ("current", "v2")]
        if repeat % 2 == 0:
            cases.reverse()
        for version, layout in cases:
            selected = case_args(args, version)
            selected.case_label = f"{version}-{layout}"
            if args.kind == "read":
                run = reads.measure(selected, layout, version, selected.source, repeat)
            else:
                run = storage.run_case(selected, layout, repeat, args.output)
                run["version"] = version
                directory = args.output / f"{repeat:02d}-{selected.case_label}"
                run["raw_samples"] = {phase: json.loads((directory / f"{phase}.json").read_text())["samples"]
                                      for phase in ("create", "update", "delete", "partial")}
            runs.append(run)
            storage.save(args.output / "checkpoints.json", runs)
    if args.kind == "read":
        if len({run["input_sha256"] for run in runs}) != 1:
            raise RuntimeError("Paired read inputs differ")
        selected = case_args(args, "after")
        reads.report(selected, runs)
        comparisons = json.loads((args.output / "metrics.json").read_text())["comparisons"]
    else:
        comparisons = write_storage_summary(args, runs)
    gate = disk_gate(runs, args.kind)
    speed = latency_gate(comparisons) if args.kind == "read" else None
    shutdowns = require_shutdowns(args.output)
    storage.save(args.output / "shared-metrics.json", {"sources": identities, "kind": args.kind, "records": args.records,
                 "comparisons": comparisons, "disk_gate": gate, "latency_gate": speed, "shutdown_flushes": shutdowns, "runs": runs})
    with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as summary:
        summary.write(f"\nBrain source: `{identities['brain_before']}` → `{identities['brain_after']}`.  \n"
                      f"LastDB source: `{args.baseline_core}` → `{args.candidate_core}`.  \n"
                      f"Successful shutdown flushes: {shutdowns}. No-extra-disk gate: **{'PASS' if gate['passed'] else 'FAIL'}**.\n\n"
                      "| Checkpoint | Category | Bytes | Before median | After median | Before maximum | After maximum | Result |\n"
                      "|---|---|---|---:|---:|---:|---:|---|\n")
        for point in gate["points"]:
            summary.write(f"| {point['checkpoint']} | {point['category']} | {point['measure']} | {median(point['before']):.0f} | {median(point['after']):.0f} | "
                          f"{max(point['before'])} | {max(point['after'])} | {'PASS' if point['passed'] else 'FAIL'} |\n")
        if speed:
            summary.write("\n### Summary/count target against current Brain\n\n| Operation | State | Metric | Current ms | V2 ms | Result |\n|---|---|---|---:|---:|---|\n")
            for p in speed["points"]:
                summary.write(f"| {p['operation']} | {p['state']} | {p['metric']} | {p['current']:.3f} | {p['v2']:.3f} | {'PASS' if p['passed'] else 'FAIL'} |\n")
    if not gate["passed"]:
        raise RuntimeError("The candidate V2 exceeded accepted V2 disk space; retain this failed measurement")
    if speed and not speed["passed"]:
        raise RuntimeError("V2 summaries/counts did not beat current Brain at p50 and p95; retain this failed measurement")


if __name__ == "__main__":
    main()
