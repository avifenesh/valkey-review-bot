#!/usr/bin/env node
// Run the deterministic part of the curator's skill check locally on one
// skill, to debug a check or to check a skill file before it ships. It
// prints the cited names (file paths, symbols, config names), the ones
// absent at the upstream commit, the ones lost since a base commit and
// the rare ones the diff since the base touched. No model is called.
//
// Usage:
//   node scripts/skill-facts.mjs --file FILE (--repo OWNER/NAME [--ref BRANCH] | --checkout DIR [--rev REV])
//        [--base SHA] [--names | --json]
//   node scripts/skill-facts.mjs --name SKILL_NAME (--stack REVIEWER_STACK | --registry-id ID [--table CONCERNS_TABLE])
//        (--repo OWNER/NAME [--ref BRANCH] | --checkout DIR [--rev REV]) [--base SHA] [--names | --json] [--region REGION]
//
// The skill:
//   --file       a skill markdown file, such as agents/valkey-review/config/skill.md.
//                The built-in skill.md files ship by pull request; check them
//                at each upstream release.
//   --name       a record of the reviewer's skills registry (any status). With
//                --stack (or --table), the concern record that graduated as
//                that name supplies what the curator's check uses: its
//                audit_names as the baseline, ignored_names, verified_sha as
//                the base, and the area globs.
// The upstream:
//   --repo       a fresh anonymous checkout of https://github.com/OWNER/NAME,
//                default branch (or --ref) tip, the way the curator makes it,
//                in a temporary directory deleted afterwards.
//   --url        the same from any https:// URL without credentials, or file://.
//   --checkout   the committed tree at --rev (default HEAD) of a clone you
//                already have. Git runs there without your global and system
//                config and with GIT_NO_LAZY_FETCH=1, and only reads it. A
//                partial clone (one with a promisor remote, as git clone
//                --filter makes) is refused, with any git version: it can
//                lack objects the check reads. Use a full clone there, or
//                --repo or --url.
// Comparison:
//   --base       the commit of the last check (default: the record's
//                verified_sha). Without a record the baseline is the cited
//                names present at the base. A fresh checkout fetches it, so it
//                must be a full SHA.
// Output:
//   --names      also list every cited name with its kind, count and state
//   --json       print the whole result as JSON, diff excerpts included
//
// Exit status: 0 when the skill is clean, 2 when it is not, 1 on error.
//
// Needs Node 24 or later and git. --name also needs `npm ci` in
// agents/common and credentials allowed to read the registry; --stack
// needs the AWS CLI, cloudformation:DescribeStacks, dynamodb:Scan on the
// concerns table and kms:Decrypt on its key.

import { readFileSync, statSync } from 'node:fs';
import { isRepoName } from '../ops/src/releases.ts';
import { awsRunner, quoted } from './lib/aws-cli.mjs';
import { cliArgs, fail, loadRegistryModule, resolveRegistryId, stackOutput } from './lib/registry-cli.mjs';
import { factsJson, factsReport, skillFacts } from './lib/skill-facts.mjs';
import { findGraduatedRecord } from './lib/skill-records.mjs';
import { asciiJson, printable } from './lib/text.mjs';

const USAGE = [
  'usage: node scripts/skill-facts.mjs --file FILE (--repo OWNER/NAME [--ref BRANCH] | --url URL [--ref BRANCH] | --checkout DIR [--rev REV])',
  '         [--base SHA] [--names | --json]',
  '       node scripts/skill-facts.mjs --name SKILL_NAME (--stack REVIEWER_STACK | --registry-id ID [--table CONCERNS_TABLE])',
  '         (--repo OWNER/NAME [--ref BRANCH] | --url URL [--ref BRANCH] | --checkout DIR [--rev REV]) [--base SHA] [--names | --json] [--region REGION]',
].join('\n');

