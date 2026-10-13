import assert from 'node:assert/strict';
import test from 'node:test';
import '../../ops/test/support/ts-resolve.mjs';
import {
  checkDelay, checkMessage, claimArgs, MAINTENANCE_RETRY_DAYS, maintenanceId, planChecks, queueChecks, releaseArgs, sendArgs,
} from '../lib/check-queue.mjs';
import { CONDITION_FAILED, cliError, fakeAws, flag, typed } from './support/aws.mjs';

// The decay pass is the other producer of check messages; the curator
// accepts what it sends, so this must send the same. Needs `npm ci` in ops.
const decay = await import('../../ops/src/decay.ts');

const DAY_MS = 24 * 3600 * 1000;
const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();
const daysAgo = (n) => new Date(NOW - n * DAY_MS).toISOString();
const QUEUE = 'https://sqs.us-east-1.amazonaws.com/123456789012/curator';

/** A live graduated record, never checked. */
const live = (recordId, fields = {}) => ({
  area_bucket: 'src',
  record_id: recordId,
  graduated_record_name: `skill-${recordId}`,
  graduated_at: daysAgo(30),
  decay_score: 1,
  updated_at: daysAgo(5),
  ...fields,
});

/** What the decay pass sends and claims for `items`, at NOW. */
async function decayRequests(items, { dryRun = false, releaseTag = '9.1.2' } = {}) {
  const writes = [];
  const sent = [];
  const ddb = {
    async send(command) {
      if (command.constructor.name === 'ScanCommand') return { Items: items };
      writes.push(command.input);
      return {};
    },
  };
  const sqs = { async send(command) { sent.push(command.input); return {}; } };
  const config = decay.loadDecayConfig({
    CONCERNS_TABLES_JSON: '{"valkey-review":"valkey_review_concerns"}',
    UPSTREAM_REPOS_JSON: '{"valkey-review":"valkey-io/valkey"}',
    CURATOR_QUEUE_URL: QUEUE,
  });
  const log = console.log;
  console.log = () => {};
  try {
    await decay.decayTable(ddb, 'valkey_review_concerns', config, NOW, { reviewerId: 'valkey-review', releaseTag, recheckAll: false, dryRun, sqs });
  } finally {
    console.log = log;
  }
  return { writes, sent };
}

// Checked at the release, so the pass queues no repo skill.md check ahead of the records.
const REPO_ITEM = { area_bucket: '#maintenance', record_id: 'repo-skill', verified_release: '9.1.2', verified_at: daysAgo(1) };

test('a check message is the one the decay pass sends: body, attributes and delays', async () => {
  const records = [live('r1'), live('r2'), live('r3')];
  for (const dryRun of [true, false]) {
    const { sent } = await decayRequests([REPO_ITEM, ...records], { dryRun });
    assert.equal(sent.length, 3);
    const { checks } = planChecks(records, { reviewerId: 'valkey-review', nowMs: NOW });
    checks.forEach((check, i) => {
      const id = maintenanceId('valkey-review', check.key.record_id, NOW_ISO);
      const body = checkMessage({ id, reviewerId: 'valkey-review', check, releaseTag: '9.1.2', dryRun });
      assert.deepEqual(body, JSON.parse(sent[i].MessageBody), `body ${i} dry_run=${dryRun}`);
      const args = sendArgs(QUEUE, body, checkDelay(i));
      assert.equal(flag(args, '--queue-url'), sent[i].QueueUrl);
      assert.deepEqual(JSON.parse(flag(args, '--message-body')), JSON.parse(sent[i].MessageBody));
      assert.equal(Number(flag(args, '--delay-seconds')), sent[i].DelaySeconds, `delay ${i}`);
      assert.deepEqual(JSON.parse(flag(args, '--message-attributes')), sent[i].MessageAttributes);
    });
  }
  assert.deepEqual([0, 1, 2, 15, 16, 40].map(checkDelay), [0, 60, 120, 900, 900, 900]);
});

