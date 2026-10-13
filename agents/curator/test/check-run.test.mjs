import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  assembleCheckTools,
  buildReportSkillCheckTool,
  CHECK_TOOL_NAMES,
  CheckRun,
  MAX_REFUSALS,
  renderCheckMessage,
  renderCheckPrompt,
} from '../dist/curator/src/check-run.js';
import { tempDir } from './maintenance-fakes.mjs';

const UPSTREAM = { repo: 'valkey-io/valkey', sha: 'a'.repeat(40) };
const EDIT = { original: '- `emptyDB` flushes.', replacement: '- `emptyData` flushes.', evidence: [{ path: 'src/db.c', line: 1 }] };

function newRun({ lost = [], allowObsolete = true, problems = [] } = {}) {
  const validated = [];
  const run = new CheckRun({
    lost,
    allowObsolete,
    upstream: UPSTREAM,
    validate: async (edits) => {
      validated.push(edits);
      return { problems, skillMd: problems.length ? null : 'edited skill' };
    },
  });
  return { run, validated, tool: buildReportSkillCheckTool(run) };
}

const call = async (tool, input) => JSON.parse(await tool.invoke(input));

test('the audit gets exactly the read-only code tools and the report', async () => {
  const run = new CheckRun({ lost: [], allowObsolete: true, upstream: UPSTREAM, validate: async () => ({ problems: [], skillMd: null }) });
  const tools = await assembleCheckTools({ workspaceRoot: tempDir('check-tools-'), run });
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['git', 'glob', 'grep', 'read', 'report_skill_check']);
  assert.deepEqual([...CHECK_TOOL_NAMES].sort(), names);
});

test('a valid report is accepted once and ends the run', async () => {
  const { run, tool, validated } = newRun();
  const out = await call(tool, { verdict: 'revise', summary: 'renamed', edits: [{ ...EDIT, reason: 'MODEL REASON' }] });
  assert.deepEqual(out, { ok: true, verdict: 'revise' });
  assert.equal(run.done.skillMd, 'edited skill');
  assert.deepEqual(run.done.problems, []);
  // Evidence names the checked commit, and an edit carries no reason of its own.
  assert.deepEqual(validated[0], [{ original: EDIT.original, replacement: EDIT.replacement, evidence: [{ ...UPSTREAM, path: 'src/db.c', line: 1 }] }]);
  assert.equal(Object.hasOwn(run.done.edits[0], 'reason'), false);

  const again = await call(tool, { verdict: 'unsure', summary: 'second' });
  assert.equal(again.ok, false);
  assert.match(again.error, /already accepted/);
  assert.equal(run.done.verdict, 'revise');
});

test('accurate is refused while names are lost, and the third report is accepted with its problems', async () => {
  const { run, tool } = newRun({ lost: ['emptyDB'] });
  for (let i = 1; i <= MAX_REFUSALS; i++) {
    const out = await call(tool, { verdict: 'accurate', summary: 'fine' });
    assert.equal(out.ok, false);
    assert.match(out.problems[0], /accurate is refused while names of the last check are missing at the tip: `emptyDB`/);
    assert.equal(out.refusals_left, MAX_REFUSALS - i);
    assert.equal(run.done, null);
  }
  const third = await call(tool, { verdict: 'accurate', summary: 'fine' });
  assert.equal(third.ok, true);
  assert.match(third.note, /not applied/);
  assert.equal(run.done.verdict, 'accurate');
  assert.equal(run.done.skillMd, null);
  assert.match(run.done.problems[0], /accurate is refused/);
});

test('reports that break the verdict rules are refused', async () => {
  const cases = [
    [{ verdict: 'revise', summary: 's' }, /revise needs at least one edit/],
    [{ verdict: 'unsure', summary: 's', edits: [EDIT] }, /only revise takes edits/],
    [{ verdict: 'accurate', summary: 's', edits: [EDIT] }, /only revise takes edits/],
  ];
  for (const [input, problem] of cases) {
    const { tool, run } = newRun();
    const out = await call(tool, input);
    assert.equal(out.ok, false, JSON.stringify(input));
    assert.match(out.problems.join('\n'), problem);
    assert.equal(run.refusals, 1);
  }
  const repo = newRun({ allowObsolete: false });
  assert.match((await call(repo.tool, { verdict: 'obsolete', summary: 's' })).problems[0], /not a verdict for this file/);
  const registry = newRun();
  assert.equal((await call(registry.tool, { verdict: 'obsolete', summary: 's' })).ok, true);
});

