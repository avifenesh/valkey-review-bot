#!/usr/bin/env bash
# Print concerns tables in a readable form, grouped by area_bucket and
# sorted by reinforcement count. For graduated records it also prints
# the skill lifecycle: live or retired, the last fact check and its
# outcome, stale names, a maintenance request in flight, and the edits a
# check proposed but did not apply (pending_revision). This is where an
# operator reviews pending edits.
#
# Usage:
#   scripts/concerns-dump.sh --stack ValkeyReviewAgent --stack ValkeyGlideReviewAgent
#   scripts/concerns-dump.sh --table <concerns-table-name> [--region REGION]
#
#   --stack NAME     a reviewer agent stack; its ConcernsTableName output is used
#   --table NAME     a concerns table, used as given
#   --region REGION  the AWS region; default AWS_REGION or the CLI profile
#
# --stack and --table can be repeated and mixed; at least one is required.
# Items in buckets that start with '#' are skill-lifecycle state, not
# concern records: the repo skill.md check item is printed on its own and
# any other is only counted.
#
# Needs the AWS CLI v2 and jq, and credentials allowed to call
# cloudformation:DescribeStacks (for --stack) and dynamodb:Scan on the
# tables, plus kms:Decrypt on the key the tables are encrypted with (the
# SubstrateKeyArn output of ValkeyReviewerSubstrate).
set -euo pipefail

. "$(dirname "$0")/lib/common.sh"

usage() {
  echo "usage: $0 [--stack REVIEWER_STACK]... [--table CONCERNS_TABLE]... [--region REGION]" >&2
  exit "${1:-0}"
}

require_cmd aws jq

