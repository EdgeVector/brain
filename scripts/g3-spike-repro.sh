#!/bin/bash
# G3 search-latency repro. Single trial:
#   1. Put a concept with a unique nonce token in the body
#   2. Get the record (sanity check)
#   3. Search for the nonce at increasing delays
#   4. Search for a meaningful body word at increasing delays
# Prints CSV-ish lines to stdout: trial,marker,delay_s,event,hits_count,first_slug,note
set -u

PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/Users/tomtang/.bun/bin:$PATH
FBRAIN=/Users/tomtang/.bun/bin/fbrain

trial_id="${1:-1}"
nonce="$(date +%s)$RANDOM"
marker="freshmarker-$nonce"
meaningful="pineapple-$nonce"   # nonce-scoped meaningful-ish word that won't pre-exist
slug="g3-spike-$nonce"

emit() { echo "$trial_id,$marker,$1,$2,$3,$4,$5"; }

# 1. PUT
put_t0=$(date +%s.%N)
put_out=$(cat <<EOF | $FBRAIN put "$slug" 2>&1
---
type: concept
title: G3 spike trial $trial_id
tags: [g3-spike]
---
The unique nonce token is $marker. Meaningful word: $meaningful. Body text exists to be embedded.
EOF
)
put_t1=$(date +%s.%N)
put_ms=$(awk "BEGIN{printf \"%.0f\", ($put_t1 - $put_t0) * 1000}")
emit 0 put_done 1 "$slug" "${put_ms}ms"

# 2. GET sanity check
if $FBRAIN get "$slug" --type concept >/dev/null 2>&1; then
  emit 0 get_ok 1 "$slug" ""
else
  emit 0 get_fail 0 "$slug" "stop"
  exit 0
fi

# 3. Search at delays
for delay in 0 1 3 10 30 60 120 180 300; do
  # the second arg is the increment from previous delay; the loop emits absolute t
  if [ "$delay" -gt 0 ]; then
    sleep_for=$(( delay - prev_delay ))
    [ "$sleep_for" -gt 0 ] && sleep "$sleep_for"
  fi
  prev_delay=$delay

  # 3a. Search by nonce token (lexical-ish)
  hits=$($FBRAIN search "$marker" -n 10 2>/dev/null || true)
  hit_count=$(echo "$hits" | grep -v "^no matches$" | grep -c .)
  first=$(echo "$hits" | head -1 | awk '{print $1}')
  is_us="-"
  [ "$first" = "$slug" ] && is_us="HIT"
  emit "$delay" search_nonce "$hit_count" "$first" "$is_us"

  # 3b. Search by meaningful word
  hits2=$($FBRAIN search "$meaningful" -n 10 2>/dev/null || true)
  hit_count2=$(echo "$hits2" | grep -v "^no matches$" | grep -c .)
  first2=$(echo "$hits2" | head -1 | awk '{print $1}')
  is_us2="-"
  echo "$hits2" | grep -q "^$slug" && is_us2="HIT"
  emit "$delay" search_meaningful "$hit_count2" "$first2" "$is_us2"

  # 3c. Exact-mode search on the nonce
  hits3=$($FBRAIN search "$marker" --exact -n 10 2>/dev/null || true)
  hit_count3=$(echo "$hits3" | grep -v "^no matches$" | grep -c .)
  first3=$(echo "$hits3" | head -1 | awk '{print $1}')
  is_us3="-"
  [ "$first3" = "$slug" ] && is_us3="HIT"
  emit "$delay" search_exact "$hit_count3" "$first3" "$is_us3"

  # If we already got a HIT in any flavour, no need to keep waiting longer
  if [ "$is_us" = "HIT" ] && [ "$is_us2" = "HIT" ] && [ "$is_us3" = "HIT" ]; then
    emit "$delay" all_hit_short_circuit 0 "$slug" ""
    break
  fi
done

# 4. Cleanup
$FBRAIN delete "$slug" --type concept >/dev/null 2>&1 || true
