import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkGitArgs } from '../dist/common/src/tools/git.js';

const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');

test('skill authoring guidance asks for reviewer tool calls, not shell commands', () => {
  // Graduated skills go to reviewers, whose tools take argv arrays and have no shell.
  for (const file of ['../config/prompt.md', '../skills/how-to-write-a-skill.md']) {
    assert.doesNotMatch(read(file), /shell one-liner/i, file);
  }
  const guide = read('../skills/how-to-write-a-skill.md');
  const example = guide.match(/the `git` tool with `(\[[^`]+\])`/);
  assert.ok(example, 'the guide shows a git tool call');
  const args = JSON.parse(example[1]).map((a) => a.replace('<mergeBase>..<head>', 'abc..def'));
  assert.equal(checkGitArgs(args), null, 'the git tool accepts the example');
});
