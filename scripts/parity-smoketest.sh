#!/usr/bin/env bash
# parity-smoketest.sh — round-trip 20 fixture slugs through fbrain
# put → get and diff title/body/tags/status for identity.
#
# Backs G0 readiness-gate item #1 (docs/g0-replacement-readiness-gate.md).
#
# Idempotent: re-running upserts the same fixtures via Phase 4 semantics
# and re-asserts parity. Status comparison uses each type's default
# (drafts for design, open for task, etc.) since `put` does not honor
# a `status:` frontmatter field — the first put assigns the default and
# subsequent puts preserve whatever exists.
#
# Exit 0 if all 20 match; non-zero with the mismatch count otherwise.
# Override the fbrain binary with $FBRAIN (defaults to `fbrain` on PATH).

set -u
set -o pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURES_DIR="$ROOT/test/fixtures/parity"
FBRAIN="${FBRAIN:-fbrain}"

if [ ! -d "$FIXTURES_DIR" ]; then
  echo "parity-smoketest: fixtures dir missing: $FIXTURES_DIR" >&2
  exit 2
fi

# Allow $FBRAIN to be a multi-token command (e.g. `bun src/cli.ts`); the
# existence check looks at only the first token.
read -r FBRAIN_BIN _rest <<< "$FBRAIN"
if ! command -v "$FBRAIN_BIN" >/dev/null 2>&1; then
  echo "parity-smoketest: '$FBRAIN_BIN' not on PATH (override with FBRAIN=...)" >&2
  exit 2
fi

# Default status per type. Mirrors RECORDS[type].defaultStatus in src/schemas.ts.
default_status_for() {
  case "$1" in
    design)     echo "draft" ;;
    task)       echo "open" ;;
    concept)    echo "active" ;;
    preference) echo "active" ;;
    reference)  echo "active" ;;
    agent)      echo "active" ;;
    project)    echo "planning" ;;
    spike)      echo "active" ;;
    *)          echo ""; return 1 ;;
  esac
}

