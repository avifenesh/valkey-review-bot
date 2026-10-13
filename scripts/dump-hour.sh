#!/usr/bin/env bash
# Summarize the last N minutes of webhook receiver and curator worker
# logs: deliveries by event, repo, decision and actor, and curator
# outcomes.
#
# Usage:
#   scripts/dump-hour.sh --stack ValkeyReviewWebhook             # last 60 minutes
#   scripts/dump-hour.sh --stack ValkeyReviewWebhook --minutes 30
#   scripts/dump-hour.sh --stack ValkeyReviewWebhook --raw       # also print raw delivery lines
#
#   --stack NAME   the webhook stack; its receiver (ReceiverFn) and curator
#                  worker (CuratorWorkerFn) functions are looked up in it
#
# Log text is printed without control or format characters (see
# printable_lines in lib/common.sh): the curator's lines can carry text a
# model wrote.
#
# Needs the AWS CLI v2, jq, and credentials allowed to call
# cloudformation:ListStackResources and lambda:GetFunctionConfiguration
# and to read the functions' log groups. The region comes from
# AWS_REGION or the CLI profile.
set -euo pipefail

. "$(dirname "$0")/lib/common.sh"

usage() {
  echo "usage: $0 --stack WEBHOOK_STACK [--minutes N] [--raw]" >&2
  exit "${1:-0}"
}

require_cmd aws jq

STACK=""
MINUTES=60
RAW=false
while [ $# -gt 0 ]; do
  case "$1" in
    --stack) [ $# -ge 2 ] || die "--stack needs a stack name"; STACK=$2; shift 2 ;;
    --minutes) [ $# -ge 2 ] || die "--minutes needs a number"; MINUTES=$2; shift 2 ;;
    --raw) RAW=true; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage 1 ;;
  esac
done
[ -n "$STACK" ] || usage 1
case "$MINUTES" in
  ''|*[!0-9]*) die "--minutes must be a whole number of minutes" ;;
esac

RECEIVER_FN=$(stack_function "$STACK" ReceiverFn)
CURATOR_FN=$(stack_function "$STACK" CuratorWorkerFn)
RECEIVER_LG=$(function_log_group "$RECEIVER_FN")
CURATOR_LG=$(function_log_group "$CURATOR_FN")

echo "=== window: last ${MINUTES} minutes ==="
echo "receiver log group: $RECEIVER_LG"
echo "curator log group:  $CURATOR_LG"
echo ""

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

count_lines() {
  wc -l < "$1" | tr -d ' '
}

# grep exits 1 when nothing matches; that is an empty result here, not an error.
matching() {
  grep -E "$1" "$2" || true
}

echo "fetching receiver logs..."
aws logs tail "$RECEIVER_LG" --since "${MINUTES}m" --format short | printable_lines > "$WORK/receiver.log"
matching '\[delivery\]' "$WORK/receiver.log" > "$WORK/deliveries.txt"
DELIVERIES=$(count_lines "$WORK/deliveries.txt")
echo "deliveries observed: $DELIVERIES"
echo ""

if [ "$DELIVERIES" -eq 0 ]; then
  echo "no deliveries in the window."
  exit 0
fi

# Count the values of one key=value field across the delivery lines.
tally() {
  awk -v key="$1=" '{
    for (i = 1; i <= NF; i++) if (index($i, key) == 1) print substr($i, length(key) + 1)
  }' "$WORK/deliveries.txt" | sort | uniq -c | sort -rn | head -"${2:-50}"
}

echo "=== by event type ==="
tally event
echo ""
echo "=== by repo ==="
tally repo
echo ""
echo "=== by decision ==="
tally decision
echo ""
echo "=== actors ==="
tally actor 20
echo ""

echo "=== repo x decision ==="
awk '{
  repo = "-"; dec = "-";
  for (i = 1; i <= NF; i++) {
    if (index($i, "repo=") == 1) repo = substr($i, 6);
    if (index($i, "decision=") == 1) dec = substr($i, 10);
  }
  print repo "\t" dec;
}' "$WORK/deliveries.txt" | sort | uniq -c | sort -rn | head -30
echo ""

echo "fetching curator worker logs..."
aws logs tail "$CURATOR_LG" --since "${MINUTES}m" --format short | printable_lines > "$WORK/curator.log"
matching '\[invoke\]|\[done\]|\[fail\]' "$WORK/curator.log" > "$WORK/curator.txt"
echo "curator invocations: $(matching '\[invoke\]' "$WORK/curator.txt" | wc -l | tr -d ' ')"
echo "curator completions: $(matching '\[done\]' "$WORK/curator.txt" | wc -l | tr -d ' ')"
echo "curator failures:    $(matching '\[fail\]' "$WORK/curator.txt" | wc -l | tr -d ' ')"
echo ""

if grep -q '\[done\]' "$WORK/curator.txt"; then
  echo "=== curator decisions ==="
  matching '\[done\]' "$WORK/curator.txt" | grep -oE 'terminal=[^ ]+' | sort | uniq -c | sort -rn || true
  echo ""
fi

if [ "$RAW" = true ]; then
  echo "=== raw delivery lines (last 40) ==="
  tail -40 "$WORK/deliveries.txt"
  echo ""
fi

echo "=== summary ==="
echo "  total deliveries:              $DELIVERIES"
echo "  enqueued:                      $(matching 'decision=enqueued' "$WORK/deliveries.txt" | wc -l | tr -d ' ')"
echo "  dropped as noise:              $(matching 'decision=skipped:noise:' "$WORK/deliveries.txt" | wc -l | tr -d ' ')"
echo "  dropped as unrouted repo:      $(matching 'decision=skipped:unrouted-repo' "$WORK/deliveries.txt" | wc -l | tr -d ' ')"
echo "  dropped as not feedback/event: $(matching 'decision=skipped:(not-feedback|event=)' "$WORK/deliveries.txt" | wc -l | tr -d ' ')"
