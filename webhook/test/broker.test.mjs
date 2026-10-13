import assert from 'node:assert/strict';
import test from 'node:test';
import './support/ts-resolve.mjs';
import { fakeGitHub } from './support/fakes.mjs';

const { createTokenBroker } = await import('../src/broker.ts');

const REPO = 'example-org/valkey';
const INSTALLATION = 42;
const installed = (id = INSTALLATION, login = 'example-org') => ({ status: 200, json: { id, account: { login } } });

function setup({ github = { [`GET repos/${REPO}/installation`]: installed() }, allowedRepos = [REPO, 'example-org/valkey-glide'] } = {}) {
  const issued = [];
  const logs = [];
  const api = fakeGitHub(github);
  const broker = createTokenBroker({
    allowedRepos,
    appApi: async () => api,
    issueToken: async (request) => {
      issued.push(request);
      return { token: 'ghs_test', expiresAt: '2026-10-13T13:00:00Z' };
    },
    log: (line) => logs.push(line),
    warn: (line) => logs.push(line),
  });
  return { broker, issued, logs, api };
}

test('issues a token for one routed repository from the App installation on its owner', async () => {
  const { broker, issued, api } = setup();
  assert.deepEqual(await broker({ installation_id: INSTALLATION, repo: REPO }), { token: 'ghs_test', expires_at: '2026-10-13T13:00:00Z' });
  assert.deepEqual(api.calls.map((c) => `${c.method} ${c.path}`), [`GET repos/${REPO}/installation`]);
  assert.deepEqual(issued, [{
    installationId: INSTALLATION,
    repositoryNames: ['valkey'],
    permissions: { pull_requests: 'write', metadata: 'read' },
  }]);
});

test('refuses an installation id that is not the App installation on the repository', async () => {
  // Another installation of the App, for example on someone's fork named
  // "valkey", would turn repositoryNames ["valkey"] into a token for that fork.
  const { broker, issued, logs } = setup();
  const result = await broker({ installation_id: 99, repo: REPO });
  assert.deepEqual(result, { error: `installation 99 is not the App's installation on ${REPO}` });
  assert.deepEqual(issued, []);
  assert.match(logs.join('\n'), /refused repo=example-org\/valkey installation=99/);
});

test('refuses when the installation belongs to another account', async () => {
  const { broker, issued } = setup({ github: { [`GET repos/${REPO}/installation`]: installed(INSTALLATION, 'someone-else') } });
  assert.match((await broker({ installation_id: INSTALLATION, repo: REPO })).error, /not the App's installation/);
  assert.deepEqual(issued, []);
});

test('refuses when the App is not installed on the repository', async () => {
  const { broker, issued } = setup({ github: { [`GET repos/${REPO}/installation`]: { status: 404, json: {} } } });
  assert.deepEqual(await broker({ installation_id: INSTALLATION, repo: REPO }), { error: `the App is not installed on ${REPO}` });
  assert.deepEqual(issued, []);
});

test('a GitHub error fails the call without issuing a token', async () => {
  for (const response of [{ status: 500, json: {} }, { status: 200, json: { id: INSTALLATION } }]) {
    const { broker, issued } = setup({ github: { [`GET repos/${REPO}/installation`]: response } });
    await assert.rejects(broker({ installation_id: INSTALLATION, repo: REPO }), /repos\/example-org\/valkey\/installation/);
    assert.deepEqual(issued, []);
  }
});

test('repository and owner match without regard to case', async () => {
  const { broker, issued } = setup({
    github: { 'GET repos/Example-Org/Valkey/installation': installed(INSTALLATION, 'example-org') },
  });
  assert.equal((await broker({ installation_id: INSTALLATION, repo: 'Example-Org/Valkey' })).token, 'ghs_test');
  assert.deepEqual(issued[0].repositoryNames, ['Valkey']);
});

test('refuses repositories outside the routed set and malformed requests without calling GitHub', async () => {
  const { broker, issued, api } = setup();
  assert.deepEqual(await broker({ installation_id: INSTALLATION, repo: 'example-org/other' }),
    { error: 'repo example-org/other is not a routed repository' });
  assert.deepEqual(await broker({ installation_id: INSTALLATION, repo: 'someone-else/valkey' }),
    { error: 'repo someone-else/valkey is not a routed repository' });
  for (const installation_id of [undefined, 0, -1, 1.5, 'x']) {
    assert.deepEqual(await broker({ installation_id, repo: REPO }), { error: 'invalid installation_id' });
  }
  for (const repo of [undefined, '', 'valkey', 'example-org/valkey/extra', '/valkey', 'example-org/']) {
    assert.deepEqual(await broker({ installation_id: INSTALLATION, repo }), { error: 'repo must be "owner/name"' });
  }
  assert.deepEqual(api.calls, []);
  assert.deepEqual(issued, []);
});
