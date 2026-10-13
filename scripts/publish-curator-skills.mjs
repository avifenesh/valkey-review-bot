#!/usr/bin/env node
// Publish agents/curator/skills/*.md to the curator's skills registry
// in AWS Agent Registry. Each file with frontmatter becomes a SKILL
// record named after its `name`; an existing record with that name is
// updated in place, so running it again is safe.
//
// Usage:
//   node scripts/publish-curator-skills.mjs --registry-id ID [--region REGION] [--dry-run]
//   node scripts/publish-curator-skills.mjs --stack CURATOR_STACK [--region REGION] [--dry-run]
//
// --stack reads the id from the stack's CuratorSkillsRegistryId output.
// Without --region the AWS SDK's usual sources apply (AWS_REGION, profile).
//
// Needs Node 24 or later, `npm ci` in agents/common, the AWS CLI for
// --stack, and credentials allowed to list, create and update records
// in the registry.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliArgs, fail, loadRegistryModule, resolveRegistryId } from './lib/registry-cli.mjs';
import { printable } from './lib/text.mjs';

const USAGE = 'usage: node scripts/publish-curator-skills.mjs (--registry-id ID | --stack CURATOR_STACK) [--region REGION] [--dry-run]';
const SKILLS_DIR = fileURLToPath(new URL('../agents/curator/skills/', import.meta.url));
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DESCRIPTION_MAX = 512;

const { values } = cliArgs({
  'registry-id': { type: 'string' },
  stack: { type: 'string' },
  region: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
}, USAGE);
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

/** Single-line `key: value` frontmatter; double-quoted values are JSON strings. */
function frontmatter(file, text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0) fail(`${file}: frontmatter is not closed with ---`);
  const fields = {};
  for (const line of lines.slice(1, end)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) fail(`${file}: cannot read frontmatter line "${line}"`);
    const raw = m[2].trim();
    try {
      fields[m[1]] = raw.startsWith('"') ? JSON.parse(raw) : raw;
    } catch {
      fail(`${file}: frontmatter value for ${m[1]} is not a valid quoted string`);
    }
  }
  return fields;
}

const skills = [];
for (const entry of readdirSync(SKILLS_DIR).filter((f) => f.endsWith('.md')).sort()) {
  const file = path.join('agents/curator/skills', entry);
  const text = readFileSync(path.join(SKILLS_DIR, entry), 'utf8');
  const fields = frontmatter(file, text);
  if (!fields) continue; // README and other notes are not skills.
  const { name, description } = fields;
  if (!name || !SLUG.test(name)) fail(`${file}: frontmatter name must be lowercase words joined by hyphens`);
  if (name !== entry.slice(0, -'.md'.length)) fail(`${file}: frontmatter name "${name}" must match the file name`);
  if (!description) fail(`${file}: frontmatter description is missing`);
  if (description.length > DESCRIPTION_MAX) fail(`${file}: description is ${description.length} characters; the limit is ${DESCRIPTION_MAX}`);
  skills.push({ file, name, description, skillMd: text });
}
if (skills.length === 0) fail(`no skills with frontmatter in ${SKILLS_DIR}`);

if (values['dry-run']) {
  for (const s of skills) console.log(`would publish ${s.name} (${s.file})`);
  process.exit(0);
}

const registryId = resolveRegistryId(values, ['CuratorSkillsRegistryId']);
const { createRegistryClient, upsertSkill } = await loadRegistryModule();
const client = createRegistryClient(values.region);
console.log(`publishing ${skills.length} skill(s) to registry ${registryId}`);
try {
  for (const s of skills) {
    const result = await upsertSkill(client, registryId, { name: s.name, description: s.description, skillMd: s.skillMd });
    console.log(`  ${result.action} ${s.name} status=${printable(result.status || '?')}`);
  }
} catch (err) {
  fail(`registry ${registryId}: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  client.destroy();
}
