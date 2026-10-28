#!/usr/bin/env python3
"""CI-only paired Brain storage measurements on fresh generated LastDB homes."""
import argparse
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import platform
import shutil
import socket
import stat
import subprocess
import tempfile
import time


def save(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("localhost", timeout=60)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(self.timeout)
        self.sock.connect(str(self.path))


def call(path, route, body=None):
    connection = UnixConnection(path)
    try:
        connection.request("GET" if body is None else "POST", route,
                           None if body is None else json.dumps(body).encode(),
                           {"Content-Type": "application/json", "X-LastDB-Client": "brain-v2-ci"})
        response = connection.getresponse()
        raw = response.read(8 * 1024 * 1024 + 1)
        if response.status != 200 or len(raw) > 8 * 1024 * 1024:
            raise RuntimeError(f"{route}: HTTP {response.status}, {raw[:500]!r}")
        value = json.loads(raw)
        if value.get("ok") is False:
            raise RuntimeError(f"{route}: rejected {raw[:500]!r}")
        return value.get("data", value)
    finally:
        connection.close()


def memory(pid):
    try:
        values = {}
        for line in Path(f"/proc/{pid}/status").read_text().splitlines():
            if line.startswith(("VmRSS:", "VmHWM:")):
                values[line.split(":")[0]] = int(line.split()[1]) * 1024
        return values
    except FileNotFoundError:
        return {}


def disk(home):
    # Bounded owned-home walk: depth <= 12, files <= 100000, time <= 15 seconds.
    result = {name: {"logical_bytes": 0, "allocated_bytes": 0, "files": 0}
              for name in ("database", "search_queue", "other", "whole_home")}
    stack, count, deadline = [(home, 0)], 0, time.monotonic() + 15
    while stack:
        parent, depth = stack.pop()
        if depth > 12 or time.monotonic() > deadline:
            raise RuntimeError("Owned-home size check exceeded its bound")
        for child in parent.iterdir():
            count += 1
            if count > 100_000:
                raise RuntimeError("Owned-home file count exceeded its bound")
            try:
                info = child.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(info.st_mode):
                raise RuntimeError("Unexpected symlink in generated home")
            if stat.S_ISDIR(info.st_mode):
                stack.append((child, depth + 1))
                continue
            if not stat.S_ISREG(info.st_mode):
                continue
            parts = child.relative_to(home).parts
            category = ("search_queue" if parts[:3] == ("apps", "search", "inbox") else
                        "database" if parts[0] in ("data", "blobs") else "other")
            for name in (category, "whole_home"):
                result[name]["logical_bytes"] += info.st_size
                result[name]["allocated_bytes"] += info.st_blocks * 512
                result[name]["files"] += 1
    return result


def stats(samples):
    ordered = sorted(sample["elapsed_ms"] for sample in samples)
    return {"operations": len(samples), "p50_ms": ordered[math.ceil(len(ordered) * .5) - 1],
            "p95_ms": ordered[math.ceil(len(ordered) * .95) - 1],
            "p99_ms": ordered[math.ceil(len(ordered) * .99) - 1],
            "mean_ms": sum(ordered) / len(ordered),
            "requests_per_operation": sum(sample["requests"] for sample in samples) / len(samples)}


def run_case(args, layout, repeat, output):
    destination = output / f"{repeat:02d}-{layout}"
    destination.mkdir()
    root = Path(tempfile.mkdtemp(prefix="br2-", dir="/tmp")).resolve()
    owner = {"pid": os.getpid(), "uid": os.getuid(), "inode": root.stat().st_ino}
    save(root / "owner.json", owner)
    home, sock = root / "home", root / "q.sock"
    home.mkdir(mode=0o700)
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith(("LASTDB", "FOLD", "FBRAIN", "BRAIN", "SENTRY", "OTEL"))
                   and key not in ("GH_TOKEN", "GITHUB_TOKEN")}
    environment.update(LASTDB_ISOLATED_COPY="1", LASTDB_SUPPRESS_RECOVERY_PHRASE="1",
                       LASTDB_HOME=str(home), FOLDDB_HOME=str(home),
                       FBRAIN_APP_IDENTITY_ENFORCE="off", BRAIN_CONFIG=str(root / "config.json"),
                       FBRAIN_FOLDDB_SOCKET=str(sock), RUST_MIN_STACK="16777216")
    save(root / "settings.json", {"socket": str(sock), "records": args.records, "bodyBytes": args.body_bytes})
    log = (destination / "node.log").open("w")
    daemon = subprocess.Popen([str(args.lastdbd), "--data-dir", str(home), "--socket-path", str(sock),
                               "--full-socket-path", str(root / "f.sock")],
                              env=environment, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
    client = None
    try:
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            if daemon.poll() is not None:
                raise RuntimeError("Owned daemon exited before health; inspect its CI log")
            if sock.exists():
                try:
                    value = call(sock, "/api/version")
                    if args.lastdb_revision[:9] not in json.dumps(value):
                        raise RuntimeError("Daemon version differs from pinned LastDB revision")
                    save(destination / "version.json", value)
                    break
                except (OSError, http.client.HTTPException):
                    pass
            time.sleep(.1)
        else:
            raise RuntimeError("Owned daemon missed its health deadline")
        summary = {"layout": layout, "repeat": repeat, "phases": {}}
        for phase in ("setup", "create", "update", "delete", "verify"):
            peak_node, peak_client, peak_combined = 0, 0, 0
            phase_log = (destination / f"{phase}.log").open("w")
            client = subprocess.Popen(["bun", "src/v2/spike-workload.ts", layout, phase,
                                       str(root / "settings.json"), str(destination / f"{phase}.json")],
                                      env=environment, stdin=subprocess.DEVNULL, stdout=phase_log, stderr=phase_log)
            deadline = time.monotonic() + 900
            while client.poll() is None:
                if time.monotonic() > deadline:
                    raise RuntimeError(f"{layout}/{phase} exceeded its 900-second bound")
                node_size = memory(daemon.pid).get("VmRSS", 0)
                client_size = memory(client.pid).get("VmRSS", 0)
                peak_node, peak_client = max(peak_node, node_size), max(peak_client, client_size)
                peak_combined = max(peak_combined, node_size + client_size)
                time.sleep(.05)
            phase_log.close()
            if client.returncode:
                raise RuntimeError(f"{layout}/{phase} failed; inspect {destination.name}/{phase}.log")
            measured = json.loads((destination / f"{phase}.json").read_text())
            checkpoint = {"node_peak_sampled_bytes": peak_node, "client_peak_sampled_bytes": peak_client,
                          "combined_peak_sampled_bytes": peak_combined, "node_memory": memory(daemon.pid),
                          "input_sha256": measured["input_sha256"]}
            if measured["samples"]:
                checkpoint["latency"] = stats(measured["samples"])
            if phase != "setup":
                flushed = call(sock, "/api/db/flush", {})
                if flushed.get("durable") is not True:
                    raise RuntimeError("Checkpoint lacks a durable flush")
            checkpoint["disk"] = disk(home)
            save(destination / f"{phase}-status.json", call(sock, "/api/status"))
            if phase == "verify":
                checkpoint["verification"] = measured["verification"]
            summary["phases"][phase] = checkpoint
            print(f"{destination.name}: {phase} complete", flush=True)
        save(destination / "metrics.json", summary)
        return summary
    finally:
        if client is not None and client.poll() is None:
            client.terminate()
            try:
                client.wait(timeout=10)
            except subprocess.TimeoutExpired:
                client.kill()
                client.wait(timeout=5)
        if daemon.poll() is None:
            daemon.terminate()
            try:
                daemon.wait(timeout=45)
            except subprocess.TimeoutExpired:
                daemon.kill()
                daemon.wait(timeout=5)
        log.close()
        receipt_path = home / ".shutdown_flush_ready"
        receipt = json.loads(receipt_path.read_text()) if receipt_path.exists() else None
        save(destination / "shutdown.json", {"exit_code": daemon.returncode, "receipt": receipt})
        if (root.is_symlink() or root.stat().st_uid != os.getuid() or root.stat().st_ino != owner["inode"]
                or json.loads((root / "owner.json").read_text()) != owner):
            raise RuntimeError("Owned home identity changed; refuse cleanup")
        shutil.rmtree(root)


def report(results, output, args):
    for repeat in range(1, args.repeats + 1):
        pair = [result for result in results if result["repeat"] == repeat]
        for phase in ("create", "update", "delete"):
            if len({result["phases"][phase]["input_sha256"] for result in pair}) != 1:
                raise RuntimeError("The paired layouts received different generated inputs")
    lines = ["## Brain v2 molecule spike", "", f"Source: `{os.environ['GITHUB_SHA']}`.",
             f"LastDB: `{args.lastdb_revision}`. Binary SHA-256: `{hashlib.sha256(args.lastdbd.read_bytes()).hexdigest()}`.",
             f"Each fresh home receives {args.records} records, {args.body_bytes} body bytes, two tags, and two record types.",
             f"Update timing uses {args.records//4} writes to the sixteen most recent records. Eight recent records are then deleted.",
             "An older-record update runs separately and retains the current layout's refusal as an operational finding.",
             "Both layouts use the same release daemon, host, disk format, encryption defaults, and durable create/update calls.",
             "Order alternates between paired repeats. Memory values are process memory; samples occur every 50 ms.", "",
             "| Repeat | Layout | Created disk MiB | Updated disk MiB | Create p50 ms | Create p95 ms | Update p50 ms | Update p95 ms | Node peak MiB | Client peak MiB |", "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for result in results:
        phases = result["phases"]
        create, update = phases["create"], phases["update"]
        lines.append(f"| {result['repeat']} | {result['layout']} | {create['disk']['whole_home']['allocated_bytes']/2**20:.2f} | "
                     f"{update['disk']['whole_home']['allocated_bytes']/2**20:.2f} | {create['latency']['p50_ms']:.3f} | "
                     f"{create['latency']['p95_ms']:.3f} | {update['latency']['p50_ms']:.3f} | {update['latency']['p95_ms']:.3f} | "
                     f"{max(create['node_peak_sampled_bytes'], update['node_peak_sampled_bytes'])/2**20:.2f} | "
                     f"{max(create['client_peak_sampled_bytes'], update['client_peak_sampled_bytes'])/2**20:.2f} |")
    lines += ["", "Disk includes the whole generated home. Raw metrics separate database, Search delivery queue, and other files.",
              "The default Brain path also maintains counts and bounded keyword fallback pages. V2 does not implement those features yet.",
              "This spike covers scalar lookup molecules and tag memberships. Search delivery is queued; LastSeek, graph, files, and migration are outside this comparison.",
              "No primary data or primary copy is used. No local benchmark or test suite runs.",
              "The prototype remains opt-in. These results do not authorize a primary upgrade."]
    text = "\n".join(lines) + "\n"
    save(output / "metrics.json", {"source": os.environ["GITHUB_SHA"], "lastdb_revision": args.lastdb_revision, "results": results})
    with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as stream:
        stream.write(text)
    print(text)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lastdbd", type=Path, required=True)
    parser.add_argument("--lastdb-revision", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--records", type=int, default=1024)
    parser.add_argument("--body-bytes", type=int, default=4096)
    parser.add_argument("--repeats", type=int, default=3)
    args = parser.parse_args()
    if os.environ.get("CI") != "true" or platform.system() != "Linux":
        parser.error("Measurements run only on a Linux CI worker")
    if not (128 <= args.records <= 10_000 and args.records % 64 == 0 and 256 <= args.body_bytes <= 16384 and 1 <= args.repeats <= 5):
        parser.error("Use 128..10000 records divisible by 64, 256..16384 body bytes, and 1..5 repeats")
    args.lastdbd = args.lastdbd.resolve(strict=True)
    args.output.mkdir(parents=True, exist_ok=False)
    results = []
    for repeat in range(1, args.repeats + 1):
        for layout in (("current", "v2") if repeat % 2 else ("v2", "current")):
            results.append(run_case(args, layout, repeat, args.output))
    report(results, args.output, args)


if __name__ == "__main__":
    main()
