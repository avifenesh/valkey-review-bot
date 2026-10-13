import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRegistryControlClient } from '@aws-sdk/client-agent-registry-control';
import './support/ts-resolve.mjs';

const { labelSuppressedPieces, loadGraduatedSkills, renderGraduatedSkills } = await import('../src/graduated-skills.ts');
const { GRADUATED_SKILL_MAX_CHARS } = await import('../src/skills-registry.ts');
const { listSuppressedBlocks, skillLayout } = await import('../src/skill-check/edits.ts');

/** Answers list and get calls from `records`, like the registry control plane. */
function fakeRegistry(t, records) {
  t.mock.method(AgentRegistryControlClient.prototype, 'send', async (command) => {
    const op = command.constructor.name;
    if (op === 'ListRegistryRecordsCommand') return { registryRecords: records };
    if (op === 'GetRegistryRecordCommand') {
      const r = records.find((x) => x.recordId === command.input.recordId);
      return { ...r, descriptors: { agentSkillsDefinition: { additionalData: { skillMd: { data: r.md } } } } };
    }
    throw new Error(`unexpected ${op}`);
  });
}

const rec = (id, updated, md) => ({ recordId: id, name: id, recordArn: `arn:${id}`, status: 'DRAFT', updatedAt: new Date(updated), md });

test('the default budget loads a skill of the largest size the curator may submit', async (t) => {
  const largest = `---\nname: big\n---\n${'x'.repeat(GRADUATED_SKILL_MAX_CHARS)}`;
  fakeRegistry(t, [rec('big', '2026-10-01', largest)]);
  const skills = await loadGraduatedSkills({ registryId: 'reg', region: 'us-west-2' });
  assert.deepEqual(skills.map((s) => s.name), ['big']);
});

test('the warning counts every skill the budget left out, not only older ones', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (msg) => warnings.push(msg));
  const md = (n) => `---\nname: s\n---\n${'x'.repeat(n)}`;
  fakeRegistry(t, [
    rec('old', '2026-10-01', md(10)),
    rec('new', '2026-10-03', md(600)),
    rec('mid', '2026-10-02', md(600)),
  ]);
  const skills = await loadGraduatedSkills({ registryId: 'reg', region: 'us-west-2', maxChars: 1000 });
  assert.deepEqual(skills.map((s) => s.name), ['new', 'old']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /loaded 2; 1 skill\(s\) left out by the limits \(30 skills, 1000 characters\)/);
});

const skill = (overrides = {}) => ({
  recordArn: 'arn:lock-order',
  name: 'lock-order',
  description: 'Use when reviewing a PR that touches `src/networking.c`.\n\nGraduated from concern record_id=3f2a9c1e-0b7d-4e55-9a51-2c6f0d8e7b10.',
  status: 'DRAFT',
  skillMd: [
    '---',
    'name: lock-order',
    'description: "Use when reviewing a PR that touches `src/networking.c`."',
    '---',
    '',
    '## Use when',
    'A diff takes `c->lock` in `src/networking.c`.',
    '',
    '## Patterns',
    '',
    '### Lock order',
    'Skip unless: `lockClient` appears in the diff.',
  ].join('\n'),
  ...overrides,
});

