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
FBRAIN_SKIP_INTEGRATION="${FBRAIN_SKIP_INTEGRATION:-1}" bun test --timeout 60000

echo "lastgit ci gate PASSED"
