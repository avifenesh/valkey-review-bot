#!/usr/bin/env node
// Queue a fact check of a reviewer's graduated skills now, on the
// curator queue, in report mode unless --apply is given. The daily decay
// job queues the same checks on its own when they are due.
//
// Usage:
//   node scripts/skill-check.mjs (--stack REVIEWER_STACK | --table CONCERNS_TABLE)
//        (--webhook-stack WEBHOOK_STACK | --queue-url URL) [--name SKILL_NAME]
//        [--release TAG] [--reviewer ID] [--limit N] [--apply] [--plan] [--region REGION]
//
//   --stack          a reviewer agent stack; its ConcernsTableName output is used
//   --table          a concerns table, used as given
//   --webhook-stack  the webhook stack; its CuratorQueueUrl output is used
//   --queue-url      the curator queue, used as given
//   --name           check only the skill with this registry name
//   --release        the upstream GA release the check is for, such as 9.1.2.
//                    The decay job's [release] log line shows the current one.
//                    Without it the curator labels any edit with the commit it
//                    checked (<branch>@<12-char sha>), and after an --apply
//                    check the next scheduled pass checks the skill again.
//   --reviewer       the reviewer id, for a table whose name does not give it;
//                    valkey_review_concerns is valkey-review's table
//   --limit          queue at most N checks (default 10). The default is the
//                    decay job's code default for SKILL_CHECKS_PER_DAY, not
//                    the deployed skillLifecycle.checksPerDay, and these
//                    checks come on top of that day's decay checks. If
//                    checksPerDay is set lower to spare the queue, pass
//                    that or less.
//   --apply          send dry_run: false (see below)
//   --plan           print the checks it would queue; write and send nothing
//
// Run it only once the curator that handles maintenance messages is
// deployed. An older curator rejects them, so they go to its dead-letter
// queue, and each record it claimed gets no decay check or retirement for
// 7 days. Stopping the script between a claim and its send does the same
// to that record.
//
// The live graduated records (or the one that graduated as --name) are
// taken in the decay job's order: never checked first, then re-published
// since their last check, then the oldest check. Up to --limit of them are
// claimed the way the decay job claims them (maintenance_id,
// maintenance_requested_at and maintenance_reason on the record), and
// each gets one check message, 60 seconds after the previous one. SQS
// delays a message by at most 900 seconds, so with --limit above 16 the
// rest arrive together. Checks share the curator queue with maintainer
// feedback, and an audit can take up to 12 minutes, so a large --limit
// makes feedback wait. A record with a maintenance request younger than
// 7 days is skipped, as is a retired skill's record.
//
// The records past --limit are listed as over the limit. The ones this
// run claimed count as in flight until the curator has run them, so a
// second run before that queues the next --limit on top of these. Once
// they have run, an --apply run starts with the ones left over; a
// report-mode run starts with the same records again (see below).
//
// Report mode (the default): the messages carry dry_run: true. The
// curator runs each check and logs its outcome. It stores only an
// audit's pending edit (pending_revision, reason "dry run"): it writes no
// check_outcome, check_note or names, makes no registry change and opens
// no pull request, whatever its own settings say. A report-mode check
// advances no record, so the next run starts with the same records: use
// --name for one skill, or a larger --limit. --apply sends dry_run:
// false; the curator's skillLifecycle settings (applyEdits,
// openPullRequests) still decide what it may change.
//
// Outcomes: the curator's [maintenance] log lines, and
// scripts/concerns-dump.sh: pending edits after either mode, and
// check_outcome, check_note and stale names only after --apply checks.
//
// Needs Node 24 or later, the AWS CLI v2, and credentials allowed to call
// cloudformation:DescribeStacks (for the stack options), dynamodb:Scan and
// dynamodb:UpdateItem on the concerns table, use of the KMS key it is
// encrypted with (the SubstrateKeyArn output of ValkeyReviewerSubstrate),
// and sqs:SendMessage on the curator queue.

import { parseArgs } from 'node:util';
import { RELEASE_TAG_RE } from '../ops/src/releases.ts';
import { awsRunner, quoted, stackOutputs } from './lib/aws-cli.mjs';
import { DEFAULT_CHECK_LIMIT, queueChecks, REVIEWER_ID_RE } from './lib/check-queue.mjs';
import { reviewerIdOfTable } from './lib/skill-records.mjs';
import { printable } from './lib/text.mjs';

const USAGE = [
  'usage: node scripts/skill-check.mjs (--stack REVIEWER_STACK | --table CONCERNS_TABLE)',
  '         (--webhook-stack WEBHOOK_STACK | --queue-url URL) [--name SKILL_NAME]',
  '         [--release TAG] [--reviewer ID] [--limit N] [--apply] [--plan] [--region REGION]',
].join('\n');

function fail(message) {
  console.error(`error: ${printable(message, { multiline: true })}`);
  process.exit(1);
}