test('rendering drops the frontmatter and nests the skill headings under the skill name', () => {
  const out = renderGraduatedSkills([skill()]);
  assert.doesNotMatch(out, /name: lock-order|description: "/);
  assert.ok(out.includes('## lock-order\n'));
  assert.ok(out.includes('\n### Use when\nA diff takes `c->lock` in `src/networking.c`.\n\n### Patterns\n\n#### Lock order\nSkip unless:'));
  assert.doesNotMatch(out, /^## (Use when|Patterns)$/m);
});

test('the description is one plain Scope line without the record id sentence', () => {
  const out = renderGraduatedSkills([skill()]);
  assert.ok(out.includes('## lock-order\nScope: Use when reviewing a PR that touches `src/networking.c`.\n\n'));
  assert.doesNotMatch(out, /record_id|Graduated from concern/);
  assert.doesNotMatch(out, /^_.*_$/m);
  const wrapped = renderGraduatedSkills([skill({ description: 'Use when reviewing\n  `src/db.c`.\nDoes NOT apply to `src/rdb.c`.' })]);
  assert.ok(wrapped.includes('\nScope: Use when reviewing `src/db.c`. Does NOT apply to `src/rdb.c`.\n'));
  const idOnly = renderGraduatedSkills([skill({ description: 'Graduated from concern record_id=abc.' })]);
  assert.ok(idOnly.includes('## lock-order\n\n'));
  assert.doesNotMatch(idOnly, /Scope:/);
});

test('the record id citation at the end of the body is not rendered', () => {
  const id = '3f2a9c1e-0b7d-4e55-9a51-2c6f0d8e7b10';
  const ending = (last) => skill({ skillMd: `${skill().skillMd}\n\n${last}\n` });
  for (const last of [`_(graduated from concern record_id=${id})_`, `*(Graduated from concern record_id=${id})*`, `(graduated from concern record_id=${id})  `]) {
    const out = renderGraduatedSkills([ending(last)]);
    assert.doesNotMatch(out, /record_id|graduated from concern/i, last);
    assert.ok(out.endsWith('Skip unless: `lockClient` appears in the diff.\n'), last);
  }
  const inline = renderGraduatedSkills([skill({ skillMd: `Check the lock order. _(graduated from concern record_id=${id})_` })]);
  assert.ok(inline.includes('\nCheck the lock order.\n'));
  assert.doesNotMatch(inline, /record_id/);
  const crlf = renderGraduatedSkills([skill({ skillMd: ['## Use when', 'body', `_(graduated from concern record_id=${id})_`, 'tail'].join('\r\n') })]);
  assert.ok(crlf.includes(['### Use when', 'body', 'tail'].join('\r\n')));
  // In a fenced block it is an example, so it stays.
  const fenced = ['```', `_(graduated from concern record_id=${id})_`, '```'].join('\n');
  assert.ok(renderGraduatedSkills([skill({ skillMd: fenced })]).includes(fenced));
});

test('a long run of whitespace renders in linear time', () => {
  const run = ' '.repeat(100_000);
  const citation = '_(graduated from concern record_id=abc)_';
  for (const [line, want] of [[run, run], [`${run}x`, `${run}x`], [`${run}\t${citation}`, null], [`body${run}${citation}`, 'body']]) {
    const start = performance.now();
    const out = renderGraduatedSkills([skill({ skillMd: `## Use when\n${line}\ntail` })]);
    const ms = performance.now() - start;
    // Quadratic matching takes seconds here.
    assert.ok(ms < 250, `${ms.toFixed(0)} ms for a line of ${line.length} characters`);
    assert.ok(out.includes(want === null ? '### Use when\ntail' : `### Use when\n${want}\ntail`));
  }
  for (const [description, scope] of [[`Use when${run}x`, 'Use when x'], [`Use when x.${run}Graduated from concern record_id=abc.${run}`, 'Use when x.']]) {
    const start = performance.now();
    const out = renderGraduatedSkills([skill({ description })]);
    const ms = performance.now() - start;
    assert.ok(ms < 250, `${ms.toFixed(0)} ms for a description of ${description.length} characters`);
    assert.ok(out.includes(`\nScope: ${scope}\n`));
  }
});

test('the introduction says the code at the PR head wins', () => {
  const out = renderGraduatedSkills([skill()]);
  assert.doesNotMatch(out, /Treat as established conventions/);
  assert.ok(out.includes('Several maintainers confirmed each of these rules, and each is re-checked against the upstream default branch after releases. '
    + 'A rule is a reason to look; the code at the PR head wins. '
    + 'Confirm that the files and names a rule cites exist in this checkout before relying on it.'));
  assert.equal(renderGraduatedSkills([]), '');
});

test('headings in fenced blocks are left alone', () => {
  const md = [
    '## Always-on checks',
    '```sh',
    '# a shell comment',
    '```',
    '~~~~markdown',
    '## Example heading',
    '~~~',
    '# still inside the four-tilde fence',
    '~~~~',
    '# a heading again',
    '    ## indented four spaces: code, not a heading',
    '###### deepest level stays',
    '#hashtag is not a heading',
  ].join('\n');
  const out = renderGraduatedSkills([skill({ skillMd: md })]);
  assert.ok(out.includes([
    '### Always-on checks',
    '```sh',
    '# a shell comment',
    '```',
    '~~~~markdown',
    '## Example heading',
    '~~~',
    '# still inside the four-tilde fence',
    '~~~~',
    '## a heading again',
    '    ## indented four spaces: code, not a heading',
    '###### deepest level stays',
    '#hashtag is not a heading',
  ].join('\n')));
});

test('fenced blocks are the ones the release check reads', () => {
  // The check opens a fence on three backticks even when the info string
  // has a backtick, which CommonMark does not. The renderer follows it.
  assert.ok(bodyOf(['## A', '``` a`b', '# in the fence', '```', '# a heading'].join('\n'))
    .includes(['### A', '``` a`b', '# in the fence', '```', '## a heading'].join('\n')));
  assert.deepEqual(skillLayout(['---', 'name: x', '---', '``` a`b', '# b', '```', '# c'].join('\n')),
    { bodyStart: 3, fenced: [false, false, false, true, true, true, false] });
  const docs = [
    ['# a', '``` a`b', '# b', '```', '# c'],
    // a tilde line does not close a backtick fence
    ['# a', '```', '# b', '~~~', '# c', '```', '# d'],
    // a shorter run does not close a fence, a longer one does
    ['# a', '````', '# b', '```', '# c', '`````', '# d'],
    // nor does a run with text after it
    ['# a', '```', '# b', '``` x', '# c', '```', '# d'],
    // fence lines in the frontmatter do not count
    ['---', 'name: x', '```', '---', '# a', '```', '# b'],
    // nor is there frontmatter when it never closes
    ['---', '# a', '```', '# b'],
    ['# a', '    ```', '# b', '   ~~~', '# c', '   ~~~', '# d'],
    ['# a', '```', '# b'],
  ];
  for (const lines of docs) {
    for (const eol of ['\n', '\r\n']) {
      const md = lines.join(eol);
      const { bodyStart, fenced } = skillLayout(md);
      const want = md.split('\n').slice(bodyStart)
        .map((line, i) => (fenced[bodyStart + i] ? line : line.replace(/^#/, '##')));
      assert.ok(bodyOf(md).includes(want.join('\n')), md);
    }
  }
});

test('fences are found in CRLF text too', () => {
  const md = ['## A', '```sh', '# a shell comment', '```', '# a heading'].join('\r\n');
  assert.ok(renderGraduatedSkills([skill({ skillMd: md })]).includes(['### A', '```sh', '# a shell comment', '```', '## a heading'].join('\r\n')));
});

test('markdown without a complete frontmatter block is kept whole', () => {
  const out = renderGraduatedSkills([skill({ skillMd: '---\nname: broken\n## Use when\nbody' })]);
  assert.ok(out.includes('---\nname: broken\n### Use when\nbody'));
});

const SHA = '0eb4ba3c1d2e4f5a6b7c8d9e0f1a2b3c4d5e6f7a';
const SHA64 = `${SHA}${'9'.repeat(24)}`;
const openMarker = (tag = '9.1.2', evidence = `valkey-io/valkey@${SHA}:src/db.c:512`) =>
  `<!-- suppressed: superseded in ${tag}, 2026-10-13; \`emptyDB\` is now \`emptyData\`; evidence: ${evidence} -->`;
const CLOSE = '<!-- /suppressed -->';
const openLabel = (tag) => `**Superseded in ${tag}.** The text from here to "End of superseded text" describes code before ${tag}. `
  + 'It can still hold on older release lines, so it matters for backports to them; do not apply it to the current head.';
const CLOSE_LABEL = '**End of superseded text.**';

const bodyOf = (skillMd) => renderGraduatedSkills([skill({ skillMd })]);

test('a suppressed piece is kept, labelled with the release that superseded it, before its replacement', () => {
  const piece = ['- `emptyDB(-1, EMPTYDB_NO_FLAGS, NULL)` clears every database;  ', '  callers pass `EMPTYDB_ASYNC` to free in the background.'];
  const md = ['## Patterns', 'Before.', openMarker(), ...piece, CLOSE, '- `emptyData(-1, EMPTYDB_NO_FLAGS, NULL)` clears every database.', 'After.'].join('\n');
  const out = bodyOf(md);
  assert.ok(out.includes(['### Patterns', 'Before.', openLabel('9.1.2'), ...piece, CLOSE_LABEL, '- `emptyData(-1, EMPTYDB_NO_FLAGS, NULL)` clears every database.', 'After.'].join('\n')));
  assert.doesNotMatch(out, /<!--|-->|is now|evidence|valkey-io\/valkey@/);
});

test('every suppressed block in a skill gets its own label, and headings inside are demoted', () => {
  const md = [
    openMarker('v2.5.3', `valkey-io/valkey-glide@${SHA}:glide-core/src/client/mod.rs:88, valkey-io/valkey-glide@${SHA64}:glide-core/src/lib.rs:7`),
    '## Old heading',
    CLOSE,
    '## New heading',
    '',
    `  ${openMarker('9.0.6')}  `,
    '  - old item',
    `  ${CLOSE}`,
    '  - new item',
  ].join('\n');
  assert.ok(bodyOf(md).includes([
    openLabel('v2.5.3'), '### Old heading', CLOSE_LABEL, '### New heading', '', `  ${openLabel('9.0.6')}`, '  - old item', `  ${CLOSE_LABEL}`, '  - new item',
  ].join('\n')));
});

test('suppression markers that do not pair up or do not have the exact form are left as written', () => {
  const cases = [
    // an open marker with no close
    [openMarker(), 'old', 'new'],
    // a close marker with no open
    ['old', CLOSE, 'new'],
    // markers inside a fenced block are text
    ['```', openMarker(), 'old', CLOSE, '```'],
    // a close inside a fence does not end a block opened outside it
    [openMarker(), '```', CLOSE, '```', 'new'],
    // no evidence, a bad date, a tag with a space, a placeholder
    ['<!-- suppressed: superseded in 9.1.2, 2026-10-13; renamed -->', 'old', CLOSE],
    [openMarker().replace('2026-10-13', '13-10-2026'), 'old', CLOSE],
    [openMarker('9.1.2 beta'), 'old', CLOSE],
    [openMarker('9.1.2', 'valkey-io/valkey@<sha>:src/db.c:512'), 'old', CLOSE],
    ['<!-- suppressed: superseded in <release tag>, <YYYY-MM-DD>; <one-line reason>; evidence: <upstream repo>@<commit sha>:<path>:<line> -->', 'old', CLOSE],
    // a reason that would end the comment early
    [openMarker().replace(' is now ', ' is --> now '), 'old', CLOSE],
    // a reason the release check did not write
    [openMarker().replace('`emptyDB` is now `emptyData`', 'emptyDB was renamed to emptyData'), 'old', CLOSE],
  ];
  for (const lines of cases) {
    const md = lines.join('\n');
    const out = bodyOf(md);
    assert.ok(out.includes(md), md);
    assert.doesNotMatch(out, /Superseded in|End of superseded text/, md);
  }
});

test('suppressed blocks in CRLF text are labelled outside fences only, keeping the line endings', () => {
  const md = ['```', openMarker(), 'fenced', CLOSE, '```', openMarker(), 'old', CLOSE, 'new'].join('\r\n');
  assert.ok(bodyOf(md).includes(['```', openMarker(), 'fenced', CLOSE, '```', openLabel('9.1.2'), 'old', CLOSE_LABEL, 'new'].join('\r\n')));
});

test('suppression does not nest: an open marker inside a block is left as written', () => {
  const md = [openMarker('9.0.6'), 'outer', openMarker('9.1.2'), 'inner', CLOSE, 'new'].join('\n');
  assert.ok(bodyOf(md).includes([openLabel('9.0.6'), 'outer', openMarker('9.1.2'), 'inner', CLOSE_LABEL, 'new'].join('\n')));
});

test('reviewers see a piece labelled exactly when the release check reads it as suppressed', () => {
  const docs = [
    [openMarker(), 'old', CLOSE, 'new'],
    // forms the check refuses: a short commit, a bare branch, a reason with "--!>"
    [openMarker('9.1.2', `valkey-io/valkey@${SHA.slice(0, 12)}:src/db.c:512`), 'old', CLOSE],
    [openMarker('unstable'), 'old', CLOSE],
    [openMarker().replace(' is now ', ' is --!> now '), 'old', CLOSE],
    // a long commit, and the branch and commit of a check without a known release, which it accepts
    [openMarker('9.1.2', `valkey-io/valkey@${SHA64}:src/db.c:512`), 'old', CLOSE],
    [openMarker('unstable@0eb4ba3c1d2e'), 'old', CLOSE],
    [openMarker('9.0.6'), 'outer', openMarker('9.1.2'), 'inner', CLOSE, 'new'],
    ['```', openMarker(), 'old', CLOSE, '```', openMarker('9.1.2'), 'two', CLOSE],
    // a marker in the frontmatter is not a block
    ['---', 'name: x', openMarker(), 'description: y', CLOSE, '---', openMarker('9.0.6'), 'body', CLOSE],
  ];
  for (const lines of docs) {
    for (const eol of ['\n', '\r\n']) {
      const md = lines.join(eol);
      const labelled = labelSuppressedPieces(md).split(eol)
        .flatMap((line, i) => (line === lines[i] ? [] : [i + 1]));
      const blocks = listSuppressedBlocks(md).flatMap((b) => [b.startLine, b.endLine]);
      assert.deepEqual(labelled, blocks, md);
    }
  }
  assert.equal(labelSuppressedPieces([openMarker('unstable@0eb4ba3c1d2e'), 'old', CLOSE].join('\n')), [openLabel('unstable@0eb4ba3c1d2e'), 'old', CLOSE_LABEL].join('\n'));
});

test('labelSuppressedPieces labels markers in skill text without touching anything else', () => {
  const md = ['# Valkey PR Reviewer Skill', '', '## Subsystem patterns', openMarker(), '`src/dict.c` holds the dict.', CLOSE, '`src/hashtable.c` holds it.', '```', CLOSE, '```'].join('\n');
  assert.equal(labelSuppressedPieces(md), [
    '# Valkey PR Reviewer Skill', '', '## Subsystem patterns', openLabel('9.1.2'), '`src/dict.c` holds the dict.', CLOSE_LABEL, '`src/hashtable.c` holds it.', '```', CLOSE, '```',
  ].join('\n'));
  const plain = '---\nname: x\n---\n## Use when\nbody';
  assert.equal(labelSuppressedPieces(plain), plain);
});
