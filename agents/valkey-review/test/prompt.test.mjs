import '../../common/test/support/ts-resolve.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const { renderPrOverview } = await import('../../common/src/workspace.ts');
const { labelSuppressedPieces } = await import('../../common/src/graduated-skills.ts');

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
  assert.ok(!prompt.includes('Fix-verification re-review'));
});

test('a wrong finding is dropped, not resolved, by one rule in the prompt and the overview', () => {
  const prompt = readFileSync(new URL('../config/prompt.md', import.meta.url), 'utf8');
  const disputed = prompt.split('\n').find((l) => l.startsWith('  - **Finding disputed.**'));
  assert.ok(disputed?.includes('withdraw the finding: drop it from `state` and give the reason in `summary`. Do not mark it resolved, which means fixed at the current head.'));
  const carryOver = prompt.split('\n').find((l) => l.startsWith('- **Carry over.**'));
  assert.ok(carryOver?.includes('Mark one resolved only when it is fixed at the current head, after checking it there. Drop an earlier finding only if it is shown to be wrong, and give the reason in `summary`.'));
  // The overview restates the carry-over rule next to the previous state.
  assert.ok(renderPrOverview(ctx).includes('marked resolved if it is fixed at the current head or else still open. Drop one only if it is shown to be wrong, and give the reason in `summary`.'));
});

test('the prompt describes superseded skill pieces as the reviewer sees them', () => {
  const prompt = readFileSync(new URL('../config/prompt.md', import.meta.url), 'utf8');
  const para = prompt.split('\n').find((l) => l.startsWith('Some skill pieces, '));
  assert.ok(para, 'the paragraph is in "The correctness bar"');
  // A block as the release check writes it, and as the renderer labels it.
  const marker = (release) => `<!-- suppressed: superseded in ${release}, 2026-10-13; \`a\` is now \`b\`; evidence: valkey-io/valkey@${'0'.repeat(40)}:src/a.c:1 -->`;
  const block = (release) => [marker(release), 'old', '<!-- /suppressed -->', 'new'].join('\n');
  const [open, piece, close, replacement] = labelSuppressedPieces(block('9.1.2')).split('\n');
  assert.deepEqual([piece, replacement], ['old', 'new']);
  // The prompt quotes the labels, with the release as <release>, and never the raw markers.
  const openLabel = open.slice(0, open.indexOf('.**') + 3).replace('9.1.2', '<release>');
  assert.equal(openLabel, '**Superseded in <release>.**');
  assert.ok(para.includes(`\`${openLabel}\``) && para.includes(`\`${close}\``), para);
  assert.doesNotMatch(para, /<!--|-->/);
  // A check with no release names a branch and commit.
  assert.ok(labelSuppressedPieces(block('unstable@0eb4ba3c1d2e')).startsWith('**Superseded in unstable@0eb4ba3c1d2e.**'));
  assert.ok(para.includes('`<branch>@<commit>`'));
  assert.match(para, /describes the code before that release/);
  assert.match(para, /matters for backports to older release lines and must not be applied to the current head of the default branch; there, use its replacement\./);
  assert.ok(prompt.indexOf(para) < prompt.indexOf('\nConfidence:\n'));
});

// Reads the GLIDE reviewer's prompt too, so it needs the whole repository
// checked out, as CI has it; the reviewer images do not run tests.
test('the reviewer prompts share the mention and suppressed-skill text', () => {
  const valkey = readFileSync(new URL('../config/prompt.md', import.meta.url), 'utf8');
  const glide = readFileSync(new URL('../../valkey-glide-review/config/prompt.md', import.meta.url), 'utf8');
  const section = (prompt) => prompt.slice(prompt.indexOf('## Mention-triggered reviews'), prompt.indexOf('\n## ', prompt.indexOf('## Mention-triggered reviews') + 1));
  // The only intended difference: what a request can single out.
  assert.equal(section(valkey).replace('a specific file,', 'a specific binding,'), section(glide));
  const para = (prompt) => prompt.split('\n').find((l) => l.startsWith('Some skill pieces, '));
  assert.equal(para(valkey), para(glide));
});
