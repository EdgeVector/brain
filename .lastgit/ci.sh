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
FBRAIN_SKIP_INTEGRATION="${FBRAIN_SKIP_INTEGRATION:-1}" bun test --timeout 60000

echo "lastgit ci gate PASSED"
