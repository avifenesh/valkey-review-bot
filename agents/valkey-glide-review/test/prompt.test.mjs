import '../../common/test/support/ts-resolve.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const { renderPrOverview } = await import('../../common/src/workspace.ts');

// Every optional section of the overview present.
const ctx = {
  owner: 'o', repo: 'r', prNumber: 1, headSha: 'h'.repeat(40), baseSha: 'b'.repeat(40), mergeBaseSha: 'm'.repeat(40),
  headRef: 'topic', baseRef: 'main', author: 'a', title: 't', body: 'b', state: 'open',
  additions: 1, deletions: 1, changedFiles: 1, fileList: ['glide-core/src/client/mod.rs'],
  existingReviews: [{ id: 1, user: 'u', state: 'COMMENTED', submittedAt: null, body: 'r' }],
  existingReviewComments: [{ id: 2, user: 'u', path: 'glide-core/src/client/mod.rs', line: 1, originalLine: 1, body: 'c', diffHunk: '' }],
  existingIssueComments: [{ id: 3, user: 'u', body: 'c' }],
  previousState: { id: 4, body: 's' }, upstreamRepo: 'o/r',
  releaseLines: [{ branch: '9.0', lastCommit: '2026-09-21' }],
  workspacePath: '/workspace/valkey-glide', diffRefSpec: 'm..h',
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