# Strip a single matching pair of surrounding double or single quotes.
strip_quotes() {
  local s="$1"
  local n=${#s}
  if [ "$n" -ge 2 ]; then
    local f="${s:0:1}" l="${s: -1}"
    if { [ "$f" = '"' ] && [ "$l" = '"' ]; } || { [ "$f" = "'" ] && [ "$l" = "'" ]; }; then
      s="${s:1:$((n-2))}"
    fi
  fi
  printf '%s' "$s"
}

# Read fixture frontmatter (between the first two `---` lines) and emit
# expected: type, title, tags (canonicalised "a,b,c"), body (everything
# after the closing `---`, trailing newlines trimmed).
#
# Frontmatter parsing constraints (fixture-side, not put-side):
#   - `type:` and `title:` are inline scalars (optionally quoted).
#   - `tags:` is the inline form `[a, b, c]` or absent. Block lists
#     (`  - tag`) are NOT used in fixtures — keeps the bash parser
#     scoped to what we need for the round-trip assertion.
parse_fixture() {
  local file="$1"
  local in_fm=0 closed=0 line
  local f_type="" f_title="" f_tags="__absent__" body=""
  while IFS='' read -r line || [ -n "$line" ]; do
    if [ "$closed" -eq 1 ]; then
      body+="$line"$'\n'
      continue
    fi
    if [ "$in_fm" -eq 0 ]; then
      if [ "$line" = "---" ]; then
        in_fm=1
      fi
      continue
    fi
    if [ "$line" = "---" ]; then
      closed=1
      continue
    fi
    case "$line" in
      type:*)
        f_type=$(strip_quotes "$(printf '%s' "${line#type:}" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')")
        ;;
      title:*)
        f_title=$(strip_quotes "$(printf '%s' "${line#title:}" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')")
        ;;
      tags:*)
        local raw="${line#tags:}"
        raw=$(printf '%s' "$raw" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
        if [ "$raw" = "[]" ]; then
          f_tags=""
        elif [[ "$raw" == \[*\] ]]; then
          local inner="${raw:1:${#raw}-2}"
          local IFS=','
          local -a parts=()
          # shellcheck disable=SC2206
          parts=( $inner )
          local out="" item stripped
          for item in "${parts[@]}"; do
            stripped=$(printf '%s' "$item" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
            stripped=$(strip_quotes "$stripped")
            if [ -n "$stripped" ]; then
              if [ -z "$out" ]; then out="$stripped"; else out="$out,$stripped"; fi
            fi
          done
          f_tags="$out"
        else
          echo "parity-smoketest: $file: tags must be inline [a, b] form (got: $raw)" >&2
          return 1
        fi
        ;;
    esac
  done < "$file"

  if [ "$closed" -eq 0 ]; then
    echo "parity-smoketest: $file: missing closing --- delimiter" >&2
    return 1
  fi
  # Strip trailing newlines to match fbrain's body-normalisation
  # (splitFrontmatter trims trailing \n).
  body="${body%$'\n'}"
  while [ "${body: -1}" = $'\n' ] 2>/dev/null; do body="${body%$'\n'}"; done

  if [ -z "$f_type" ]; then
    echo "parity-smoketest: $file: missing type: in frontmatter" >&2
    return 1
  fi
  if [ -z "$f_title" ]; then
    echo "parity-smoketest: $file: missing title: in frontmatter" >&2
    return 1
  fi
  if [ "$f_tags" = "__absent__" ]; then f_tags=""; fi

  # Output is a single line per field, terminated by a sentinel for the body
  # (which may contain newlines). Caller reads via a here-doc.
  printf 'TYPE %s\n'   "$f_type"
  printf 'TITLE %s\n'  "$f_title"
  printf 'TAGS %s\n'   "$f_tags"
  printf 'BODY_BEGIN\n%s\nBODY_END\n' "$body"
}

# Parse `fbrain get <slug>` output. Emits the same TYPE/TITLE/TAGS/STATUS/BODY
# block as parse_fixture. The get format (see formatRecord in
# src/commands/get.ts) is:
#   [type] slug
#   title:      <title>
#   status:     <status>
#   tags:       <a, b> | (none)
#   [design:     <slug> | (none)]
#   created_at: <iso>
#   updated_at: <iso>
#   ---
#   <body>          # only if body non-empty
parse_get_output() {
  local input="$1"
  local title="" status="" tags="" body=""
  local in_body=0 first_body=1 line

  while IFS='' read -r line; do
    if [ "$in_body" -eq 1 ]; then
      if [ "$first_body" -eq 1 ]; then
        body="$line"
        first_body=0
      else
        body+=$'\n'"$line"
      fi
      continue
    fi
    case "$line" in
      "title:      "*) title="${line#title:      }" ;;
      "status:     "*) status="${line#status:     }" ;;
      "tags:       "*)
        tags="${line#tags:       }"
        if [ "$tags" = "(none)" ]; then tags=""; fi
        ;;
      "---")
        in_body=1
        ;;
    esac
  done <<< "$input"

  # Normalise tags: get prints "a, b, c" — canonicalise to "a,b,c"
  # by stripping the spaces after commas.
  if [ -n "$tags" ]; then
    tags=$(printf '%s' "$tags" | sed -E 's/, /,/g')
  fi

  printf 'TITLE %s\n'  "$title"
  printf 'STATUS %s\n' "$status"
  printf 'TAGS %s\n'   "$tags"
  printf 'BODY_BEGIN\n%s\nBODY_END\n' "$body"
}

# Extract one tagged scalar (TITLE / STATUS / TAGS / TYPE) out of a parsed
# block.
extract_scalar() {
  local block="$1" tag="$2"
  printf '%s\n' "$block" | awk -v t="$tag" '
    $1 == t { sub("^"t" ", ""); print; exit }
  '
}

# Extract the body from a parsed block.
extract_body() {
  local block="$1"
  printf '%s\n' "$block" | awk '
    /^BODY_BEGIN$/  { in_body=1; next }
    /^BODY_END$/    { exit }
    in_body         { print }
  '
}

# ---- main ----