let values;
try {
  ({ values } = parseArgs({
    options: {
      stack: { type: 'string' },
      table: { type: 'string' },
      'webhook-stack': { type: 'string' },
      'queue-url': { type: 'string' },
      name: { type: 'string' },
      release: { type: 'string' },
      reviewer: { type: 'string' },
      limit: { type: 'string' },
      apply: { type: 'boolean', default: false },
      plan: { type: 'boolean', default: false },
      region: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (err) {
  fail(`${err.message}\n${USAGE}`);
}
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!values.stack === !values.table) fail(`pass exactly one of --stack or --table\n${USAGE}`);
if (!values['webhook-stack'] === !values['queue-url']) fail(`pass exactly one of --webhook-stack or --queue-url\n${USAGE}`);
const releaseTag = values.release ?? '';
if (releaseTag && !RELEASE_TAG_RE.test(releaseTag)) fail(`--release must be a GA tag such as 9.1.2 or v2.5.3, got ${quoted(releaseTag)}`);
if (values.name !== undefined && !/^[a-z0-9][a-z0-9-]{0,99}$/.test(values.name)) fail('--name must be a registry record name: lowercase letters, digits and hyphens');
if (values.limit !== undefined && !/^[1-9][0-9]{0,5}$/.test(values.limit)) fail(`--limit must be a whole number of at least 1, got ${quoted(values.limit)}`);
const limit = values.limit === undefined ? DEFAULT_CHECK_LIMIT : Number(values.limit);

const aws = awsRunner(values.region);
function output(stack, key) {
  let outputs;
  try {
    outputs = stackOutputs(aws, stack);
  } catch (err) {
    fail(`could not read the outputs of stack ${stack}: ${err.message}`);
  }
  return outputs.get(key) ?? fail(`stack ${stack} has no output ${key}`);
}

const table = values.table ?? output(values.stack, 'ConcernsTableName');
const queueUrl = values['queue-url'] ?? output(values['webhook-stack'], 'CuratorQueueUrl');
if (!/^https:\/\/\S+$/.test(queueUrl)) fail(`the curator queue URL must be an https:// SQS URL, got ${quoted(queueUrl)}`);
const tableReviewer = reviewerIdOfTable(table);
// The curator finds the record through reviewer_id, so a mismatch would only make every check a no-op.
if (values.reviewer && tableReviewer && values.reviewer !== tableReviewer) fail(`table ${table} belongs to reviewer ${tableReviewer}, not ${quoted(values.reviewer)}`);
const reviewerId = values.reviewer ?? tableReviewer ?? fail(`cannot tell the reviewer id from table ${quoted(table)}; pass --reviewer`);
if (!REVIEWER_ID_RE.test(reviewerId)) fail(`--reviewer must be a reviewer id such as valkey-review, got ${quoted(reviewerId)}`);
const dryRun = !values.apply;

console.log(`reviewer ${reviewerId}, table ${table}, release ${releaseTag || 'none (labels use the checked commit)'}`);
console.log(dryRun
  ? 'report mode: dry_run=true, so the curator makes no registry change and opens no pull request; --apply sends dry_run=false'
  : 'apply mode: dry_run=false, so the curator acts as its skillLifecycle settings allow');
console.log(`limit: at most ${limit} check(s), 60 seconds apart${limit > 16 ? '; past the 16th they arrive together, at the 900-second SQS maximum' : ''}`
  + (values.limit === undefined ? `; ${limit} is the decay job's code default, not the deployed skillLifecycle.checksPerDay` : ''));
if (values.plan) console.log('plan only: nothing is claimed or sent');

let result;
try {
  result = queueChecks({ aws, table, queueUrl, reviewerId, name: values.name, releaseTag, dryRun, plan: values.plan, nowMs: Date.now(), limit });
} catch (err) {
  fail(err.message);
}
const verb = values.plan ? 'would queue' : 'queued';
console.log(`${verb} ${result.queued} check(s) on the curator queue; skipped ${result.skipped}; errors ${result.errors}`);
if (result.deferred > 0) {
  console.log(`${result.deferred} more over --limit ${limit}. ${dryRun
    ? 'A report-mode check advances no record, so a new run starts with the same ones: use --name or a larger --limit.'
    : 'Run again for them once these checks have run; before that, a new run queues the next ones on top of these.'}`);
}
if (result.queued > 0 && !values.plan) {
  console.log(dryRun
    ? 'Outcomes: the curator\'s [maintenance] log lines. A report-mode check stores only an audit\'s pending edit, which scripts/concerns-dump.sh shows once the checks have run; it writes no check_outcome or check_note.'
    : 'Outcomes: the curator\'s [maintenance] log lines, and scripts/concerns-dump.sh (check_outcome, check_note, stale names and pending edits) once the checks have run.');
}
if (result.errors > 0) process.exit(1);
