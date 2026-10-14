import assert from 'node:assert/strict';
import test from 'node:test';
import '../../ops/test/support/ts-resolve.mjs';
import {
  adoptedRecordId, adoptionArea, adoptionBucket, adoptionItem, adoptionPutArgs, bucketProblem, MAX_AREA_GLOBS, planAdoption, thresholdProblem,
} from '../lib/adopt.mjs';
import { fromItem, toItem } from '../lib/aws-cli.mjs';
import { flag } from './support/aws.mjs';

// The decay pass is what an adopted record is for: it must read the
// record as a live graduated one. Needs `npm ci` in ops.
const decay = await import('../../ops/src/decay.ts');

const isRetired = (s) => s === 'DEPRECATED' || s === 'REJECTED';
const NOW_ISO = '2026-10-14T09:00:00.000Z';
const DAY_MS = 24 * 3600 * 1000;

const RDB_MD = [
  '---',
  'name: rdb-load',
  'description: "Use when a change touches `src/rdb.c` loading."',
  '---',
  '',
  '# RDB loading rules',
  '',
  'Call `rdbLoadRio` from `src/rdb.c`, never `emptyData` before it.',
  'Tests live in `tests/integration/` and `tests/unit/*.tcl`; see also `src/rdb.c:120`.',
  '',
  '```c',
  'src/example.c',
  '`deps/fenced.c`',
  '```',
  '',
  'Persistence is configured in `valkey.conf`.',
].join('\n');

const SKILL = { name: 'rdb-load', recordId: 'rec-1', description: 'Check how RDB files are loaded.\n\nGraduated from concern record_id=old-1.', skillMd: RDB_MD };

test('the area is the paths, directories and path globs the skill cites, in order; none is the whole tree', () => {
  assert.deepEqual(adoptionArea(RDB_MD), ['src/rdb.c', 'tests/integration/**', 'tests/unit/*.tcl', 'valkey.conf']);
  assert.deepEqual(adoptionArea('# Style\n\nPrefer `snake_case` names and short `HSET` calls.\n'), ['**']);
  const many = Array.from({ length: 15 }, (_, i) => `\`src/file${i}.c\``).join(' ');
  assert.deepEqual(adoptionArea(many), Array.from({ length: MAX_AREA_GLOBS }, (_, i) => `src/file${i}.c`), 'at most the curator\'s 10 globs');
});

test('the bucket is the top-level directory of the first glob that names one, else the fallback', () => {
  assert.equal(adoptionBucket(['src/rdb.c', 'tests/unit/*.tcl', 'tests/x.tcl'], '**'), 'src');
  assert.equal(adoptionBucket(['valkey.conf', 'glide-core/src/client/**', 'java/x.java'], '**'), 'glide-core');
  assert.equal(adoptionBucket(['**'], '**'), '**');
  assert.equal(adoptionBucket(['server.h', '**/cluster.c'], 'src'), 'src', 'a file name or a leading glob names no directory');
});

test('the record id is a UUID made from the name, so a second run writes the same key', () => {
  const id = adoptedRecordId('rdb-load');
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(adoptedRecordId('rdb-load'), id);
  assert.notEqual(adoptedRecordId('rdb-loads'), id);
});

test('the adopted record holds what create_concern and submit_skill write, and nothing else', () => {
  const item = adoptionItem({ skill: SKILL, threshold: 4, nowIso: NOW_ISO, fallbackBucket: '**' });
  assert.deepEqual(item, {
    area_bucket: 'src',
    record_id: adoptedRecordId('rdb-load'),
    area: ['src/rdb.c', 'tests/integration/**', 'tests/unit/*.tcl', 'valkey.conf'],
    subject: 'RDB loading rules',
    concern: 'Check how RDB files are loaded.',
    context: 'Adopted into the skill lifecycle from registry record rec-1 on 2026-10-14. '
      + 'The skill was published outside the curator, so no maintainer reinforcement is recorded behind it.',
    reinforcement_count: 4,
    decay_score: 1,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    graduated_record_name: 'rdb-load',
    graduated_at: NOW_ISO,
  });
  // No reinforcer: DynamoDB stores no empty set, and an absent set is what the curator reads as empty.
  assert.ok(!('reinforcers' in item));
  for (const a of ['verified_at', 'verified_release', 'audit_names', 'maintenance_id', 'retired_at', 'skill_generation']) assert.ok(!(a in item), a);
});

