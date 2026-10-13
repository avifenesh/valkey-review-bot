#!/usr/bin/env node
// List, deprecate or find orphaned SKILL records in a skills registry (a
// reviewer's graduated skills, or the curator's own authoring skills).
//
// Usage:
//   node scripts/registry-skills.mjs list (--registry-id ID | --stack STACK) [--region REGION]
//   node scripts/registry-skills.mjs deprecate (--registry-id ID | --stack STACK)
//        (--name NAME | --record-id ID) --reason TEXT [--region REGION]
//   node scripts/registry-skills.mjs orphans (--stack REVIEWER_STACK | --registry-id ID --table CONCERNS_TABLE)
//        [--region REGION]
//
// --stack reads the id from the stack's SkillsRegistryId output (the
// reviewer stacks) or CuratorSkillsRegistryId output (the curator stack).
// A deprecated record stays in the registry, but reviewers and the
// curator no longer load it. DEPRECATED is final: the record cannot be
// edited or restored, and a skill that comes back is published under a
// new name.
//
// orphans lists the reviewer's skills that are not retired and that no
// concern record names (graduated_record_name). The decay job used to
// delete graduated records, so those skills have no source record and the
// skill lifecycle (standing, checks, retirement) never reaches them.
// Retire them with deprecate. The concerns table comes from the
// reviewer stack's ConcernsTableName output, or --table.
//
// Needs Node 24 or later, `npm ci` in agents/common, the AWS CLI for
// --stack and orphans, and credentials allowed to list records (and, for
// deprecate, to update record status) in the registry; orphans also
// needs dynamodb:Scan on the concerns table and kms:Decrypt on its key.

import { awsRunner } from './lib/aws-cli.mjs';
import { cliArgs, fail, loadRegistryModule, resolveRegistryId, stackOutput } from './lib/registry-cli.mjs';
import { deprecateTarget, findOrphans, graduatedNames } from './lib/skill-records.mjs';

const USAGE = [
  'usage: node scripts/registry-skills.mjs list (--registry-id ID | --stack STACK) [--region REGION]',
  '       node scripts/registry-skills.mjs deprecate (--registry-id ID | --stack STACK) (--name NAME | --record-id ID) --reason TEXT [--region REGION]',
  '       node scripts/registry-skills.mjs orphans (--stack REVIEWER_STACK | --registry-id ID --table CONCERNS_TABLE) [--region REGION]',
].join('\n');

const { values, positionals } = cliArgs({
  'registry-id': { type: 'string' },
  stack: { type: 'string' },
  region: { type: 'string' },
  name: { type: 'string' },
  'record-id': { type: 'string' },
  reason: { type: 'string' },
  table: { type: 'string' },
}, USAGE);
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
const [command, ...extra] = positionals;
if (!['list', 'deprecate', 'orphans'].includes(command) || extra.length > 0) fail(`expected "list", "deprecate" or "orphans"\n${USAGE}`);
if (command === 'deprecate') {
  if (!values.reason?.trim()) fail('deprecate needs --reason');
  if (!values.name === !values['record-id']) fail('deprecate needs exactly one of --name or --record-id');
}
if (values.table && command !== 'orphans') fail('--table is only for orphans');
if (command === 'orphans' && !values.table && !values.stack) fail('orphans needs --stack REVIEWER_STACK, or --registry-id with --table');

const registryId = resolveRegistryId(values, command === 'orphans' ? ['SkillsRegistryId'] : ['SkillsRegistryId', 'CuratorSkillsRegistryId']);
const table = command === 'orphans' ? (values.table ?? stackOutput(values.stack, values.region, ['ConcernsTableName'])) : null;
const { createRegistryClient, deprecateSkill, isRetiredStatus, listSkillSummaries } = await loadRegistryModule();
const client = createRegistryClient(values.region);

const row = (r) => [r.name, r.recordId, r.status, r.updatedAt?.toISOString() ?? '-'].join('\t');

try {
  const records = await listSkillSummaries(client, registryId);

  if (command === 'list') {
    if (records.length === 0) console.log(`no skills in registry ${registryId}`);
    for (const r of [...records].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))) console.log(row(r));
  } else if (command === 'orphans') {
    let referenced;
    try {
      referenced = graduatedNames(awsRunner(values.region), table);
    } catch (err) {
      fail(`could not scan ${table}: ${err.message}`);
    }
    const orphans = findOrphans(records, referenced, isRetiredStatus);
    if (orphans.length === 0) {
      console.log(`no orphaned skills in registry ${registryId}: every live skill has a concern record in ${table}`);
    } else {
      for (const r of orphans) console.log(row(r));
      const where = values.stack ? `--stack ${values.stack}` : `--registry-id ${registryId}`;
      console.log('');
      console.log(`${orphans.length} live skill(s) in registry ${registryId} that no concern record in ${table} names.`);
      console.log('A skill published by hand, not by the curator, is listed too. Retire an orphan with:');
      console.log(`  node scripts/registry-skills.mjs deprecate ${where} --record-id RECORD_ID --reason "orphaned: no concern record"`);
    }
  } else {
    let recordId;
    try {
      recordId = deprecateTarget(records, { name: values.name, recordId: values['record-id'] }, isRetiredStatus);
    } catch (err) {
      fail(`${err.message} in registry ${registryId}`);
    }
    const status = await deprecateSkill(client, registryId, recordId, values.reason);
    console.log(`deprecated ${recordId} status=${status || '?'}`);
  }
} finally {
  client.destroy();
}
