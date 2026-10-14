#!/usr/bin/env node
// List, deprecate, find or adopt orphaned SKILL records in a skills
// registry (a reviewer's graduated skills, or the curator's own
// authoring skills).
//
// Usage:
//   node scripts/registry-skills.mjs list (--registry-id ID | --stack STACK) [--region REGION]
//   node scripts/registry-skills.mjs deprecate (--registry-id ID | --stack STACK)
//        (--name NAME | --record-id ID) --reason TEXT [--region REGION]
//   node scripts/registry-skills.mjs orphans (--stack REVIEWER_STACK | --registry-id ID --table CONCERNS_TABLE)
//        [--region REGION]
//   node scripts/registry-skills.mjs adopt (--stack REVIEWER_STACK | --registry-id ID --table CONCERNS_TABLE)
//        [--threshold N | --curator-stack CURATOR_STACK] [--bucket BUCKET] [--apply] [--region REGION]
//
// --stack reads the id from the stack's SkillsRegistryId output (the
// reviewer stacks) or CuratorSkillsRegistryId output (the curator stack).
// A deprecated record stays in the registry, but reviewers and the
// curator no longer load it. DEPRECATED is final: the record cannot be
// edited or restored, and a skill that comes back is published under a
// new name.
//
// orphans lists the reviewer's skills that are not retired and that no
// concern record names (graduated_record_name): skills published by hand,
// outside the curator, and skills whose source record the old decay job
// deleted. Reviewers still load them, but the skill lifecycle (decay,
// release checks, retirement) never reaches them. Bring them in with
// adopt. The concerns table comes from the reviewer stack's
// ConcernsTableName output, or --table.
//
// adopt gives each such skill the concern record it would have if the
// curator had graduated it, so the decay job decays it on the graduated
// half-life and queues release checks for it (up to checksPerDay per
// reviewer per day, never-checked records first). It is a dry run that
// prints what it would write unless --apply is given. One line per SKILL
// record says would-adopt, adopted or skipped and why: a retired record,
// one a concern record already names, a name the lifecycle does not
// accept, a name several live records share, or a status the release
// check does not act on (CREATING, UPDATING or a failed write).
//
// The record (scripts/lib/adopt.mjs): a new record_id derived from the
// name; area, the file paths, directories (as dir/**) and path globs
// the skill cites, or "**" when it cites none; area_bucket, the
// top-level directory of the first of them that names one, or --bucket
// (default "**") when none does; subject, the skill's # title or
// its name; concern, the registry description; context, where it came
// from; reinforcement_count at the curator's graduation threshold, with
// no reinforcer behind it; decay_score 1.0; created_at, updated_at and
// graduated_at now; graduated_record_name, the registry name. The
// threshold is --threshold, or with --curator-stack the
// GRADUATION_THRESHOLD of the curator runtime that stack deploys (its
// CuratorRuntimeId output), or else the curator's default, 4. At the
// threshold the curator treats the record as one it graduated: feedback
// that reinforces or corrects it can update the skill.
//
// With --apply each skill's name is looked up in the table again right
// before its write, and the write is conditioned on no item having its
// key, so a second run adds no second record for a skill. An area glob
// that matches no file upstream lets the release check corroborate an
// "obsolete" verdict; once the skill is adopted, scripts/skill-facts.mjs
// --name NAME --stack STACK --repo OWNER/NAME shows the area's file
// counts.
//
// Needs Node 24 or later, `npm ci` in agents/common, the AWS CLI for
// --stack, orphans and adopt, and credentials allowed to list records
// (and, for deprecate, to update record status, and for adopt, to read
// them) in the registry; orphans and adopt also need dynamodb:Scan on
// the concerns table and use of its KMS key, adopt --apply needs
// dynamodb:PutItem on it, and --curator-stack needs
// bedrock-agentcore:GetAgentRuntime on the curator runtime.

import {
  adoptionBucket, adoptionItem, adoptionPutArgs, bucketProblem, DEFAULT_FALLBACK_BUCKET, DEFAULT_THRESHOLD, planAdoption, thresholdProblem,
} from './lib/adopt.mjs';
import { awsRunner, isConditionFailure, quoted } from './lib/aws-cli.mjs';
import { cliArgs, fail, loadRegistryModule, resolveRegistryId, stackOutput } from './lib/registry-cli.mjs';
import { deprecateTarget, findGraduatedRecord, findOrphans, graduatedNames } from './lib/skill-records.mjs';
import { asciiJson, printable } from './lib/text.mjs';