test('the claim sets the maintenance attributes the decay pass sets, and nothing else', async () => {
  const record = live('r1');
  const { writes } = await decayRequests([REPO_ITEM, record]);
  const decayClaim = writes.find((w) => w.UpdateExpression.includes('#mid = :mid'));
  const [check] = planChecks([record], { reviewerId: 'valkey-review', nowMs: NOW }).checks;
  const args = claimArgs('valkey_review_concerns', check, maintenanceId('valkey-review', 'r1', NOW_ISO), NOW_ISO);
  const names = JSON.parse(flag(args, '--expression-attribute-names'));
  const values = JSON.parse(flag(args, '--expression-attribute-values'));
  assert.equal(flag(args, '--update-expression'), 'SET #mid = :mid, #mra = :now, #mr = :mr');
  for (const p of ['#mid', '#mra', '#mr']) assert.equal(names[p], decayClaim.ExpressionAttributeNames[p], p);
  assert.equal(values[':mid'].S, decayClaim.ExpressionAttributeValues[':mid']);
  assert.equal(values[':now'].S, decayClaim.ExpressionAttributeValues[':now']);
  assert.equal(values[':mr'].S, decayClaim.ExpressionAttributeValues[':mr']);
  assert.deepEqual(JSON.parse(flag(args, '--key')), { area_bucket: { S: 'src' }, record_id: { S: 'r1' } });
  assert.equal(MAINTENANCE_RETRY_DAYS, decay.MAINTENANCE_RETRY_DAYS);
});

test('the claim holds only while the record is live under its name, unchanged and not claimed since', () => {
  const [fresh, again] = planChecks([live('a'), live('b', { maintenance_requested_at: daysAgo(8) })], { reviewerId: 'valkey-review', nowMs: NOW }).checks;
  const condition = (check) => {
    const args = claimArgs('t', check, 'id', NOW_ISO);
    return { expr: flag(args, '--condition-expression'), values: JSON.parse(flag(args, '--expression-attribute-values')) };
  };
  const a = condition(fresh);
  assert.equal(a.expr, '#grn = :grn AND attribute_not_exists(#ret) AND #ua = :ua AND attribute_not_exists(#mra)');
  assert.deepEqual([a.values[':grn'], a.values[':ua']], [{ S: 'skill-a' }, { S: daysAgo(5) }]);
  const b = condition(again);
  assert.equal(b.expr, '#grn = :grn AND attribute_not_exists(#ret) AND #ua = :ua AND #mra = :mra');
  assert.deepEqual(b.values[':mra'], { S: daysAgo(8) });
  const release = releaseArgs('t', fresh.key, 'id');
  assert.equal(flag(release, '--update-expression'), 'REMOVE #mid, #mra, #mr');
  assert.equal(flag(release, '--condition-expression'), '#mid = :mid');
});