stacks=""
tables=""
while [ $# -gt 0 ]; do
  case "$1" in
    --stack)
      [ $# -ge 2 ] || die "--stack needs a stack name"
      stacks="$stacks $2"
      shift 2
      ;;
    --table)
      [ $# -ge 2 ] || die "--table needs a table name"
      tables="$tables $2"
      shift 2
      ;;
    --region)
      [ $# -ge 2 ] || die "--region needs a region"
      export AWS_REGION="$2"
      shift 2
      ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage 1 ;;
  esac
done
# After the loop, so --region applies wherever it was given.
for stack in $stacks; do
  tables="$tables $(stack_output "$stack" ConcernsTableName)"
done
[ -n "$tables" ] || usage 1

# Text from the table, some of it written by a model, is printed with
# control and bidirectional-override characters replaced by '?', so it
# cannot move the cursor or reorder the terminal's lines. One-line fields
# also have their line breaks turned into spaces.
JQ_PROGRAM='
def clean: gsub("\r"; "") | gsub("[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x{9f}\\x{2028}\\x{2029}\\x{202a}-\\x{202e}\\x{2066}-\\x{2069}]"; "?");
def line: gsub("\r?\n"; " ") | clean;
def opt($label; $value): if ($value // "") == "" then "" else "\n    " + $label + ": " + ($value | line) end;

def maintenance:
  if .maintenance_id.S or .maintenance_requested_at.S then
    "\n    maintenance   : " + ((.maintenance_reason.S // "?") | line)
    + " requested at " + ((.maintenance_requested_at.S // "?") | line)
    + " (" + ((.maintenance_id.S // "no id") | line) + ")"
  else "" end;

# Fact-check state, shared by graduated records and the repo item.
def checkstate:
  "\n    verified      : " + (
    if .verified_at.S then
      (if (.verified_release.S // "") == "" then "no release tag" else (.verified_release.S | line) end)
      + (if .verified_ref.S then ", " + (.verified_ref.S | line) else "" end)
      + " on " + (.verified_at.S | line)
    else "never" end)
  + (if .check_outcome.S then
      "\n    last check    : " + (.check_outcome.S | line) + (if .check_note.S then ": " + (.check_note.S | line) else "" end)
    else "" end)
  + (if ((.stale_names.SS // []) | length) > 0 then
      "\n    stale names   : " + ((.stale_names.SS | map(line)) | join(", "))
      + (if .stale_since.S then " (since " + (.stale_since.S | line) + ")" else "" end)
    else "" end);

# An edit the check proposed: its evidence, then the piece it suppresses
# (-) and the replacement (+). Old records may hold find/replace/path/line.
def edit($n):
  . as $e
  | "\n      edit " + ($n | tostring) + ", evidence: " + (
      (($e.evidence.L // []) | map(.S // "" | line)) as $ev
      | if ($ev | length) > 0 then ($ev | join(", "))
        elif $e.path.S then ($e.path.S | line) + ":" + ($e.line.N // $e.line.S // "?")
        else "(none)" end)
    + ((($e.original.S // $e.find.S // "") | clean | rtrimstr("\n") | split("\n")) | map("\n        - " + .) | join(""))
    + ((($e.replacement.S // $e.replace.S // "") | clean | rtrimstr("\n") | split("\n")) | map("\n        + " + .) | join(""));

def pending:
  .pending_revision.M as $p
  | if $p == null then "" else
      "\n    pending edit  : " + (($p.verdict.S // "?") | line) + " at " + (($p.at.S // "?") | line)
      + (if $p.reason.S then " (" + ($p.reason.S | line) + ")" else "" end)
      + opt("  summary     "; $p.summary.S)
      + (($p.edits.L // []) | to_entries | map(.key as $i | .value.M | edit($i + 1)) | join(""))
    end;

def lifecycle:
  if .graduated_record_name.S then
    "\n    graduated as  : " + (.graduated_record_name.S | line) + " at " + ((.graduated_at.S // "?") | line)
    + (if .skill_generation.N then " (generation " + .skill_generation.N + ")" else "" end)
    + "\n    skill state   : " + (
        if .retired_at.S then
          "retired (" + ((.retired_reason.S // "?") | line) + ") at " + (.retired_at.S | line)
          + (if .retired_from_status.S then ", registry status was " + (.retired_from_status.S | line) else "" end)
        else "live" end)
    + checkstate
    + opt("obsolete at   "; .obsolete_release.S)
    + (if .revised_at.S then "\n    revised at    : " + (.revised_at.S | line) + " (the text before it is kept in previous_skill_md)" else "" end)
    + maintenance
    + pending
  else "" end;

def repo_item:
  "--- repo skill.md check (" + ((.area_bucket.S // "") | line) + " " + ((.record_id.S // "") | line) + ") ---"
  + checkstate + maintenance + pending + "\n";

.Items as $all
| ($all | map(select((.area_bucket.S // "") | startswith("#") | not))) as $items
| ($all | map(select((.area_bucket.S // "") | startswith("#")))) as $reserved
| ($reserved | map(select(.area_bucket.S == "#maintenance" and .record_id.S == "repo-skill"))) as $repo
| "  records: \($items | length)"
, (if ($reserved | length) > ($repo | length)
   then "  not shown: \(($reserved | length) - ($repo | length)) item(s) in buckets that start with #, which are not concern records"
   else empty end)
, ""
, ($repo[] | repo_item)
, (
    $items
    | sort_by([.area_bucket.S, -((.reinforcement_count.N // "0") | tonumber)])
    | group_by(.area_bucket.S)
    | map(
        "--- bucket: " + ((.[0].area_bucket.S // "(none)") | line) + " ---"
        , (
            .[]
            | "  * subject       : " + ((.subject.S // "(none)") | line)
            + "\n    record_id     : " + ((.record_id.S // "(none)") | line)
            + "\n    area          : " + ((.area.L // []) | map(.S // "" | line) | join(", "))
            + "\n    reinforcement : " + (.reinforcement_count.N // "0")
            + " (distinct: " + ((.reinforcers.SS // []) | length | tostring) + ")"
            + "  decay: " + (.decay_score.N // "-")
            + "  updated: " + ((.updated_at.S // "(none)") | line)
            + lifecycle
            + "\n    concern       : " + ((.concern.S // "(none)") | clean)
            + "\n    context       : " + (if (.context.S // "") == "" then "(none)" else (.context.S | clean) end)
            + "\n"
          )
      )
    | flatten
    | .[]
  )
'

dump_table() {
  local table=$1
  echo "============================================================"
  echo "  table: $table"
  echo "============================================================"

  # The CLI follows scan pagination itself and returns every item.
  aws dynamodb scan --table-name "$table" --output json | jq -r "$JQ_PROGRAM"
}

for table in $tables; do
  dump_table "$table"
  echo ""
done