test('without a description or a title the concern and subject come from the frontmatter and the name', () => {
  const md = "---\nname: x\ndescription: 'Use when it''s about `src/a.c`.'\n---\n\n```\n# not a title\n```\nBody.\n";
  const item = adoptionItem({ skill: { name: 'a-rule', recordId: 'r', description: '', skillMd: md }, threshold: 3, nowIso: NOW_ISO, fallbackBucket: 'src' });
  assert.equal(item.subject, 'a rule');
  assert.equal(item.concern, "Use when it's about `src/a.c`.");
  assert.equal(item.reinforcement_count, 3);
  const long = adoptionItem({ skill: { name: 'b', recordId: 'r', description: `${'x'.repeat(1999)}\u{1F600}`, skillMd: '# T\n' }, threshold: 4, nowIso: NOW_ISO, fallbackBucket: 'src' });
  assert.equal(long.concern, 'x'.repeat(1999), 'cut to the curator\'s 2000, not inside a character');
  assert.equal(long.area_bucket, 'src', 'the fallback bucket');
  assert.deepEqual(long.area, ['**']);
});

test('the put writes the typed item only where no item has its key', () => {
  const item = adoptionItem({ skill: SKILL, threshold: 5, nowIso: NOW_ISO, fallbackBucket: '**' });
  const args = adoptionPutArgs('valkey_review_concerns', item);
  assert.deepEqual(args.slice(0, 4), ['dynamodb', 'put-item', '--table-name', 'valkey_review_concerns']);
  const typedItem = JSON.parse(flag(args, '--item'));
  assert.deepEqual(typedItem.area, { L: item.area.map((S) => ({ S })) }, 'a list, as the document client writes the curator\'s area');
  assert.deepEqual(typedItem.reinforcement_count, { N: '5' });
  assert.deepEqual(typedItem.decay_score, { N: '1' });
  assert.deepEqual(fromItem(typedItem), item);
  assert.equal(flag(args, '--condition-expression'), 'attribute_not_exists(#rid)');
  assert.deepEqual(JSON.parse(flag(args, '--expression-attribute-names')), { '#rid': 'record_id' });
  assert.throws(() => toItem({ reinforcers: new Set(['a']) }), /cannot write a object/);
});

test('planAdoption adopts each live, checkable, uniquely named skill no concern record names', () => {
  const plan = planAdoption([
    { recordId: 'r1', name: 'kept', status: 'DRAFT' },
    { recordId: 'r2', name: 'new-one', status: 'APPROVED' },
    { recordId: 'r3', name: 'gone', status: 'DEPRECATED' },
    { recordId: 'r4', name: 'refused', status: 'REJECTED' },
    { recordId: 'r5', name: 'Bad Name', status: 'DRAFT' },
    { recordId: 'r6', name: 'dup', status: 'DRAFT' },
    { recordId: 'r7', name: 'dup', status: 'PENDING_APPROVAL' },
    { recordId: 'r8', name: 'dup', status: 'DEPRECATED' },
    { recordId: 'r9', name: 'busy', status: 'CREATING' },
    { recordId: 'r10', name: 'broken', status: 'UPDATE_FAILED' },
    { recordId: 'r11', name: 'pending', status: 'PENDING_APPROVAL' },
    { recordId: '', name: 'no-id', status: 'DRAFT' },
  ], new Set(['kept']), isRetired);
  assert.deepEqual(plan.map((p) => [p.record.recordId, p.skip]), [
    ['r5', 'the name is not one the lifecycle accepts (lowercase letters, digits and hyphens, at most 100)'],
    ['r10', 'status UPDATE_FAILED: the release check acts only on DRAFT, PENDING_APPROVAL or APPROVED records; run adopt again once it is one'],
    ['r9', 'status CREATING: the release check acts only on DRAFT, PENDING_APPROVAL or APPROVED records; run adopt again once it is one'],
    ['r6', '2 live records share the name, and a concern record names one skill by name'],
    ['r7', '2 live records share the name, and a concern record names one skill by name'],
    ['r8', 'DEPRECATED: a retired skill stays out of the lifecycle'],
    ['r3', 'DEPRECATED: a retired skill stays out of the lifecycle'],
    ['r1', 'a concern record already names it, so it is in the lifecycle'],
    ['r2', null],
    ['', 'the registry gave no record id'],
    ['r11', null],
    ['r4', 'REJECTED: a retired skill stays out of the lifecycle'],
  ]);
});

