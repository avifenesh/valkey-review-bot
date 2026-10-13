import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import test from 'node:test';
import './support/ts-resolve.mjs';

const { lowercaseHeaders, rawBody, verifySignature } = await import('../src/signature.ts');

const SECRET = 'webhook-secret';
const sign = (bytes, secret = SECRET) => `sha256=${crypto.createHmac('sha256', secret).update(bytes).digest('hex')}`;

test('a correct signature over the body verifies', () => {
  const body = Buffer.from('{"action":"opened"}');
  assert.equal(verifySignature(body, sign(body), SECRET), true);
});

test('a signature from another secret or over another body fails', () => {
  const body = Buffer.from('{"action":"opened"}');
  assert.equal(verifySignature(body, sign(body, 'other-secret'), SECRET), false);
  assert.equal(verifySignature(Buffer.from('{"action":"closed"}'), sign(body), SECRET), false);
});

test('a header without the sha256= prefix fails', () => {
  const body = Buffer.from('{}');
  const hex = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  assert.equal(verifySignature(body, hex, SECRET), false);
  assert.equal(verifySignature(body, `sha1=${hex}`, SECRET), false);
  assert.equal(verifySignature(body, undefined, SECRET), false);
  assert.equal(verifySignature(body, '', SECRET), false);
});

test('a header of the wrong length fails without throwing', () => {
  const body = Buffer.from('{}');
  const good = sign(body);
  assert.equal(verifySignature(body, good.slice(0, -1), SECRET), false);
  assert.equal(verifySignature(body, `${good}0`, SECRET), false);
  assert.equal(verifySignature(body, 'sha256=', SECRET), false);
});

test('an empty secret never verifies', () => {
  const body = Buffer.from('{}');
  assert.equal(verifySignature(body, sign(body, ''), ''), false);
});

test('a base64 body is checked as the bytes GitHub sent', () => {
  // Not valid UTF-8: decoding to a string first would change the bytes.
  const bytes = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]);
  const event = { body: bytes.toString('base64'), isBase64Encoded: true };
  const body = rawBody(event);
  assert.deepEqual(body, bytes);
  assert.equal(verifySignature(body, sign(bytes), SECRET), true);
  assert.equal(verifySignature(Buffer.from(bytes.toString('utf8')), sign(bytes), SECRET), false);
});

test('a plain body is read as UTF-8 and a missing body is empty', () => {
  assert.deepEqual(rawBody({ body: '{"k":"é"}' }), Buffer.from('{"k":"é"}', 'utf8'));
  assert.deepEqual(rawBody({}), Buffer.alloc(0));
});

test('header names are lowercased', () => {
  assert.deepEqual(lowercaseHeaders({ headers: { 'X-GitHub-Event': 'ping', 'X-Empty': undefined } }), {
    'x-github-event': 'ping',
    'x-empty': '',
  });
});