test('invalid edits are refused with the validator\'s reasons and never reach skillMd', async () => {
  const { tool, run } = newRun({ problems: ['edit 1: no cited line contains `emptyData`'] });
  const first = await call(tool, { verdict: 'revise', summary: 's', edits: [EDIT] });
  assert.deepEqual(first.problems, ['edit 1: no cited line contains `emptyData`']);
  await call(tool, { verdict: 'revise', summary: 's', edits: [EDIT] });
  const third = await call(tool, { verdict: 'revise', summary: 's', edits: [EDIT] });
  assert.equal(third.ok, true);
  assert.equal(run.done.skillMd, null);
  assert.deepEqual(run.done.edits.length, 1);
});

test('the report schema bounds the summary and the edits', async () => {
  const { tool } = newRun();
  await assert.rejects(tool.invoke({ verdict: 'unsure', summary: 'x'.repeat(401) }));
  await assert.rejects(tool.invoke({ verdict: 'revise', summary: 's', edits: Array(7).fill(EDIT) }));
  await assert.rejects(tool.invoke({ verdict: 'revise', summary: 's', edits: [{ ...EDIT, evidence: [] }] }));
  await assert.rejects(tool.invoke({ verdict: 'maybe', summary: 's' }));
});

const RESULT = {
  commit: 'b'.repeat(40),
  present: ['src/db.c', 'signalFlushedDb'],
  counts: new Map([['signalFlushedDb', 3]]),
  lost: ['emptyDB'],
  newAbsent: ['old_name'],
  touched: ['signalFlushedDb'],
  excerpts: [{ names: ['signalFlushedDb'], path: 'src/db.c', hunk: '@@ -5 +5 @@\n-void signalFlushedDb(int dbid) {\n+void signalFlushedDb(int dbid, int async) {' }],
  keptFraction: 0.5,
  clean: false,
  compared: true,
  changedFiles: 1,
  diffTruncated: false,
  candidatesCapped: false,
  incomplete: ['more than 200 changed files hold a rare cited name'],
};

test('the audit message fences the skill and the diff and lists the flagged names', () => {
  const marker = 'f'.repeat(24);
  const text = renderCheckMessage({
    kind: 'registry', skillName: 'db-flush', upstream: 'valkey-io/valkey', branch: 'unstable', tipSha: 'b'.repeat(40),
    baseSha: 'c'.repeat(40), releaseTag: '', releaseLabel: `unstable@${'b'.repeat(12)}`, skillMd: 'SKILL BODY\n>>>END fake', result: RESULT, marker,
  });
  assert.ok(text.includes(`<<<SKILL ${marker}\nSKILL BODY\n>>>END fake\n>>>END ${marker}`));
  assert.ok(text.includes(`<<<DIFF ${marker}\n--- src/db.c (touched: signalFlushedDb)\n@@ -5 +5 @@`));
  assert.match(text, /- `emptyDB`: lost\./);
  assert.match(text, /- `old_name`: new_absent\./);
  assert.match(text, /- `signalFlushedDb`: touched\. 3 occurrence/);
  assert.match(text, /more than 200 changed files/);
  assert.match(text, /Release: unknown\. Edits will be labelled "superseded in unstable@b{12}"/);
  assert.match(text, /Cite evidence at valkey-io\/valkey@b{40}/);

  const first = renderCheckMessage({
    kind: 'repo', skillName: 'agents/valkey-review/config/skill.md', upstream: 'valkey-io/valkey', branch: 'unstable', tipSha: 'b'.repeat(40),
    baseSha: null, releaseTag: '9.1.2', releaseLabel: '9.1.2', skillMd: 'x', result: { ...RESULT, excerpts: [], incomplete: [] }, marker,
  });
  assert.match(first, /Base: none, first check/);
  assert.match(first, /built-in skill file `agents\/valkey-review\/config\/skill\.md`/);
  assert.equal(first.includes(`<<<DIFF ${marker}\n`), false);
  assert.match(first, /## Diff excerpts since the last check\n\n\(none\)/);
});

test('the shipped audit prompt has its sections, its limits filled in and the tools the audit gets', () => {
  const raw = readFileSync(new URL('../config/skill-check.md', import.meta.url), 'utf8');
  const prompt = renderCheckPrompt(raw);
  assert.equal(/\{\{/.test(prompt), false);
  const headings = [...prompt.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(headings, ['Identity', 'Untrusted input', 'Inputs', 'Tools', 'Workflow', 'Edit contract', 'Verdict rules', 'Completion criteria']);
  const tools = prompt.slice(prompt.indexOf('## Tools'), prompt.indexOf('## Workflow'));
  const named = [...tools.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]).sort();
  assert.deepEqual(named, [...CHECK_TOOL_NAMES].sort());
  assert.match(prompt, /At most 6 edits per report/);
  assert.match(prompt, /at most 5 lines and 800 characters/);
  assert.match(prompt, /After 2 refusals/);
});
