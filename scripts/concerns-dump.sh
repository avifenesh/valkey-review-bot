#!/usr/bin/env bash
# Print concerns tables in a readable form, grouped by area_bucket and
# sorted by reinforcement count.
#
# Usage:
#   scripts/concerns-dump.sh --stack ValkeyReviewAgent --stack ValkeyGlideReviewAgent
#   scripts/concerns-dump.sh --table <concerns-table-name>
#
#   --stack NAME   a reviewer agent stack; its ConcernsTableName output is used
#   --table NAME   a concerns table, used as given
#
# Both options can be repeated and mixed; at least one is required.
#
# Needs the AWS CLI v2 and jq, and credentials allowed to call
# cloudformation:DescribeStacks (for --stack) and dynamodb:Scan on the
# tables, plus kms:Decrypt on the key the tables are encrypted with (the
# SubstrateKeyArn output of ValkeyReviewerSubstrate). The region comes
# from AWS_REGION or the CLI profile.
set -euo pipefail

. "$(dirname "$0")/lib/common.sh"

usage() {
  echo "usage: $0 [--stack REVIEWER_STACK]... [--table CONCERNS_TABLE]..." >&2
  exit "${1:-0}"
}

require_cmd aws jq

tables=""
while [ $# -gt 0 ]; do
  case "$1" in
    --stack)
      [ $# -ge 2 ] || die "--stack needs a stack name"
      table=$(stack_output "$2" ConcernsTableName)
      tables="$tables $table"
      shift 2
      ;;
    --table)
      [ $# -ge 2 ] || die "--table needs a table name"
      tables="$tables $2"
      shift 2
      ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage 1 ;;
  esac
done
[ -n "$tables" ] || usage 1

dump_table() {
  local table=$1
  echo "============================================================"
  echo "  table: $table"
  echo "============================================================"

  # The CLI follows scan pagination itself and returns every item.
  aws dynamodb scan --table-name "$table" --output json | jq -r '
    .Items as $items
    | "  records: \($items | length)"
    , ""
    , (
        $items
        | sort_by([.area_bucket.S, -((.reinforcement_count.N // "0") | tonumber)])
        | group_by(.area_bucket.S)
        | map(
            "--- bucket: " + .[0].area_bucket.S + " ---"
            , (
                .[]
                | "  * subject       : " + (.subject.S // "(none)")
                + "\n    record_id     : " + (.record_id.S // "(none)")
                + "\n    area          : " + ((.area.L // []) | map(.S) | join(", "))
                + "\n    reinforcement : " + (.reinforcement_count.N // "0")
                + " (distinct: " + ((.reinforcers.SS // []) | length | tostring) + ")"
                + "  decay: " + (.decay_score.N // "-")
                + "  updated: " + (.updated_at.S // "(none)")
                + (if .graduated_record_name.S then "\n    graduated as  : " + .graduated_record_name.S + " at " + (.graduated_at.S // "?") else "" end)
                + "\n    concern       : " + (.concern.S // "(none)")
                + "\n    context       : " + (if (.context.S // "") == "" then "(none)" else .context.S end)
                + "\n"
              )
          )
        | flatten
        | .[]
      )
  '
}

for table in $tables; do
  dump_table "$table"
  echo ""
done