fixtures=( "$FIXTURES_DIR"/*.md )
if [ "${#fixtures[@]}" -eq 0 ] || [ ! -f "${fixtures[0]}" ]; then
  echo "parity-smoketest: no fixtures found in $FIXTURES_DIR" >&2
  exit 2
fi

count=${#fixtures[@]}
echo "parity-smoketest: $count fixtures from $FIXTURES_DIR"

# Phase 1 — put every fixture (idempotent upsert).
echo "parity-smoketest: phase 1 — put"
for file in "${fixtures[@]}"; do
  slug=$(basename "$file" .md)
  if ! $FBRAIN put "$slug" < "$file" >/dev/null 2>&1; then
    echo "  [PUT-FAIL] $slug" >&2
    $FBRAIN put "$slug" < "$file" >&2 || true
    exit 1
  fi
done

# Phase 2 — get + diff each fixture.
echo "parity-smoketest: phase 2 — get + diff"
mismatches=0
mismatch_list=()
for file in "${fixtures[@]}"; do
  slug=$(basename "$file" .md)
  if ! expected_block=$(parse_fixture "$file"); then
    mismatches=$((mismatches+1))
    mismatch_list+=("$slug (fixture-parse)")
    continue
  fi
  exp_type=$(extract_scalar  "$expected_block" TYPE)
  exp_title=$(extract_scalar "$expected_block" TITLE)
  exp_tags=$(extract_scalar  "$expected_block" TAGS)
  exp_body=$(extract_body    "$expected_block")
  exp_status=$(default_status_for "$exp_type") || {
    echo "  [BAD-TYPE] $slug: unknown type $exp_type" >&2
    mismatches=$((mismatches+1))
    mismatch_list+=("$slug (bad-type)")
    continue
  }

  # fold_db's /api/query is intermittently lossy on a polluted daemon (the
  # H2 case from docs/phase-7-search-latency-spike.md — same query returns
  # different result counts run-to-run). Retry a few times before declaring
  # a real not-found. Three attempts at 250 ms covers the observed flake
  # rate; fbrain-side put → get parity is the property we're measuring,
  # not fold_db's read-consistency window.
  got_raw=""
  for attempt in 1 2 3 4 5; do
    if got_raw=$($FBRAIN get "$slug" --type "$exp_type" 2>/dev/null); then
      break
    fi
    got_raw=""
    sleep 0.25
  done
  if [ -z "$got_raw" ]; then
    echo "  [GET-FAIL] $slug (5 attempts)" >&2
    mismatches=$((mismatches+1))
    mismatch_list+=("$slug (get-fail)")
    continue
  fi
  actual_block=$(parse_get_output "$got_raw")
  act_title=$(extract_scalar  "$actual_block" TITLE)
  act_status=$(extract_scalar "$actual_block" STATUS)
  act_tags=$(extract_scalar   "$actual_block" TAGS)
  act_body=$(extract_body     "$actual_block")

  fail_reasons=()
  [ "$exp_title"  = "$act_title"  ] || fail_reasons+=("title (expected=$(printf %q "$exp_title") got=$(printf %q "$act_title"))")
  [ "$exp_status" = "$act_status" ] || fail_reasons+=("status (expected=$exp_status got=$act_status)")
  [ "$exp_tags"   = "$act_tags"   ] || fail_reasons+=("tags (expected=$exp_tags got=$act_tags)")
  [ "$exp_body"   = "$act_body"   ] || fail_reasons+=("body")

  if [ "${#fail_reasons[@]}" -eq 0 ]; then
    echo "  [OK]   $slug"
  else
    echo "  [DIFF] $slug — ${fail_reasons[*]}"
    if [[ " ${fail_reasons[*]} " == *" body "* ]]; then
      diff <(printf '%s\n' "$exp_body") <(printf '%s\n' "$act_body") | sed 's/^/        /' || true
    fi
    mismatches=$((mismatches+1))
    mismatch_list+=("$slug")
  fi
done

echo
if [ "$mismatches" -eq 0 ]; then
  echo "parity-smoketest: $count/$count pass"
  exit 0
fi
echo "parity-smoketest: $mismatches mismatch(es): ${mismatch_list[*]}"
exit 1