test('the threshold and the fallback bucket are checked like the curator checks them', () => {
  assert.equal(thresholdProblem('4'), null);
  assert.match(thresholdProblem('1'), /between 2 and 100, got 1/);
  assert.match(thresholdProblem('101'), /between 2 and 100/);
  assert.match(thresholdProblem('4.5'), /whole number/);
  assert.equal(bucketProblem('src'), null);
  assert.equal(bucketProblem('**'), null);
  assert.match(bucketProblem('#maintenance'), /reserved/);
  assert.match(bucketProblem(''), /1 to 200/);
  assert.match(bucketProblem('a b'), /no spaces/);
  assert.match(bucketProblem('a\u202eb'), /no spaces, control or format/);
});

/** What the decay pass writes and sends for `items` (plain values, as the document client reads them) at `nowMs`. */
async function decayPass(items, nowMs) {
  const writes = [];
  const sent = [];
  const ddb = {
    async send(command) {
      if (command.constructor.name === 'ScanCommand') return { Items: items };
      writes.push({ kind: command.constructor.name, input: command.input });
      return {};
    },
  };
  const sqs = { async send(command) { sent.push(JSON.parse(command.input.MessageBody)); return {}; } };
  const config = decay.loadDecayConfig({
    CONCERNS_TABLES_JSON: '{"valkey-review":"valkey_review_concerns"}',
    UPSTREAM_REPOS_JSON: '{"valkey-review":"valkey-io/valkey"}',
    CURATOR_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/curator',
  });
  const log = console.log;
  console.log = () => {};
  try {
    await decay.decayTable(ddb, 'valkey_review_concerns', config, nowMs, { reviewerId: 'valkey-review', releaseTag: '9.1.2', recheckAll: false, dryRun: false, sqs });
  } finally {
    console.log = log;
  }
  return { writes, sent };
}

test('the decay pass queues a first release check for an adopted record and decays it on the graduated half-life', async () => {
  const written = fromItem(JSON.parse(flag(adoptionPutArgs('t', adoptionItem({ skill: SKILL, threshold: 4, nowIso: NOW_ISO, fallbackBucket: '**' })), '--item')));
  // Checked at the release, so the pass queues no repo skill.md check.
  const repo = { area_bucket: '#maintenance', record_id: 'repo-skill', verified_release: '9.1.2', verified_at: NOW_ISO };

  // The day after: never checked, so a check is due at once.
  const first = await decayPass([repo, written], Date.parse(NOW_ISO) + DAY_MS);
  assert.deepEqual(first.sent.map((m) => [m.reason, m.record_name, m.area_bucket, m.record_id, m.seen_updated_at]), [
    ['check', 'rdb-load', 'src', written.record_id, NOW_ISO],
  ]);

  // 180 days on, with a check in flight (so none is queued): the graduated
  // half-life halves the score, where a record that never graduated is deleted.
  const later = Date.parse(NOW_ISO) + 180 * DAY_MS;
  const inFlight = { ...written, maintenance_requested_at: new Date(later - DAY_MS).toISOString() };
  const kept = await decayPass([repo, inFlight], later);
  assert.deepEqual(kept.writes.map((w) => w.kind), ['UpdateCommand']);
  assert.ok(Math.abs(kept.writes[0].input.ExpressionAttributeValues[':s'] - 0.5) < 1e-9, 'half of 1.0 after one graduated half-life');
  const { graduated_record_name: _, graduated_at: __, ...plain } = inFlight;
  const gone = await decayPass([repo, plain], later);
  assert.deepEqual(gone.writes.map((w) => w.kind), ['DeleteCommand']);
});
