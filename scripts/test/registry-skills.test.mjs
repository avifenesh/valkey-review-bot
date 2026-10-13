import assert from 'node:assert/strict';
import test from 'node:test';
import { deprecateTarget } from '../lib/skill-records.mjs';
import { fakeAwsCli, runScript } from './support/aws.mjs';
import { fakeRegistry, registryEnv } from './support/registry.mjs';

const isRetired = (s) => s === 'DEPRECATED' || s === 'REJECTED';

const RECORDS = [
  { recordId: 'r-a', name: 'kept', status: 'DRAFT' },
  { recordId: 'r-b', name: 'orphan-b', status: 'APPROVED' },
  { recordId: 'r-c', name: 'gone', status: 'DEPRECATED' },
  { recordId: 'r-d', name: 'refused', status: 'REJECTED' },
  { recordId: 'r-e', name: 'orphan-a', status: 'DRAFT' },
  { recordId: 'r-f', name: 'tomb-name', status: 'DRAFT' },
];

test('deprecateTarget takes the one live record with the name, or the given id', () => {
  const twice = [...RECORDS, { recordId: 'r-g', name: 'kept', status: 'DEPRECATED' }, { recordId: 'r-h', name: 'dup', status: 'DRAFT' }, { recordId: 'r-i', name: 'dup', status: 'DRAFT' }];
  assert.equal(deprecateTarget(twice, { name: 'kept' }, isRetired), 'r-a', 'a retired namesake is not a candidate');
  assert.throws(() => deprecateTarget(twice, { name: 'gone' }, isRetired), /no record named gone that is not already deprecated or rejected/);
  assert.throws(() => deprecateTarget(twice, { name: 'refused' }, isRetired), /not already deprecated or rejected/);
  assert.throws(() => deprecateTarget(twice, { name: 'dup' }, isRetired), /2 records are named dup \(r-h, r-i\); pass --record-id/);
  assert.equal(deprecateTarget(twice, { recordId: 'r-c' }, isRetired), 'r-c');
  assert.throws(() => deprecateTarget(twice, { recordId: 'nope' }, isRetired), /no SKILL record nope/);
});

/** Runs registry-skills.mjs against a fake registry holding RECORDS and a fake CLI. */
async function registrySkills(args, cliResponses = {}) {
  const registry = await fakeRegistry(RECORDS);
  const cli = fakeAwsCli(cliResponses);
  try {
    const r = await runScript('registry-skills.mjs', args, { env: registryEnv(cli.env, registry) });
    return { ...r, calls: cli.calls(), requests: registry.requests };
  } finally {
    await registry.close();
  }
}

test('deprecate goes through deprecateSkill: the reason is cut to the service limit', async () => {
  const reason = `  ${'x'.repeat(300)}  `;
  const r = await registrySkills(['deprecate', '--registry-id', 'reg-1', '--name', 'orphan-b', '--reason', reason]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^deprecated r-b status=DEPRECATED$/m);
  const patch = r.requests.find((q) => q.method === 'PATCH');
  assert.equal(patch.url, '/registries/reg-1/records/r-b/status');
  assert.deepEqual(patch.body, { status: 'DEPRECATED', statusReason: 'x'.repeat(256) });
});

test('deprecate by name refuses a name whose records are all retired', async () => {
  const r = await registrySkills(['deprecate', '--registry-id', 'reg-1', '--name', 'refused', '--reason', 'r']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no record named refused that is not already deprecated or rejected in registry reg-1/);
  assert.ok(!r.requests.some((q) => q.method === 'PATCH'));
});
