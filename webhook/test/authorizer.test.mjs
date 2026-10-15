import assert from 'node:assert/strict';
import test from 'node:test';
import './support/ts-resolve.mjs';

const { handler, isGitHubDeliveryShape } = await import('../src/authorizer.ts');

const DELIVERY = {
  'x-hub-signature-256': `sha256=${'a1'.repeat(32)}`,
  'x-github-event': 'pull_request',
  'x-github-delivery': '72d3162e-cc78-11e3-81ab-4c9367dc0958',
  'user-agent': 'GitHub-Hookshot/044aadd',
};

test('a request shaped like a GitHub delivery is authorized', async () => {
  assert.equal(isGitHubDeliveryShape(DELIVERY), true);
  assert.deepEqual(await handler({ headers: DELIVERY }), { isAuthorized: true });
});

test('header names match in any case', () => {
  const mixed = Object.fromEntries(Object.entries(DELIVERY).map(([k, v]) => [k.toUpperCase(), v]));
  assert.equal(isGitHubDeliveryShape(mixed), true);
});

test('a missing GitHub header is rejected', async () => {
  for (const name of Object.keys(DELIVERY)) {
    const { [name]: _dropped, ...rest } = DELIVERY;
    assert.equal(isGitHubDeliveryShape(rest), false, name);
  }
  assert.deepEqual(await handler({}), { isAuthorized: false });
});

test('a malformed header is rejected', () => {
  const bad = {
    'x-hub-signature-256': ['sha1=' + 'a1'.repeat(20), `sha256=${'a1'.repeat(31)}`, `sha256=${'G1'.repeat(32)}`, ''],
    'x-github-event': ['Pull_Request', 'pull request', 'x'.repeat(65)],
    'x-github-delivery': ['not a uuid', 'x'.repeat(65)],
    'user-agent': ['curl/8.0', 'github-hookshot/1', ''],
  };
  for (const [name, values] of Object.entries(bad)) {
    for (const value of values) assert.equal(isGitHubDeliveryShape({ ...DELIVERY, [name]: value }), false, `${name}=${value}`);
  }
});
