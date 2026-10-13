import assert from 'node:assert/strict';
import test from 'node:test';
import './support/ts-resolve.mjs';
import { fakeGitHub } from './support/fakes.mjs';

const { createSkillsRepoBroker, handler, skillsRepoBrokerFromEnv } = await import('../src/skills-repo-broker.ts');

const REPO = 'valkey-io/valkey-review-bot';
const INSTALLATION = 77;
const TOKEN = 'ghs_skills_repo_secret_token';
const installed = (id = INSTALLATION, login = 'valkey-io') => ({ status: 200, json: { id, account: { login } } });

function setup({ github = { [`GET repos/${REPO}/installation`]: installed() }, repo = REPO } = {}) {
  const issued = [];
  const logs = [];
  const api = fakeGitHub(github);
  const broker = createSkillsRepoBroker({
    repo,
    appApi: async () => api,
    issueToken: async (request) => {
      issued.push(request);
      return { token: TOKEN, expiresAt: '2026-10-13T13:00:00Z' };
    },
    log: (line) => logs.push(line),
    warn: (line) => logs.push(line),
  });
  return { broker, issued, logs, api };
}

test('issues a token for the skills repository with contents and pull request write', async () => {
  const { broker, issued, api } = setup();
  assert.deepEqual(await broker({}), { token: TOKEN, expires_at: '2026-10-13T13:00:00Z' });
  assert.deepEqual(api.calls.map((c) => `${c.method} ${c.path}`), [`GET repos/${REPO}/installation`]);
  assert.deepEqual(issued, [{
    installationId: INSTALLATION,
    repositoryNames: ['valkey-review-bot'],
    permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
  }]);
});

test('takes no repository or installation from the caller', async () => {
  const { broker, issued, api } = setup();
  const result = await broker({ repo: 'valkey-io/valkey', installation_id: 99, repositoryNames: ['valkey'], permissions: { administration: 'write' } });
  assert.equal(result.token, TOKEN);
  assert.deepEqual(api.calls.map((c) => c.path), [`repos/${REPO}/installation`]);
  assert.deepEqual(issued.map((r) => [r.installationId, r.repositoryNames, r.permissions.administration]), [[INSTALLATION, ['valkey-review-bot'], undefined]]);
  for (const event of [undefined, null, 'x', 42, []]) assert.equal((await broker(event)).token, TOKEN);
});

test('refuses when the App is not installed on the skills repository', async () => {
  const { broker, issued, logs } = setup({ github: { [`GET repos/${REPO}/installation`]: { status: 404, json: {} } } });
  assert.deepEqual(await broker({}), { error: `the App is not installed on ${REPO}` });
  assert.deepEqual(issued, []);
  assert.match(logs.join('\n'), /\[skills-repo-broker\] refused repo=valkey-io\/valkey-review-bot/);
});

test('refuses when the installation belongs to another account', async () => {
  // GitHub follows a renamed or transferred repository to its new owner.
  const { broker, issued } = setup({ github: { [`GET repos/${REPO}/installation`]: installed(INSTALLATION, 'someone-else') } });
  assert.deepEqual(await broker({}), { error: `the App's installation for ${REPO} belongs to someone-else` });
  assert.deepEqual(issued, []);
});

test('owner matches without regard to case', async () => {
  const { broker } = setup({ github: { [`GET repos/${REPO}/installation`]: installed(INSTALLATION, 'Valkey-IO') } });
  assert.equal((await broker({})).token, TOKEN);
});

test('a GitHub error fails the call without issuing a token', async () => {
  for (const response of [{ status: 500, json: {} }, { status: 200, json: { id: INSTALLATION } }]) {
    const { broker, issued } = setup({ github: { [`GET repos/${REPO}/installation`]: response } });
    await assert.rejects(broker({}), /repos\/valkey-io\/valkey-review-bot\/installation/);
    assert.deepEqual(issued, []);
  }
});

test('logs the purpose, made safe for one log line, and never the token', async () => {
  const { broker, logs } = setup();
  await broker({ purpose: 'curator repo skill pull request\nforged=line' });
  await broker({ purpose: 'x'.repeat(500) });
  await broker({ purpose: 7 });
  assert.equal(logs.length, 3);
  assert.equal(logs[0], `[skills-repo-broker] issued repo=${REPO} installation=${INSTALLATION} expires=2026-10-13T13:00:00Z purpose=curator_repo_skill_pull_request_forged_line`);
  assert.match(logs[1], new RegExp(`purpose=x{80}$`));
  assert.match(logs[2], /purpose=-$/);
  assert.ok(logs.every((line) => !line.includes(TOKEN)));
});

