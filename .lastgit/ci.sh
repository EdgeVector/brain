#!/usr/bin/env bash
# LastGit merge gate for brain.
set -euo pipefail

cd "$(dirname "$0")/.."
shopt -s nullglob 2>/dev/null || true

echo "== shell syntax =="
for f in .lastgit/*.sh bin/* scripts/*.sh; do
  [ -f "$f" ] || continue
  case "$f" in
    *.sh|bin/brain|bin/brain-mcp)
      echo "bash -n $f"
      bash -n "$f"
      ;;
  esac
done

echo "== dependencies =="
bun install --frozen-lockfile

echo "== typecheck =="
bun run typecheck

echo "== tests =="
# Routines host env injects lastsecrets:// OBS_SENTRY_DSN which is not a real DSN;
# unset so CLI stderr purity tests stay green under scheduled pickup.
unset OBS_SENTRY_DSN SENTRY_DSN || true
# Unit tests deliberately provide their own fake LastSeek binary where needed.
# Hide the host installation so unrelated mocked search tests cannot discover it
# through the default command name and escape their fixture boundary.
ci_shim_dir="$(mktemp -d)"
trap 'rm -rf "$ci_shim_dir"' EXIT
printf '#!/bin/sh\nexit 127\n' > "$ci_shim_dir/lastseek"
chmod +x "$ci_shim_dir/lastseek"
unset LASTSEEK_BIN
export PATH="$ci_shim_dir:$PATH"
# The incumbent planes behind LastSeek escape the same way: src/search-plane.ts
# falls through to the host-track semantic module (over $HOME/.lastdb/apps/search)
# and then to the `search semantic-query` CLI. On a host with the search app
# installed both answer REAL hits from the primary's index whenever the node is
# fast enough, so mocked-fetch tests that count rows or queries drift by one and
# the gate's verdict follows node latency (Forgejo run 3 on main, 2026-09-06:
# 23 searchCmd failures; same tree green locally three times). Point the CLI at
# an exit-127 shim and the module at an empty search home so neither plane can
# produce a hit. LASTSEEK_DISABLE is deliberately NOT set: lastseek-plane tests
# supply their own fake binary and expect that tier to run.
# papercut-brain-search-tests-not-hermetic-host-search-plane-answers-real-hits-20260906
cp "$ci_shim_dir/lastseek" "$ci_shim_dir/search"
mkdir -p "$ci_shim_dir/search-home"
export LASTDB_SEARCH_BIN="$ci_shim_dir/search"
export SEARCH_HOME="$ci_shim_dir/search-home"
unset LASTDB_SEARCH_SEMANTIC_MODULE
FBRAIN_SKIP_INTEGRATION="${FBRAIN_SKIP_INTEGRATION:-1}" bun test --timeout 60000

echo "lastgit ci gate PASSED"
