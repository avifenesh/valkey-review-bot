#!/usr/bin/env node
// Queue a fact check of a reviewer's graduated skills now, on the
// curator queue, in report mode unless --apply is given. The daily decay
// job queues the same checks on its own when they are due.
//
// Usage:
//   node scripts/skill-check.mjs (--stack REVIEWER_STACK | --table CONCERNS_TABLE)
//        (--webhook-stack WEBHOOK_STACK | --queue-url URL) [--name SKILL_NAME]
//        [--release TAG] [--reviewer ID] [--apply] [--plan] [--region REGION]
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
//   --apply          send dry_run: false (see below)
//   --plan           print the checks it would queue; write and send nothing
//
// Each live graduated record (or the one that graduated as --name) is
// claimed the way the decay job claims it (maintenance_id,
// maintenance_requested_at and maintenance_reason on the record) and gets
// one check message, 60 seconds after the previous one (at most 900), so
// the checks do not hold up maintainer feedback on the shared queue. A
// record with a maintenance request younger than 7 days is skipped, as
// is a retired skill's record.
//
// Report mode (the default): the messages carry dry_run: true. The
// curator runs each check and records and logs its outcome, but makes no
// registry change and opens no pull request, whatever its own settings
// say. --apply sends dry_run: false; the curator's skillLifecycle
// settings (applyEdits, openPullRequests) still decide what it may
// change.
//
// Outcomes: the curator's [maintenance] log lines, and
// scripts/concerns-dump.sh (check_outcome, check_note, stale names and
// pending edits).
//
// Needs Node 24 or later, the AWS CLI v2, and credentials allowed to call
// cloudformation:DescribeStacks (for the stack options), dynamodb:Scan and
// dynamodb:UpdateItem on the concerns table, use of the KMS key it is
// encrypted with (the SubstrateKeyArn output of ValkeyReviewerSubstrate),
// and sqs:SendMessage on the curator queue.

import { parseArgs } from 'node:util';
import { RELEASE_TAG_RE } from '../ops/src/releases.ts';
import { awsRunner, quoted, stackOutputs } from './lib/aws-cli.mjs';
import { queueChecks, REVIEWER_ID_RE } from './lib/check-queue.mjs';
import { reviewerIdOfTable } from './lib/skill-records.mjs';

const USAGE = [
  'usage: node scripts/skill-check.mjs (--stack REVIEWER_STACK | --table CONCERNS_TABLE)',
  '         (--webhook-stack WEBHOOK_STACK | --queue-url URL) [--name SKILL_NAME]',
  '         [--release TAG] [--reviewer ID] [--apply] [--plan] [--region REGION]',
].join('\n');

function fail(message) {
  console.error(`error: ${message}`);
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
if (values.plan) console.log('plan only: nothing is claimed or sent');

let result;
try {
  result = queueChecks({ aws, table, queueUrl, reviewerId, name: values.name, releaseTag, dryRun, plan: values.plan, nowMs: Date.now() });
} catch (err) {
  fail(err.message);
}
const verb = values.plan ? 'would queue' : 'queued';
console.log(`${verb} ${result.queued} check(s) on the curator queue; skipped ${result.skipped}; errors ${result.errors}`);
if (result.queued > 0 && !values.plan) {
  console.log('Outcomes: the curator\'s [maintenance] log lines, and scripts/concerns-dump.sh once the checks have run.');
}
if (result.errors > 0) process.exit(1);
