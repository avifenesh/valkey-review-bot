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

test('the curator is told to start from get_skill and never to touch suppression markers', () => {
  for (const file of ['../config/prompt.md', '../skills/how-to-write-a-skill.md']) {
    const text = read(file);
    assert.match(text, /call `get_skill\(area_bucket, record_id\)`/i, file);
    assert.match(text, /Never write, edit or remove (?:these markers|a marker)/, file);
    assert.match(text, /`<!-- suppressed: \.\.\. -->`/, file);
    assert.match(text, /`<!-- \/suppressed -->`/, file);
    assert.match(text, /retired_reason` (?:is )?`operator`, do not submit/, file);
    assert.match(text, /If maintainers stop reinforcing it, the skill is retired and the record kept; a later reinforcement can restore it\./, file);
    assert.doesNotMatch(text, /decay removes/i, file);
  }
  const skill = read('../config/skill.md');
  assert.match(skill, /Retired records are bumped, never recreated/);
  assert.match(skill, /Never write, edit or remove a suppression marker/);
});
