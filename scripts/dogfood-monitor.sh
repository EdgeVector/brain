#!/bin/bash
# dogfood-monitor.sh — G14 second-user dogfood checker.
#
# Reads ~/.fbrain/usage.jsonl (the per-day summary that `fbrain doctor
# --usage` maintains) and reports PASS/FAIL for each tracked userHash
# prefix over the trailing 7-day window.
#
# PASS criterion (per gate item #6 in g0-replacement-readiness-gate.md):
#   the userHash has >= 1 write recorded in each of the last 7 calendar
#   dates (UTC) ending today.
#
# Usage:
#   scripts/dogfood-monitor.sh <userhash-prefix> [more-prefixes...]
#   scripts/dogfood-monitor.sh --usage-path /tmp/usage.jsonl <prefix>...
#   scripts/dogfood-monitor.sh --window 7 <prefix>...
#
# Notes:
#   * Prefixes are matched against the 8-char prefixes that `fbrain
#     doctor --usage` writes — pass exactly what `jq -r .userHash
#     ~/.fbrain/config.json | cut -c1-8` prints.
#   * The script does NOT trigger a fresh `fbrain doctor --usage` run.
#     Tom is expected to run that daily (cron/launchd) so usage.jsonl
#     accumulates a daily line. If a date is absent from usage.jsonl,
#     it counts as 0 writes that day for every tracked hash.
#   * Exit code: 0 if all hashes PASS, 1 if any FAIL or input invalid.

set -euo pipefail

USAGE_PATH="${HOME}/.fbrain/usage.jsonl"
WINDOW=7
HASHES=()

usage() {
  cat >&2 <<EOF
usage: $0 [--usage-path PATH] [--window N] <prefix> [more-prefixes...]
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --usage-path)
      USAGE_PATH="${2:?--usage-path needs a value}"
      shift 2
      ;;
    --window)
      WINDOW="${2:?--window needs a value}"
      shift 2
      ;;
    --help|-h)
      usage
      ;;
    --*)
      echo "unknown flag: $1" >&2
      usage
      ;;
    *)
      HASHES+=("$1")
      shift
      ;;
  esac
done

if [[ ${#HASHES[@]} -eq 0 ]]; then
  echo "error: at least one userHash prefix required" >&2
  usage
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required (brew install jq)" >&2
  exit 1
fi

if [[ ! -f "$USAGE_PATH" ]]; then
  echo "error: usage file not found at $USAGE_PATH" >&2
  echo "       run 'fbrain doctor --usage' on the daemon host to create it" >&2
  exit 1
fi

# Build the list of dates we need (last $WINDOW dates ending today, UTC).
expected_dates=()
for ((i = WINDOW - 1; i >= 0; i--)); do
  # `date -u -v-${i}d` is BSD/macOS; `date -u -d "$i days ago"` is GNU. Try
  # the BSD form first since this repo ships on Tom's macOS, fall back to GNU.
  if d=$(date -u -v-"${i}"d +%Y-%m-%d 2>/dev/null); then
    expected_dates+=("$d")
  else
    d=$(date -u -d "$i days ago" +%Y-%m-%d)
    expected_dates+=("$d")
  fi
done

# Slurp usage.jsonl into a {date: by_user} map for the dates we care about.
# jq filter: keep only lines whose date is in our window, collapse to
# date -> by_user map.
window_filter=$(printf '%s\n' "${expected_dates[@]}" | jq -R . | jq -s .)
counts_json=$(
  jq -c --argjson dates "$window_filter" '
    select(.date as $d | $dates | index($d) != null)
    | {(.date): (.by_user // {})}
  ' "$USAGE_PATH" | jq -s 'add // {}'
)

# Evaluate each tracked hash against each expected date.
overall_pass=1
echo "dogfood-monitor — window $WINDOW days, source $USAGE_PATH"
echo "  dates: ${expected_dates[0]} … ${expected_dates[${#expected_dates[@]}-1]}"
echo ""

for hash in "${HASHES[@]}"; do
  missing=()
  total=0
  for d in "${expected_dates[@]}"; do
    n=$(echo "$counts_json" | jq -r --arg d "$d" --arg h "$hash" \
      '(.[$d] // {}) | (.[$h] // 0)')
    if [[ "$n" -eq 0 ]]; then
      missing+=("$d")
    fi
    total=$((total + n))
  done

  if [[ ${#missing[@]} -eq 0 ]]; then
    printf "  PASS  %s  — %d writes across %d days\n" "$hash" "$total" "$WINDOW"
  else
    overall_pass=0
    printf "  FAIL  %s  — %d writes, missing on: %s\n" \
      "$hash" "$total" "${missing[*]}"
  fi
done

echo ""
if [[ $overall_pass -eq 1 ]]; then
  echo "RESULT: PASS — all ${#HASHES[@]} userHash(es) wrote >=1 record/day for $WINDOW consecutive days"
  exit 0
else
  echo "RESULT: FAIL — at least one userHash missed a day; gate item #6 not yet met"
  exit 1
fi