const USAGE = [
  'usage: node scripts/registry-skills.mjs list (--registry-id ID | --stack STACK) [--region REGION]',
  '       node scripts/registry-skills.mjs deprecate (--registry-id ID | --stack STACK) (--name NAME | --record-id ID) --reason TEXT [--region REGION]',
  '       node scripts/registry-skills.mjs orphans (--stack REVIEWER_STACK | --registry-id ID --table CONCERNS_TABLE) [--region REGION]',
  '       node scripts/registry-skills.mjs adopt (--stack REVIEWER_STACK | --registry-id ID --table CONCERNS_TABLE)',
  '            [--threshold N | --curator-stack CURATOR_STACK] [--bucket BUCKET] [--apply] [--region REGION]',
].join('\n');

const { values, positionals } = cliArgs({
  'registry-id': { type: 'string' },
  stack: { type: 'string' },
  region: { type: 'string' },
  name: { type: 'string' },
  'record-id': { type: 'string' },
  reason: { type: 'string' },
  table: { type: 'string' },
  threshold: { type: 'string' },
  'curator-stack': { type: 'string' },
  bucket: { type: 'string' },
  apply: { type: 'boolean' },
}, USAGE);
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
const [command, ...extra] = positionals;
if (!['list', 'deprecate', 'orphans', 'adopt'].includes(command) || extra.length > 0) fail(`expected "list", "deprecate", "orphans" or "adopt"\n${USAGE}`);
if (command === 'deprecate') {
  if (!values.reason?.trim()) fail('deprecate needs --reason');
  if (!values.name === !values['record-id']) fail('deprecate needs exactly one of --name or --record-id');
}
// orphans and adopt work on a reviewer's registry and its concerns table.
const withTable = command === 'orphans' || command === 'adopt';
if (values.table && !withTable) fail('--table is only for orphans and adopt');
if (withTable && !values.table && !values.stack) fail(`${command} needs --stack REVIEWER_STACK, or --registry-id with --table`);
for (const flag of ['threshold', 'curator-stack', 'bucket', 'apply']) {
  if (values[flag] !== undefined && command !== 'adopt') fail(`--${flag} is only for adopt`);
}
if (values.threshold !== undefined && values['curator-stack'] !== undefined) fail('pass --threshold or --curator-stack, not both');
if (values.threshold !== undefined) {
  const problem = thresholdProblem(values.threshold);
  if (problem) fail(`--threshold ${problem}`);
}
const fallbackBucket = values.bucket ?? DEFAULT_FALLBACK_BUCKET;
if (bucketProblem(fallbackBucket)) fail(`--bucket: ${bucketProblem(fallbackBucket)}`);

const registryId = resolveRegistryId(values, withTable ? ['SkillsRegistryId'] : ['SkillsRegistryId', 'CuratorSkillsRegistryId']);
const table = withTable ? (values.table ?? stackOutput(values.stack, values.region, ['ConcernsTableName'])) : null;
const threshold = command === 'adopt' ? graduationThreshold() : null;
const { createRegistryClient, deprecateSkill, getSkillByName, isRetiredStatus, listSkillSummaries } = await loadRegistryModule();
const client = createRegistryClient(values.region);

// Names, ids and statuses come from the registry: printable, so no tab or control character can shift a column or the terminal.
const row = (r) => [r.name, r.recordId, r.status, r.updatedAt?.toISOString() ?? '-'].map((v) => printable(v ?? '-')).join('\t');

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
      const where = values.stack ? `--stack ${values.stack}` : `--registry-id ${registryId} --table ${table}`;
      console.log('');
      console.log(`${orphans.length} live skill(s) in registry ${registryId} that no concern record in ${table} names.`);
      console.log('Reviewers load them, but the skill lifecycle (decay, release checks, retirement) never reaches them.');
      console.log('A skill published by hand, not by the curator, is listed too. Bring them into the lifecycle with');
      console.log('adopt, which prints what it would write; run it again with --apply to write it:');
      console.log(printable(`  node scripts/registry-skills.mjs adopt ${where}${values.region ? ` --region ${values.region}` : ''}`));
    }
  } else if (command === 'adopt') {
    await adopt(records);
  } else {
    let recordId;
    try {
      recordId = deprecateTarget(records, { name: values.name, recordId: values['record-id'] }, isRetiredStatus);
    } catch (err) {
      fail(`${err.message} in registry ${registryId}`);
    }
    const status = await deprecateSkill(client, registryId, recordId, values.reason);
    console.log(`deprecated ${printable(recordId)} status=${printable(status || '?')}`);
  }
} catch (err) {
  fail(`registry ${registryId}: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  client.destroy();
}

/**
 * The graduation threshold adopted records start at: --threshold, the
 * GRADUATION_THRESHOLD of the curator runtime --curator-stack deploys, or
 * the curator's default. Only that one variable is read (--query), so no
 * other runtime setting is fetched or printed.
 */
function graduationThreshold() {
  if (values.threshold !== undefined) return { value: Number(values.threshold), source: '--threshold' };
  const curatorStack = values['curator-stack'];
  if (curatorStack === undefined) {
    return { value: DEFAULT_THRESHOLD, source: "the curator's default; pass --threshold or --curator-stack if the deployed curator sets another" };
  }
  const runtimeId = stackOutput(curatorStack, values.region, ['CuratorRuntimeId']);
  let raw;
  try {
    raw = awsRunner(values.region)([
      'bedrock-agentcore-control', 'get-agent-runtime', '--agent-runtime-id', runtimeId,
      '--query', 'environmentVariables.GRADUATION_THRESHOLD',
    ]);
  } catch (err) {
    fail(`could not read the curator runtime of stack ${curatorStack}: ${err.message}; pass --threshold instead`);
  }
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return { value: DEFAULT_THRESHOLD, source: `the curator's default: the runtime of ${curatorStack} sets no GRADUATION_THRESHOLD` };
  }
  const text = String(raw).trim();
  const problem = thresholdProblem(text);
  if (problem) fail(`GRADUATION_THRESHOLD of the curator runtime of stack ${curatorStack} ${problem}`);
  return { value: Number(text), source: `GRADUATION_THRESHOLD of the curator runtime of stack ${curatorStack}` };
}

