#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:3000}"
DURATION_SEC="${2:-1800}"
INTERVAL_SEC="${3:-60}"
OUT_DIR="${4:-data/canary}"

mkdir -p "$OUT_DIR"

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
START_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
START_EPOCH="$(date +%s)"

CSV_FILE="$OUT_DIR/phase3_canary_${RUN_ID}.csv"
SUMMARY_JSON="$OUT_DIR/phase3_canary_${RUN_ID}.summary.json"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

header="at,health_ok,health_code,health_sec,prematch_count,live_count,exec_observed,exec_final_status,exec_final_outcome,exec_confirmed,exec_rejected,exec_uncertain,pn_uncertain,bk_uncertain"
echo "$header" > "$CSV_FILE"

echo "[phase3-canary] runId=$RUN_ID start=$START_ISO durationSec=$DURATION_SEC intervalSec=$INTERVAL_SEC"

authless_get() {
  local url="$1"
  local file="$2"
  curl -sS --max-time 15 -o "$file" -w "%{http_code}|%{time_total}" "$url" 2>/dev/null || echo "000|0"
}

safe_jq_num() {
  local expr="$1"
  local file="$2"
  jq -r "$expr" "$file" 2>/dev/null || echo "0"
}

while true; do
  now_epoch="$(date +%s)"
  elapsed="$((now_epoch - START_EPOCH))"
  if [[ "$elapsed" -ge "$DURATION_SEC" ]]; then
    break
  fi

  at_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  health_file="$TMP_DIR/health.json"
  prematch_file="$TMP_DIR/prematch.json"
  live_file="$TMP_DIR/live.json"
  audit_file="$TMP_DIR/audit.json"
  pn_file="$TMP_DIR/pn.json"
  bk_file="$TMP_DIR/bk.json"

  health_meta="$(authless_get "$BASE_URL/api/health" "$health_file")"
  prematch_meta="$(authless_get "$BASE_URL/api/opportunities/prematch?limit=100" "$prematch_file")"
  live_meta="$(authless_get "$BASE_URL/api/opportunities/live?limit=100" "$live_file")"
  audit_meta="$(authless_get "$BASE_URL/api/opportunities/arbitrage/execution-audit?limit=300" "$audit_file")"
  _pn_meta="$(authless_get "$BASE_URL/api/pinnacle/tickets" "$pn_file")"
  _bk_meta="$(authless_get "$BASE_URL/api/booky/tickets" "$bk_file")"

  IFS='|' read -r health_code health_sec <<< "$health_meta"
  IFS='|' read -r _prematch_code _prematch_sec <<< "$prematch_meta"
  IFS='|' read -r _live_code _live_sec <<< "$live_meta"
  IFS='|' read -r _audit_code _audit_sec <<< "$audit_meta"

  health_ok=0
  if [[ "$health_code" =~ ^2[0-9][0-9]$ ]]; then
    health_ok=1
  fi

  prematch_count="$(safe_jq_num '(.count // (.data|length) // 0) | tonumber? // 0' "$prematch_file")"
  live_count="$(safe_jq_num '(.count // (.data|length) // 0) | tonumber? // 0' "$live_file")"

  exec_metrics="$(jq -r --arg start "$START_ISO" '
    [(.items // [])[] | select((.at // "") >= $start)] as $rows |
    [
      ($rows | length),
      ($rows | map((.status // "") | ascii_upcase) | map(select(. == "CONFIRMED" or . == "REJECTED" or . == "UNCERTAIN")) | length),
      ($rows | map((.outcome // "") | ascii_upcase) | map(select(. == "CONFIRMED" or . == "REJECTED" or . == "UNCERTAIN")) | length),
      ($rows | map((.status // "") | ascii_upcase) | map(select(. == "CONFIRMED")) | length),
      ($rows | map((.status // "") | ascii_upcase) | map(select(. == "REJECTED")) | length),
      ($rows | map((.status // "") | ascii_upcase) | map(select(. == "UNCERTAIN")) | length)
    ] | @csv
  ' "$audit_file" 2>/dev/null || echo '0,0,0,0,0,0')"
  exec_metrics="${exec_metrics//\"/}"
  IFS=',' read -r exec_observed exec_final_status exec_final_outcome exec_confirmed exec_rejected exec_uncertain <<< "$exec_metrics"

  pn_uncertain="$(safe_jq_num '[((.pending // []) + (.history // []))[] | (.status // "") | ascii_upcase | select(test("UNCERTAIN"))] | length' "$pn_file")"
  bk_uncertain="$(safe_jq_num '[((.pending // []) + (.history // []))[] | (.status // "") | ascii_upcase | select(test("UNCERTAIN"))] | length' "$bk_file")"

  echo "$at_iso,$health_ok,$health_code,$health_sec,$prematch_count,$live_count,$exec_observed,$exec_final_status,$exec_final_outcome,$exec_confirmed,$exec_rejected,$exec_uncertain,$pn_uncertain,$bk_uncertain" >> "$CSV_FILE"
  echo "[phase3-canary] sample at=$at_iso elapsed=${elapsed}s health=${health_code} prematch=${prematch_count} live=${live_count} exec=${exec_observed}"

  sleep "$INTERVAL_SEC"
done

readarray -t lines < "$CSV_FILE"
if [[ "${#lines[@]}" -le 1 ]]; then
  jq -n \
    --arg runId "$RUN_ID" \
    --arg start "$START_ISO" \
    '{runId:$runId,start:$start,error:"No se registraron muestras.",gate:{readyForPhase4:false}}' > "$SUMMARY_JSON"
  cat "$SUMMARY_JSON"
  exit 0
fi

sample_count=$(( ${#lines[@]} - 1 ))
ok_samples="$(awk -F, 'NR>1 {s+=$2} END {print s+0}' "$CSV_FILE")"
avg_health_sec="$(awk -F, 'NR>1 {s+=$4;c++} END {if(c==0) print 0; else print s/c}' "$CSV_FILE")"
avg_prematch="$(awk -F, 'NR>1 {s+=$5;c++} END {if(c==0) print 0; else print s/c}' "$CSV_FILE")"
avg_live="$(awk -F, 'NR>1 {s+=$6;c++} END {if(c==0) print 0; else print s/c}' "$CSV_FILE")"
max_exec_obs="$(awk -F, 'NR>1 {if($7>m)m=$7} END {print m+0}' "$CSV_FILE")"
max_exec_final_status="$(awk -F, 'NR>1 {if($8>m)m=$8} END {print m+0}' "$CSV_FILE")"
max_exec_final_outcome="$(awk -F, 'NR>1 {if($9>m)m=$9} END {print m+0}' "$CSV_FILE")"
max_exec_confirmed="$(awk -F, 'NR>1 {if($10>m)m=$10} END {print m+0}' "$CSV_FILE")"
max_exec_rejected="$(awk -F, 'NR>1 {if($11>m)m=$11} END {print m+0}' "$CSV_FILE")"
max_exec_uncertain="$(awk -F, 'NR>1 {if($12>m)m=$12} END {print m+0}' "$CSV_FILE")"

last_row="$(tail -n 1 "$CSV_FILE")"
IFS=',' read -r end_at _lh_ok _lh_code _lh_sec _lprem _llive l_exec_obs l_exec_final_status l_exec_final_outcome l_exec_confirmed l_exec_rejected l_exec_uncertain l_pn_uncertain l_bk_uncertain <<< "$last_row"

ok_rate_pct="$(awk -v ok="$ok_samples" -v n="$sample_count" 'BEGIN{if(n==0) print 0; else print (ok*100)/n}')"
closure_numerator="$(awk -v a="$max_exec_final_status" -v b="$max_exec_final_outcome" 'BEGIN{if(a>b) print a; else print b}')"
closure_pct="$(awk -v obs="$max_exec_obs" -v num="$closure_numerator" 'BEGIN{if(obs<=0) print "null"; else print (num*100)/obs}')"

has_exec=0
[[ "$max_exec_obs" -gt 0 ]] && has_exec=1
closure_ok=0
[[ "$closure_numerator" -ge "$max_exec_obs" && "$max_exec_obs" -gt 0 ]] && closure_ok=1
health_stable=0
awk -v r="$ok_rate_pct" 'BEGIN{exit !(r>=99)}' && health_stable=1 || true
no_pending_uncertain=0
if [[ $((l_pn_uncertain + l_bk_uncertain)) -eq 0 ]]; then
  no_pending_uncertain=1
fi
ready=0
if [[ "$has_exec" -eq 1 && "$closure_ok" -eq 1 && "$health_stable" -eq 1 && "$no_pending_uncertain" -eq 1 ]]; then
  ready=1
fi

jq -n \
  --arg runId "$RUN_ID" \
  --arg start "$START_ISO" \
  --arg end "$end_at" \
  --arg csv "$CSV_FILE" \
  --argjson samples "$sample_count" \
  --argjson okSamples "$ok_samples" \
  --argjson okRatePct "$ok_rate_pct" \
  --argjson avgHealthSec "$avg_health_sec" \
  --argjson avgPrematch "$avg_prematch" \
  --argjson avgLive "$avg_live" \
  --argjson observedExecutions "$max_exec_obs" \
  --argjson finalByStatus "$max_exec_final_status" \
  --argjson finalByOutcome "$max_exec_final_outcome" \
  --argjson confirmed "$max_exec_confirmed" \
  --argjson rejected "$max_exec_rejected" \
  --argjson uncertain "$max_exec_uncertain" \
  --arg closureCoveragePct "$closure_pct" \
  --argjson pnUncertain "$l_pn_uncertain" \
  --argjson bkUncertain "$l_bk_uncertain" \
  --argjson hasExecutionEvidence "$has_exec" \
  --argjson closureCoverageOk "$closure_ok" \
  --argjson healthStable "$health_stable" \
  --argjson noPendingUncertainTickets "$no_pending_uncertain" \
  --argjson readyForPhase4 "$ready" \
  '
  {
    runId: $runId,
    start: $start,
    end: $end,
    samples: $samples,
    sourceCsv: $csv,
    health: {
      okSamples: $okSamples,
      okRatePct: $okRatePct,
      avgLatencySec: $avgHealthSec
    },
    opportunities: {
      avgPrematchCount: $avgPrematch,
      avgLiveCount: $avgLive
    },
    executionAudit: {
      observedExecutions: $observedExecutions,
      finalByStatus: $finalByStatus,
      finalByOutcome: $finalByOutcome,
      closureCoveragePct: (if $closureCoveragePct == "null" then null else ($closureCoveragePct | tonumber) end),
      confirmed: $confirmed,
      rejected: $rejected,
      uncertain: $uncertain
    },
    tickets: {
      pinnacleUncertain: $pnUncertain,
      bookyUncertain: $bkUncertain
    },
    gate: {
      hasExecutionEvidence: ($hasExecutionEvidence == 1),
      closureCoverageOk: ($closureCoverageOk == 1),
      healthStable: ($healthStable == 1),
      noPendingUncertainTickets: ($noPendingUncertainTickets == 1),
      readyForPhase4: ($readyForPhase4 == 1)
    }
  }
' > "$SUMMARY_JSON"

echo "[phase3-canary] completed runId=$RUN_ID"
echo "[phase3-canary] csv=$CSV_FILE"
echo "[phase3-canary] summary=$SUMMARY_JSON"
cat "$SUMMARY_JSON"