test('planChecks picks live graduated records and says why it skips the rest', () => {
  const items = [
    live('due'),
    live('old-claim', { maintenance_requested_at: daysAgo(MAINTENANCE_RETRY_DAYS + 1), maintenance_reason: 'check' }),
    live('in-flight', { maintenance_requested_at: daysAgo(MAINTENANCE_RETRY_DAYS - 1), maintenance_reason: 'retire' }),
    live('tomb', { retired_at: daysAgo(3) }),
    live('bad-name', { graduated_record_name: 'Not A Name' }),
    live('no-update', { updated_at: undefined }),
    { area_bucket: 'src', record_id: 'plain', updated_at: daysAgo(1) },
    { area_bucket: '#maintenance', record_id: 'repo-skill', graduated_record_name: 'skill-x', updated_at: daysAgo(1) },
    live('x'.repeat(101), { graduated_record_name: 'long-id' }),
  ];
  const { checks, skipped, matched } = planChecks(items, { reviewerId: 'valkey-review', nowMs: NOW });
  assert.deepEqual(checks.map((c) => c.key.record_id), ['due', 'old-claim']);
  assert.deepEqual(checks[1].requestedAt, daysAgo(MAINTENANCE_RETRY_DAYS + 1));
  const why = Object.fromEntries(skipped.map((s) => [s.key.record_id.slice(0, 12), s.reason]));
  assert.match(why['in-flight'], /^in flight: "retire" requested at ".*"; a new request is allowed 7 days after it$/);
  assert.match(why.tomb, /retired/);
  assert.match(why['bad-name'], /not a registry record name/);
  assert.match(why['no-update'], /no updated_at/);
  assert.match(why.xxxxxxxxxxxx, /too long/);
  assert.equal(matched, 7, 'reserved buckets and records that never graduated are not counted');

  const one = planChecks(items, { reviewerId: 'valkey-review', name: 'skill-tomb', nowMs: NOW });
  assert.deepEqual([one.checks.length, one.skipped.length, one.matched], [0, 1, 1]);
  assert.equal(planChecks(items, { reviewerId: 'valkey-review', name: 'skill-x', nowMs: NOW }).matched, 0, 'never a reserved item');
});

/** A fake CLI holding `items` in the concerns table. */
function cliWith(items, overrides = {}) {
  return fakeAws({
    'dynamodb scan': () => ({ Items: items.map((i) => typed(i)) }),
    'dynamodb update-item': () => ({}),
    'sqs send-message': () => ({ MessageId: 'm' }),
    ...overrides,
  });
}
const ops = (aws) => aws.calls.map((a) => `${a[1]}${a[1] === 'update-item' ? ` ${flag(a, '--update-expression').split(' ')[0]}` : ''}`);
const run = (aws, fields = {}) => {
  const lines = [];
  const result = queueChecks({
    aws, table: 'valkey_review_concerns', queueUrl: QUEUE, reviewerId: 'valkey-review', releaseTag: '9.1.2', dryRun: true,
    plan: false, nowMs: NOW, log: (l) => lines.push(l), ...fields,
  });
  return { result, lines };
};

test('queueChecks claims each record before sending its message, in report mode', () => {
  const aws = cliWith([live('b'), live('a'), live('tomb', { retired_at: daysAgo(1) })]);
  const { result, lines } = run(aws);
  assert.deepEqual(result, { queued: 2, skipped: 1, errors: 0 });
  assert.deepEqual(ops(aws), ['scan', 'update-item SET', 'send-message', 'update-item SET', 'send-message']);
  const scan = aws.calls[0];
  assert.equal(flag(scan, '--filter-expression'), 'attribute_exists(#grn)');
  const sends = aws.calls.filter((a) => a[1] === 'send-message');
  const bodies = sends.map((a) => JSON.parse(flag(a, '--message-body')));
  assert.deepEqual(bodies.map((b) => [b.record_id, b.dry_run, b.release_tag]), [['a', true, '9.1.2'], ['b', true, '9.1.2']]);
  assert.deepEqual(sends.map((a) => flag(a, '--delay-seconds')), ['0', '60']);
  assert.ok(lines.some((l) => l === `queued bucket="src" id="a" name="skill-a" delay=0s maintenance="check#valkey-review#a#${NOW_ISO}"`));
  assert.ok(lines.some((l) => l.startsWith('skipped bucket="src" id="tomb"')));
});

test('--apply sends dry_run false; a missing release sends an empty tag', () => {
  const aws = cliWith([live('a')]);
  run(aws, { dryRun: false, releaseTag: '' });
  const body = JSON.parse(flag(aws.calls.find((a) => a[1] === 'send-message'), '--message-body'));
  assert.equal(body.dry_run, false);
  assert.equal(body.release_tag, '');
});