test('a malformed SKILLS_REPO fails at start', () => {
  for (const repo of ['', 'valkey-review-bot', 'a/b/c', '/b', 'a/', 'a/..', 'a b/c']) {
    assert.throws(() => setup({ repo }), /SKILLS_REPO must be "owner\/name"/);
  }
});

/** createAppAuth stand-in: a JWT for the App, installation tokens on request. */
function fakeAuth() {
  const created = [];
  const requests = [];
  const createAuth = (opts) => {
    created.push(opts);
    return async (request) => {
      requests.push(request);
      if (request.type === 'app') return { token: 'app-jwt' };
      return { token: TOKEN, expiresAt: '2026-10-13T14:00:00Z' };
    };
  };
  return { createAuth, created, requests };
}

function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return new Response(JSON.stringify(route.json), { status: route.status });
  };
  return { fetch, calls };
}

test('skillsRepoBrokerFromEnv uses the App id and key from the secret', async () => {
  const auth = fakeAuth();
  const http = fakeFetch({ [`https://api.github.com/repos/${REPO}/installation`]: installed() });
  const secret = JSON.stringify({ app_id: 4242, private_key: '-----BEGIN KEY-----', webhook_secret: 'w' });
  let reads = 0;
  const logged = [];
  const log = console.log;
  console.log = (line) => logged.push(line);
  try {
    const broker = skillsRepoBrokerFromEnv({ SKILLS_REPO: REPO }, async () => { reads++; return secret; },
      { createAuth: auth.createAuth, fetch: http.fetch });
    assert.deepEqual(await broker({ purpose: 'test' }), { token: TOKEN, expires_at: '2026-10-13T14:00:00Z' });
    await broker({});
  } finally {
    console.log = log;
  }
  assert.deepEqual(auth.created[0], { appId: '4242', privateKey: '-----BEGIN KEY-----' });
  // The installation is looked up with the App's JWT.
  assert.equal(http.calls[0].init.headers.Authorization, 'Bearer app-jwt');
  assert.deepEqual(auth.requests.slice(0, 2), [
    { type: 'app' },
    { type: 'installation', installationId: INSTALLATION, repositoryNames: ['valkey-review-bot'], permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' } },
  ]);
  // The secret is cached; each token comes from a new auth instance, so
  // @octokit/auth-app's own cache never returns a token close to expiry.
  assert.equal(reads, 1);
  assert.equal(auth.created.length, 4);
  assert.equal(logged.length, 2);
  assert.ok(logged.every((line) => !String(line).includes(TOKEN)));
});

test('skillsRepoBrokerFromEnv needs SKILLS_REPO and a secret with app_id and private_key', async () => {
  const auth = fakeAuth();
  assert.throws(() => skillsRepoBrokerFromEnv({}, async () => '{}', { createAuth: auth.createAuth }), /SKILLS_REPO is required/);
  for (const secret of [JSON.stringify({ private_key: 'k' }), JSON.stringify({ app_id: 1 })]) {
    const broker = skillsRepoBrokerFromEnv({ SKILLS_REPO: REPO }, async () => secret, { createAuth: auth.createAuth });
    await assert.rejects(broker({}), /skills-repo App secret has no app_id or private_key/);
  }
  const broker = skillsRepoBrokerFromEnv({ SKILLS_REPO: REPO }, async () => '{"private_key":"hunter2', { createAuth: auth.createAuth });
  await assert.rejects(broker({}), (err) => err.message === 'GitHub App secret is not valid JSON');
  assert.deepEqual(auth.created, []);
});

test('the handler needs SKILLS_REPO_APP_SECRET_NAME', async () => {
  const saved = process.env.SKILLS_REPO_APP_SECRET_NAME;
  delete process.env.SKILLS_REPO_APP_SECRET_NAME;
  try {
    await assert.rejects(handler({}), /SKILLS_REPO_APP_SECRET_NAME is required/);
  } finally {
    if (saved !== undefined) process.env.SKILLS_REPO_APP_SECRET_NAME = saved;
  }
});
