import '../../common/test/support/ts-resolve.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const { renderPrOverview } = await import('../../common/src/workspace.ts');

// Every optional section of the overview present.
const ctx = {
  owner: 'o', repo: 'r', prNumber: 1, headSha: 'h'.repeat(40), baseSha: 'b'.repeat(40), mergeBaseSha: 'm'.repeat(40),
  headRef: 'topic', baseRef: 'unstable', author: 'a', title: 't', body: 'b', state: 'open',
  additions: 1, deletions: 1, changedFiles: 1, fileList: ['src/server.c'],
  existingReviews: [{ id: 1, user: 'u', state: 'COMMENTED', submittedAt: null, body: 'r' }],
  existingReviewComments: [{ id: 2, user: 'u', path: 'src/server.c', line: 1, originalLine: 1, body: 'c', diffHunk: '' }],
  existingIssueComments: [{ id: 3, user: 'u', body: 'c' }],
  previousState: { id: 4, body: 's' }, upstreamRepo: 'o/r',
  releaseLines: [{ branch: '9.0', lastCommit: '2026-09-21' }],
  workspacePath: '/workspace/valkey', diffRefSpec: 'm..h',
};

test('the prompt names first-message sections as the overview titles them', () => {
  const prompt = readFileSync(new URL('../config/prompt.md', import.meta.url), 'utf8');
  const headings = renderPrOverview(ctx).split('\n')
    .filter((l) => l.startsWith('## '))
    .map((l) => l.slice(3).replace(/ \(.*\)$/, ''));
  for (const name of ['Existing inline comments', 'Maintained release lines', 'Your previous review state']) {
    assert.ok(prompt.includes(`"${name}"`), `the prompt refers to "${name}"`);
    assert.ok(headings.includes(name), `the overview has a "${name}" section`);
  }
  // The model sees rendered sections, never the PrContext field names.
  for (const key of Object.keys(ctx).filter((k) => /[A-Z]/.test(k))) {
    assert.ok(!prompt.includes(`\`${key}\``), `the prompt names the field ${key}`);
  }
});

test('the prompt covers each kind of reply in a review thread', () => {
  const prompt = readFileSync(new URL('../config/prompt.md', import.meta.url), 'utf8');
  const start = prompt.indexOf('- **Replies in your review thread.**');
  const end = prompt.indexOf('- Terminal behavior is unchanged', start);
  assert.ok(start >= 0 && end > start, 'the bullet sits in "Mention-triggered reviews"');
  const bullet = prompt.slice(start, end);
  for (const kind of ['**Fix claimed.**', '**Finding disputed.**', '**Question.**']) {
    assert.ok(bullet.includes(`  - ${kind}`), kind);
  }
  assert.match(bullet, /never act as the author, apply changes/);
  assert.match(bullet, /Do not rubber-stamp a fix/);
  assert.match(bullet, /When the fix holds, mark that finding resolved in `state`\./);
  // A withdrawn finding follows the carry-over rule of the review state.
  assert.match(bullet, /withdraw the finding: drop it from `state` and say why in `summary`\./);
  assert.match(prompt, /Drop an earlier finding only if it turns out to be wrong, and say so in `summary`\./);
  assert.ok(!prompt.includes('Fix-verification re-review'));
});