test('a record that changed since the scan is skipped and gets no message', () => {
  const aws = cliWith([live('a'), live('b')], {
    'dynamodb update-item': (args) => {
      if (JSON.parse(flag(args, '--key')).record_id.S === 'a') throw cliError(args, CONDITION_FAILED);
      return {};
    },
  });
  const { result, lines } = run(aws);
  assert.deepEqual(result, { queued: 1, skipped: 1, errors: 0 });
  const sends = aws.calls.filter((a) => a[1] === 'send-message');
  assert.deepEqual(sends.map((a) => JSON.parse(flag(a, '--message-body')).record_id), ['b']);
  assert.equal(flag(sends[0], '--delay-seconds'), '0', 'only claims made count toward the stagger');
  assert.ok(lines.some((l) => /^skipped bucket="src" id="a" .*changed since it was read/.test(l)));
});

test('a failed claim is an error; a failed send is an error and releases the claim', () => {
  const aws = cliWith([live('a'), live('b')], {
    'dynamodb update-item': (args) => {
      if (JSON.parse(flag(args, '--key')).record_id.S === 'a') throw cliError(args, 'An error occurred (AccessDeniedException)');
      return {};
    },
    'sqs send-message': (args) => { throw cliError(args, 'An error occurred (AWS.SimpleQueueService.NonExistentQueue)'); },
  });
  const { result, lines } = run(aws);
  assert.deepEqual(result, { queued: 0, skipped: 0, errors: 2 });
  assert.deepEqual(ops(aws), ['scan', 'update-item SET', 'update-item SET', 'send-message', 'update-item REMOVE']);
  const release = aws.calls.at(-1);
  assert.deepEqual(JSON.parse(flag(release, '--expression-attribute-values')), { ':mid': { S: `check#valkey-review#b#${NOW_ISO}` } });
  assert.ok(lines.some((l) => /^error bucket="src" id="a" .*claim failed/.test(l)));
  assert.ok(lines.some((l) => /^error bucket="src" id="b" .*send failed/.test(l)));
});

test('plan mode writes and sends nothing', () => {
  const aws = cliWith([live('a'), live('b')]);
  const { result, lines } = run(aws, { plan: true });
  assert.deepEqual(result, { queued: 2, skipped: 0, errors: 0 });
  assert.deepEqual(ops(aws), ['scan']);
  assert.deepEqual(lines, ['would queue bucket="src" id="a" name="skill-a" delay=0s', 'would queue bucket="src" id="b" name="skill-b" delay=60s']);
});

test('one named skill: only its record; an unknown name is an error', () => {
  const aws = cliWith([live('a'), live('b')]);
  const { result } = run(aws, { name: 'skill-b' });
  assert.equal(result.queued, 1);
  assert.deepEqual(aws.calls.filter((a) => a[1] === 'send-message').map((a) => JSON.parse(flag(a, '--message-body')).record_name), ['skill-b']);
  assert.throws(() => run(cliWith([live('a')]), { name: 'skill-zzz' }), /no concern record in valkey_review_concerns graduated as "skill-zzz"/);
});

test('values from the table are quoted in every line', () => {
  const aws = cliWith([live('in-flight', { area_bucket: 'src\n[decay] fake', maintenance_requested_at: daysAgo(1), maintenance_reason: 'x\u202e' })]);
  const { lines } = run(aws);
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes('\n') && !lines[0].includes('\u202e'));
  assert.match(lines[0], /bucket="src\\n\[decay\] fake"/);
});

test('AWS error text in a line is printable and stays on the line', () => {
  const aws = cliWith([live('a')], {
    'sqs send-message': (args) => { throw cliError(args, 'An error occurred\n\u001b[2Jerror bucket="src" id="b": forged\u202e'); },
  });
  const { lines } = run(aws);
  const sendLine = lines.find((l) => l.includes('send failed'));
  assert.ok(sendLine.endsWith('An error occurred ?[2Jerror bucket="src" id="b": forged?'), sendLine);
  for (const l of lines) assert.ok(!/[\n\u001b\u202e]/.test(l), JSON.stringify(l));
});