/** The adopt subcommand: one line per SKILL record of the registry, then a summary. */
async function adopt(records) {
  const aws = awsRunner(values.region);
  let referenced;
  try {
    referenced = graduatedNames(aws, table);
  } catch (err) {
    fail(`could not scan ${table}: ${err.message}`);
  }
  const nowIso = new Date().toISOString();
  const counts = { planned: 0, skipped: 0, errors: 0, fallback: 0 };
  for (const { record, skip } of planAdoption(records, referenced, isRetiredStatus)) {
    const who = `name=${quoted(record.name ?? '')} record=${quoted(record.recordId ?? '')}`;
    const skipped = (why) => {
      counts.skipped += 1;
      console.log(`skipped ${who}: ${printable(why)}`);
    };
    if (skip) {
      skipped(skip);
      continue;
    }
    let skill;
    try {
      skill = await getSkillByName(client, registryId, record.name);
    } catch (err) {
      counts.errors += 1;
      console.log(`error ${who}: could not read the record: ${printable(err instanceof Error ? err.message : String(err))}`);
      continue;
    }
    if (!skill || skill.recordId !== record.recordId) {
      skipped('the registry record changed while adopt ran; run it again');
      continue;
    }
    if (!skill.skillMd) {
      skipped('the registry record holds no markdown');
      continue;
    }
    const item = adoptionItem({ skill, threshold: threshold.value, nowIso, fallbackBucket });
    const what = `bucket=${quoted(item.area_bucket)} id=${quoted(item.record_id)} area=${asciiJson(item.area)}`;
    const fallback = adoptionBucket(item.area, null) === null;
    if (!values.apply) {
      counts.planned += 1;
      if (fallback) counts.fallback += 1;
      console.log(`would-adopt ${who} ${what}`);
      continue;
    }
    try {
      // The first scan is minutes old by now: look again, so a record another run wrote meanwhile is not doubled.
      if (findGraduatedRecord(aws, table, record.name)) {
        skipped('a concern record has named it since adopt started');
        continue;
      }
      aws(adoptionPutArgs(table, item));
    } catch (err) {
      if (isConditionFailure(err)) {
        skipped(`an item with its key is in ${table} already (an earlier adopt wrote it)`);
      } else {
        counts.errors += 1;
        console.log(`error ${who}: ${printable(err.message)}`);
      }
      continue;
    }
    counts.planned += 1;
    if (fallback) counts.fallback += 1;
    console.log(`adopted ${who} ${what}`);
  }

  console.log('');
  const at = `reinforcement_count ${threshold.value} (${threshold.source})`;
  if (values.apply) {
    console.log(`adopted ${counts.planned} skill(s) into ${table} at ${at}; skipped ${counts.skipped}; errors ${counts.errors}.`);
    if (counts.planned > 0) {
      console.log('The next decay pass queues a first release check for each, up to checksPerDay per reviewer per day.');
    }
  } else {
    console.log(`dry run: would adopt ${counts.planned} skill(s) into ${table} at ${at}; skipped ${counts.skipped}; errors ${counts.errors}.`);
    console.log('Nothing was written. Run again with --apply to write them.');
  }
  if (counts.fallback > 0) {
    console.log(`${counts.fallback} of them cite no directory, so their bucket is ${quoted(fallbackBucket)}; --bucket chooses another, such as src.`);
  }
  if (counts.errors > 0) process.exitCode = 1;
}
