import assert from 'node:assert/strict';
import test from 'node:test';
import './support/ts-resolve.mjs';

const { classifyCommentBody, isAuthorReplyOutsideBotThread, stripQuotesAndCode } = await import('../src/heuristics.ts');

const reason = (body) => classifyCommentBody(body).reason ?? null;

test('acknowledgements are noise', () => {
  for (const body of ['LGTM', 'thanks!', 'Done.', '+1', 'sgtm', 'will do', 'makes sense', '\u{1F44D}', 'ok!']) {
    assert.equal(reason(body), 'ack', body);
  }
});

test('"good", "good point", "good call" and "good catch" are acknowledgements', () => {
  for (const body of ['good', 'Good point.', 'good call!', 'Good catch']) {
    assert.equal(reason(body), 'ack', body);
  }
  assert.equal(reason('goodcall'), 'too-short', 'the words must be separated');
});

test('ditto, emoji-only and url-only comments are noise', () => {
  assert.equal(reason('same here'), 'ditto');
  assert.equal(reason('\u{1F680}\u{1F389}'), 'emoji-only');
  assert.equal(reason('https://github.com/valkey-io/valkey/pull/1'), 'url-only');
});

test('empty and very short comments are noise', () => {
  assert.equal(reason(''), 'too-short');
  assert.equal(reason('   '), 'too-short');
  assert.equal(reason('see above'), 'too-short');
  assert.equal(classifyCommentBody('This lock is taken twice on the error path.').noise, false);
});

test('test markers are dropped only when little else is said', () => {
  for (const body of ['test', 'testing...', 'WIP', 'please ignore', 'test, please ignore', 'nvm, found it', 'Just testing the webhook']) {
    assert.equal(reason(body), 'test-marker', body);
  }
  for (const body of [
    'Please ignore the linter warning above, but the real concern is the unchecked return value.',
    'nvm, the lock is held by the caller here so this is safe',
    'This is still WIP, but the error path leaks the buffer.',
  ]) {
    assert.equal(classifyCommentBody(body).noise, false, body);
  }
});

test('comments that mention codecov are kept', () => {
  assert.equal(classifyCommentBody('The codecov report shows this branch is never tested.').noise, false);
  assert.equal(classifyCommentBody('codecov is flaky here, the real failure is the timeout').noise, false);
});

test('a short question is kept, even when it starts with a mention', () => {
  assert.equal(classifyCommentBody('@alice is this safe?').noise, false);
  assert.equal(classifyCommentBody('why?').noise, false);
  assert.equal(reason('@alice PTAL'), 'mention-short');
  assert.equal(reason('@alice can you take a look'), 'mention-short');
});

test('a question mark inside a quote or code does not exempt a comment', () => {
  assert.equal(reason('> is this safe?\nyes'), 'too-short');
  assert.equal(reason('`x?` ok then'), 'too-short');
});

test('a suggestion block is kept however short', () => {
  assert.equal(classifyCommentBody('```suggestion\nreturn C_ERR;\n```').noise, false);
});

test('a quote with almost no reply is noise', () => {
  assert.equal(reason('> the lock is held here\n> by the caller\n> always\n+1 agreed'), 'quote-heavy');
  assert.equal(classifyCommentBody('> the lock is held here\nNo, the caller releases it before calling this function.').noise, false);
});

test('stripQuotesAndCode removes fenced blocks, inline code and quotes', () => {
  assert.equal(stripQuotesAndCode('before\n```c\nint x;\n```\nafter'), 'before\n \nafter');
  assert.equal(stripQuotesAndCode('a ~~~\ncode\n~~~ b'), 'a   b');
  assert.equal(stripQuotesAndCode('text\n```\nunclosed fence'), 'text');
  assert.equal(stripQuotesAndCode('use `foo()` here'), 'use   here');
  assert.equal(stripQuotesAndCode('> quoted\nreply'), 'reply');
});

test('the PR author replying outside a bot thread is dropped', () => {
  const base = { commenterLogin: 'Author', prAuthorLogin: 'author' };
  assert.equal(isAuthorReplyOutsideBotThread({ ...base, parentIsApp: false }), true);
  assert.equal(isAuthorReplyOutsideBotThread({ ...base, parentIsApp: true }), false);
  assert.equal(isAuthorReplyOutsideBotThread({ commenterLogin: 'maintainer', prAuthorLogin: 'author', parentIsApp: false }), false);
  assert.equal(isAuthorReplyOutsideBotThread({ commenterLogin: 'author', prAuthorLogin: '', parentIsApp: false }), false);
});