const { values, positionals } = cliArgs({
  file: { type: 'string' },
  name: { type: 'string' },
  stack: { type: 'string' },
  'registry-id': { type: 'string' },
  table: { type: 'string' },
  repo: { type: 'string' },
  url: { type: 'string' },
  ref: { type: 'string' },
  checkout: { type: 'string' },
  rev: { type: 'string' },
  base: { type: 'string' },
  names: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  region: { type: 'string' },
}, USAGE);
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (positionals.length > 0) fail(`unexpected argument ${quoted(positionals[0])}\n${USAGE}`);
if (!values.file === !values.name) fail(`pass exactly one of --file or --name\n${USAGE}`);
if (values.file && (values.stack || values['registry-id'] || values.table)) fail('--stack, --registry-id and --table go with --name');
if (values.table && !values['registry-id']) fail('--table goes with --registry-id; --stack gives the table itself');
if ([values.repo, values.url, values.checkout].filter(Boolean).length !== 1) fail(`pass exactly one of --repo, --url or --checkout\n${USAGE}`);
if (values.ref && values.checkout) fail('--ref goes with --repo or --url; use --rev with --checkout');
if (values.rev && !values.checkout) fail('--rev goes with --checkout; use --ref with --repo or --url');
if (values.repo && !isRepoName(values.repo)) fail(`--repo must look like owner/name, got ${quoted(values.repo)}`);
// Before anything prints the URL: a URL with credentials is refused without echoing them.
if (values.url !== undefined) {
  let url;
  try {
    url = new URL(values.url);
  } catch {
    fail('--url is not a URL; pass an https:// URL without credentials, or a file:// URL');
  }
  if (url.username || url.password) fail('--url must not carry credentials (a user or password before @); the upstream is fetched anonymously');
}
if (values.names && values.json) fail('pass --names or --json, not both');
if (values.checkout && !statSync(values.checkout, { throwIfNoEntry: false })?.isDirectory()) fail(`--checkout ${quoted(values.checkout)} is not a directory`);

let skillMd;
let label;
let record = null;
if (values.file) {
  try {
    skillMd = readFileSync(values.file, 'utf8');
  } catch (err) {
    fail(`cannot read ${values.file}: ${err.message}`);
  }
  label = values.file;
} else {
  const registryId = resolveRegistryId(values, ['SkillsRegistryId']);
  const { createRegistryClient, getSkillByName, isRetiredStatus } = await loadRegistryModule();
  const client = createRegistryClient(values.region);
  let skill;
  try {
    skill = await getSkillByName(client, registryId, values.name);
  } catch (err) {
    fail(`could not read skill ${quoted(values.name)} from registry ${registryId}: ${err.message}`);
  } finally {
    client.destroy();
  }
  if (!skill) fail(`no SKILL record named ${quoted(values.name)} in registry ${registryId}`);
  skillMd = skill.skillMd;
  label = `${quoted(skill.name)} (record ${printable(skill.recordId)}, ${printable(skill.status || 'status unknown')})`;
  if (isRetiredStatus(skill.status)) console.error(`note: the record is ${printable(skill.status)}; the curator no longer checks it`);

  const table = values.table ?? (values.stack ? stackOutput(values.stack, values.region, ['ConcernsTableName']) : null);
  if (table) {
    try {
      record = findGraduatedRecord(awsRunner(values.region), table, values.name);
    } catch (err) {
      fail(err.message);
    }
    if (!record) console.error(`note: no concern record in ${table} graduated as ${quoted(values.name)}, so this is a first check`);
    else if (record.retired_at !== undefined) console.error(`note: the concern record is a tombstone (retired ${quoted(record.retired_reason ?? '?')})`);
  }
}

const upstream = values.checkout
  ? { checkout: values.checkout, rev: values.rev }
  : { url: values.url ?? `https://github.com/${values.repo}.git`, branch: values.ref };
if (upstream.url) console.error(`fetching ${printable(upstream.url)}${upstream.branch ? ` ${printable(upstream.branch)}` : ''} ...`);

let facts;
try {
  facts = await skillFacts({ skillMd, upstream, record, base: values.base });
} catch (err) {
  fail(err.message);
}
// The excerpts are upstream code: with non-ASCII escaped, no character of it can act on the terminal.
if (values.json) console.log(asciiJson(factsJson(facts, { label }), 2));
else for (const line of factsReport(facts, { label, allNames: values.names })) console.log(line);
process.exit(facts.result.clean ? 0 : 2);
