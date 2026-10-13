import assert from 'node:assert/strict';
import test from 'node:test';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { createSkillsRepoTokenSource } from '../dist/curator/src/skills-repo-token.js';

const TOKEN = 'ghs_skills_repo_token_never_shown';
const HOUR = 60 * 60_000;
const T0 = Date.parse('2026-10-13T12:00:00Z');

function broker(responses) {
  const payloads = [];
  const invoke = async (payload) => {
    payloads.push(payload);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { invoke, payloads };
}

const issued = (token, expiresAt) => ({ token, expires_at: new Date(expiresAt).toISOString() });

test('asks the broker with only a purpose and caches the token until five minutes before expiry', async () => {
  let now = T0;
  const b = broker([issued(TOKEN, T0 + HOUR), issued('ghs_second', T0 + 2 * HOUR)]);
  const source = createSkillsRepoTokenSource({ functionName: 'skills-repo-broker', region: 'us-east-1', invoke: b.invoke, now: () => now });
  assert.equal(await source.get(), TOKEN);
  now = T0 + HOUR - 5 * 60_000 - 1;
  assert.equal(await source.get(), TOKEN);
  assert.equal(b.payloads.length, 1);
  now = T0 + HOUR - 5 * 60_000;
  assert.equal(await source.get(), 'ghs_second');
  // No repository or installation: the broker decides both.
  assert.deepEqual(b.payloads, [{ purpose: 'curator repo skill pull request' }, { purpose: 'curator repo skill pull request' }]);
});

test('concurrent callers share one broker call', async () => {
  const b = broker([issued(TOKEN, T0 + HOUR)]);
  const source = createSkillsRepoTokenSource({ functionName: 'f', region: 'us-east-1', invoke: b.invoke, now: () => T0 });
  assert.deepEqual(await Promise.all([source.get(), source.get(), source.get()]), [TOKEN, TOKEN, TOKEN]);
  assert.equal(b.payloads.length, 1);
});

test('a refusal or a malformed answer throws without the token, and the next call asks again', async () => {
  const b = broker([
    { error: 'the App is not installed on valkey-io/valkey-review-bot' },
    { token: TOKEN },
    { token: TOKEN, expires_at: 'soon' },
    'not an object',
    new Error('Lambda throttled'),
    issued(TOKEN, T0 + HOUR),
  ]);
  const source = createSkillsRepoTokenSource({ functionName: 'f', region: 'us-east-1', invoke: b.invoke, now: () => T0 });
  await assert.rejects(source.get(), { message: 'skills-repo token broker refused: the App is not installed on valkey-io/valkey-review-bot' });
  for (let i = 0; i < 3; i++) {
    await assert.rejects(source.get(), (err) => {
      assert.equal(err.message, 'skills-repo token broker refused: no token and expiry returned');
      return true;
    });
  }
  await assert.rejects(source.get(), /Lambda throttled/);
  assert.equal(await source.get(), TOKEN);
  assert.equal(b.payloads.length, 6);
});

test('by default it invokes the named Lambda function', async (t) => {
  const sent = [];
  let reply = { Payload: Buffer.from(JSON.stringify(issued(TOKEN, Date.now() + HOUR))) };
  t.mock.method(LambdaClient.prototype, 'send', async function send(command) {
    sent.push({ region: await this.config.region(), input: command.input });
    return reply;
  });
  const source = createSkillsRepoTokenSource({ functionName: 'valkey-reviewer-skills-repo-broker', region: 'eu-west-1' });
  assert.equal(await source.get(), TOKEN);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].region, 'eu-west-1');
  assert.equal(sent[0].input.FunctionName, 'valkey-reviewer-skills-repo-broker');
  assert.deepEqual(JSON.parse(Buffer.from(sent[0].input.Payload).toString('utf8')), { purpose: 'curator repo skill pull request' });

  reply = { FunctionError: 'Unhandled', Payload: Buffer.from('{"errorMessage":"boom"}') };
  const failing = createSkillsRepoTokenSource({ functionName: 'f', region: 'eu-west-1' });
  await assert.rejects(failing.get(), { message: 'skills-repo token broker failed (Unhandled)' });
  reply = { Payload: Buffer.from('not json') };
  await assert.rejects(failing.get(), { message: 'skills-repo token broker returned a payload that is not JSON' });
});
