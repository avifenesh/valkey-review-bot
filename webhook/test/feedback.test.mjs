import assert from 'node:assert/strict';
import test from 'node:test';
import './support/ts-resolve.mjs';

const { botMatcher, DEFAULT_KNOWN_BOT_LOGINS } = await import('../src/config.ts');
const { curatorEnvelope, extractFeedback } = await import('../src/feedback.ts');

const BOT = 'example-reviewer[bot]';
const isBotAuthor = botMatcher(BOT, new Set(DEFAULT_KNOWN_BOT_LOGINS));

const maintainer = { login: 'maintainer', type: 'User' };

function reviewCommentEvent(comment = {}, action = 'created') {
  return {
    action,
    pull_request: { number: 7, user: { login: 'author' } },
    comment: {
      id: 202, body: 'This is a false positive: the caller holds the lock.', user: maintainer,
      author_association: 'MEMBER', path: 'src/server.c', line: 40, in_reply_to_id: 150, ...comment,
    },
  };
}

function issueCommentEvent(comment = {}, issue = {}, action = 'created') {
  return {
    action,
    issue: { number: 9, pull_request: {}, user: { login: 'author' }, ...issue },
    comment: { id: 303, body: 'The approach looks right to me overall.', user: maintainer, author_association: 'OWNER', ...comment },
  };
}

function reviewEvent(review = {}, action = 'submitted') {
  return {
    action,
    pull_request: { number: 11, user: { login: 'author' } },
    review: { id: 404, body: 'Requesting changes for the memory leak.', user: maintainer, author_association: 'COLLABORATOR', ...review },
  };
}

test('a maintainer reply in a review thread is feedback', () => {
  assert.deepEqual(extractFeedback('pull_request_review_comment', reviewCommentEvent(), isBotAuthor), {
    item: {
      kind: 'review_comment_reply',
      feedbackId: 'rc-202',
      body: 'This is a false positive: the caller holds the lock.',
      actor: 'maintainer',
      actorAssociation: 'MEMBER',
      prNumber: 7,
      prAuthor: 'author',
      path: 'src/server.c',
      line: 40,
      parentCommentId: 150,
    },
  });
});

test('a PR conversation comment and a submitted review are feedback', () => {
  const ic = extractFeedback('issue_comment', issueCommentEvent(), isBotAuthor).item;
  assert.equal(ic.kind, 'issue_comment_reply');
  assert.equal(ic.feedbackId, 'ic-303');
  assert.equal(ic.prNumber, 9);
  assert.equal(ic.prAuthor, 'author');
  assert.equal(ic.parentCommentId, undefined);

  const r = extractFeedback('pull_request_review', reviewEvent(), isBotAuthor).item;
  assert.equal(r.kind, 'resolution');
  assert.equal(r.feedbackId, 'pr-404');
  assert.equal(r.actorAssociation, 'COLLABORATOR');
});

test('edits, deletions and dismissals are not feedback', () => {
  assert.equal(extractFeedback('pull_request_review_comment', reviewCommentEvent({}, 'edited'), isBotAuthor).skip, 'not-feedback:action=edited');
  assert.equal(extractFeedback('issue_comment', issueCommentEvent({}, {}, 'deleted'), isBotAuthor).skip, 'not-feedback:action=deleted');
  assert.equal(extractFeedback('pull_request_review', reviewEvent({}, 'dismissed'), isBotAuthor).skip, 'not-feedback:action=dismissed');
  assert.equal(extractFeedback('pull_request_review', reviewEvent({}, 'edited'), isBotAuthor).skip, 'not-feedback:action=edited');
});

test('a comment on a plain issue is not feedback', () => {
  const payload = issueCommentEvent();
  delete payload.issue.pull_request;
  assert.equal(extractFeedback('issue_comment', payload, isBotAuthor).skip, 'not-feedback:not-a-pull-request');
});

test('only owners, members and collaborators give feedback', () => {
  for (const assoc of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE', 'MANNEQUIN']) {
    const skip = extractFeedback('pull_request_review_comment', reviewCommentEvent({ author_association: assoc }), isBotAuthor).skip;
    assert.equal(skip, `not-feedback:association=${assoc}`);
  }
  assert.equal(
    extractFeedback('issue_comment', issueCommentEvent({ author_association: undefined }), isBotAuthor).skip,
    'not-feedback:association=none',
  );
  assert.equal(extractFeedback('issue_comment', issueCommentEvent({ author_association: 'member' }), isBotAuthor).item.actorAssociation, 'MEMBER');
});

test('bots never give feedback, whatever their association', () => {
  for (const user of [
    { login: 'renovate', type: 'Bot' },
    { login: 'some-app[bot]', type: 'User' },
    { login: 'Example-Reviewer[bot]', type: 'User' },
    { login: 'coderabbitai', type: 'User' },
  ]) {
    const skip = extractFeedback('issue_comment', issueCommentEvent({ user }), isBotAuthor).skip;
    assert.equal(skip, 'not-feedback:bot-author', user.login);
  }
});

test('other events and malformed payloads are not feedback', () => {
  assert.equal(extractFeedback('push', {}, isBotAuthor).skip, 'not-feedback:event=push');
  assert.equal(extractFeedback('issue_comment', issueCommentEvent({ id: undefined }), isBotAuthor).skip, 'not-feedback:malformed');
  assert.equal(extractFeedback('issue_comment', issueCommentEvent({ user: undefined }), isBotAuthor).skip, 'not-feedback:no-author');
});

test('the curator envelope carries the reply, its author and the App comment it answers', () => {
  const { item } = extractFeedback('pull_request_review_comment', reviewCommentEvent(), isBotAuthor);
  const envelope = curatorEnvelope({
    item,
    reviewerId: 'valkey-review',
    repo: 'example-org/valkey',
    installationId: 42,
    botCommentBody: 'This leaks the buffer on the error path.',
  });
  assert.deepEqual(envelope, {
    reviewer_id: 'valkey-review',
    feedback_id: 'rc-202',
    kind: 'review_comment_reply',
    human_body: 'This is a false positive: the caller holds the lock.',
    actor: 'maintainer',
    actor_association: 'MEMBER',
    repo: 'example-org/valkey',
    pr_number: 7,
    pr_author: 'author',
    bot_comment: { body: 'This leaks the buffer on the error path.', path: 'src/server.c', line: 40 },
    installation_id: 42,
  });
  assert.equal('touched_files' in envelope, false);
});

test('feedback without an anchor gets null path and line', () => {
  const { item } = extractFeedback('issue_comment', issueCommentEvent(), isBotAuthor);
  const envelope = curatorEnvelope({ item, reviewerId: 'valkey-review', repo: 'example-org/valkey', installationId: 42, botCommentBody: '' });
  assert.deepEqual(envelope.bot_comment, { body: '', path: null, line: null });
  assert.deepEqual(JSON.parse(JSON.stringify(envelope)).bot_comment, { body: '', path: null, line: null });
});
