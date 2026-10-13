import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  MAKE_ALLOWED_TARGETS, MAKE_ALLOWED_VARS, buildToolEnabled, makeArgs,
} from '../src/tools/make-policy.ts';

test('allowed targets and vars become make argv', () => {
  assert.deepEqual(
    makeArgs({ targets: ['valkey-server', 'test-unit'], vars: { SANITIZER: 'address', CFLAGS: '-O0 -g' }, parallel: 4 }),
    { args: ['-j4', 'valkey-server', 'test-unit', 'SANITIZER=address', 'CFLAGS=-O0 -g'] },
  );
});

test('targets that are not real or that run distclean are refused', () => {
  for (const t of ['help', 'persist-settings', 'distclean', 'install', 'test', 'uninstall']) {
    const r = makeArgs({ targets: [t], parallel: 1 });
    assert.ok('error' in r, t);
    assert.match(r.error, new RegExp(`"${t}" not allowed`));
  }
});

test('unknown vars and unsafe values are refused', () => {
  assert.ok('error' in makeArgs({ targets: ['all'], vars: { CC: 'clang' }, parallel: 1 }));
  assert.ok('error' in makeArgs({ targets: ['all'], vars: { CFLAGS: '-O0; rm -rf /' }, parallel: 1 }));
  assert.ok('error' in makeArgs({ targets: ['all'], vars: { CFLAGS: '$(shell id)' }, parallel: 1 }));
});

test('ALLOW_BUILD enables the tool and ALLOW_MAKE is an alias', () => {
  assert.equal(buildToolEnabled({}), false);
  assert.equal(buildToolEnabled({ ALLOW_BUILD: 'true' }), true);
  assert.equal(buildToolEnabled({ ALLOW_BUILD: 'TRUE' }), true);
  assert.equal(buildToolEnabled({ ALLOW_MAKE: 'true' }), true);
  assert.equal(buildToolEnabled({ ALLOW_BUILD: 'false', ALLOW_MAKE: 'true' }), false);
  assert.equal(buildToolEnabled({ ALLOW_BUILD: '', ALLOW_MAKE: 'true' }), true);
  assert.equal(buildToolEnabled({ ALLOW_BUILD: 'yes' }), false);
});

test('the prompt lists exactly the targets and vars the tool accepts', () => {
  const prompt = readFileSync(new URL('../config/prompt.md', import.meta.url), 'utf8');
  const listed = (label) => {
    const line = prompt.split('\n').find((l) => l.startsWith(`- ${label}:`));
    assert.ok(line, `prompt has a "- ${label}:" line`);
    return [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  };
  assert.deepEqual(listed('Targets'), [...MAKE_ALLOWED_TARGETS]);
  assert.deepEqual(listed('Vars'), [...MAKE_ALLOWED_VARS]);
});

// The prompt tells the reviewer to write without em dashes, so its own
// prose and the skill's do the same.
test('the prompt and the skill have no em dashes', () => {
  for (const file of ['prompt.md', 'skill.md']) {
    const text = readFileSync(new URL(`../config/${file}`, import.meta.url), 'utf8');
    const lines = text.split('\n').map((l, i) => `${i + 1}: ${l}`).filter((l) => l.includes('—'));
    assert.deepEqual(lines, [], file);
  }
});
