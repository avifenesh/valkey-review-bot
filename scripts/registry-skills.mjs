#!/usr/bin/env node
// List or deprecate the SKILL records in a skills registry (a reviewer's
// graduated skills, or the curator's own authoring skills).
//
// Usage:
//   node scripts/registry-skills.mjs list (--registry-id ID | --stack STACK) [--region REGION]
//   node scripts/registry-skills.mjs deprecate (--registry-id ID | --stack STACK)
//        (--name NAME | --record-id ID) --reason TEXT [--region REGION]
//
// --stack reads the id from the stack's SkillsRegistryId output (the
// reviewer stacks) or CuratorSkillsRegistryId output (the curator stack).
// A deprecated record stays in the registry, but reviewers and the
// curator no longer load it.
//
// Needs Node 24 or later, `npm ci` in agents/common, the AWS CLI for
// --stack, and credentials allowed to list records (and, for deprecate,
// to update record status) in the registry.

import { cliArgs, fail, loadRegistryModule, registrySdk, resolveRegistryId } from './lib/registry-cli.mjs';

const USAGE = [
  'usage: node scripts/registry-skills.mjs list (--registry-id ID | --stack STACK) [--region REGION]',
  '       node scripts/registry-skills.mjs deprecate (--registry-id ID | --stack STACK) (--name NAME | --record-id ID) --reason TEXT [--region REGION]',
].join('\n');

const { values, positionals } = cliArgs({
  'registry-id': { type: 'string' },
  stack: { type: 'string' },
  region: { type: 'string' },
  name: { type: 'string' },
  'record-id': { type: 'string' },
  reason: { type: 'string' },
}, USAGE);
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
const [command, ...extra] = positionals;
if (!['list', 'deprecate'].includes(command) || extra.length > 0) fail(`expected "list" or "deprecate"\n${USAGE}`);
if (command === 'deprecate') {
  if (!values.reason?.trim()) fail('deprecate needs --reason');
  if (!values.name === !values['record-id']) fail('deprecate needs exactly one of --name or --record-id');
}

const registryId = resolveRegistryId(values, ['SkillsRegistryId', 'CuratorSkillsRegistryId']);
const { createRegistryClient, listSkillSummaries } = await loadRegistryModule();
const client = createRegistryClient(values.region);

try {
  const records = await listSkillSummaries(client, registryId);

  if (command === 'list') {
    if (records.length === 0) console.log(`no skills in registry ${registryId}`);
    for (const r of [...records].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))) {
      console.log([r.name, r.recordId, r.status, r.updatedAt?.toISOString() ?? '-'].join('\t'));
    }
  } else {
    let recordId = values['record-id'];
    if (!recordId) {
      const live = records.filter((r) => r.name === values.name && r.status !== 'DEPRECATED');
      if (live.length === 0) fail(`no record named ${values.name} that is not already deprecated`);
      if (live.length > 1) fail(`${live.length} records are named ${values.name} (${live.map((r) => r.recordId).join(', ')}); pass --record-id`);
      recordId = live[0].recordId;
    } else if (!records.some((r) => r.recordId === recordId)) {
      fail(`no SKILL record ${recordId} in registry ${registryId}`);
    }
    const { UpdateRegistryRecordStatusCommand } = registrySdk();
    const resp = await client.send(new UpdateRegistryRecordStatusCommand({
      registryId,
      recordId,
      status: 'DEPRECATED',
      statusReason: values.reason.trim(),
    }));
    console.log(`deprecated ${recordId} status=${resp.status ?? '?'}`);
  }
} finally {
  client.destroy();
}
