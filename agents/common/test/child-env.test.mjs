import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChildEnv, resolveInside } from '../src/tools/child-env.ts';

test('build processes do not inherit credentials', () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b', AWS_SESSION_TOKEN: 'c',
      AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://x', AWS_CONTAINER_AUTHORIZATION_TOKEN: 'd',
      GH_TOKEN: 'e', GITHUB_TOKEN: 'f', SOME_API_TOKEN: 'g', DB_PASSWORD: 'h', MY_PRIVATE_KEY: 'i',
      PATH: '/usr/bin', HOME: '/home/agent', JAVA_HOME: '/opt/java', CARGO_HOME: '/opt/cargo',
    });
    const env = buildChildEnv();
    for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_CONTAINER_CREDENTIALS_FULL_URI',
      'AWS_CONTAINER_AUTHORIZATION_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'SOME_API_TOKEN', 'DB_PASSWORD', 'MY_PRIVATE_KEY']) {
      assert.equal(env[k], undefined, k);
    }
    for (const k of ['PATH', 'HOME', 'JAVA_HOME', 'CARGO_HOME']) assert.equal(env[k], process.env[k], k);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('subdirectories resolve inside the workspace only', () => {
  assert.equal(resolveInside('/workspace/glide', undefined), '/workspace/glide');
  assert.equal(resolveInside('/workspace/glide', 'java'), '/workspace/glide/java');
  assert.equal(resolveInside('/workspace/glide', 'java/../go'), '/workspace/glide/go');
  assert.equal(resolveInside('/workspace/glide', '../..'), null);
  assert.equal(resolveInside('/workspace/glide', '/etc'), null);
  assert.equal(resolveInside('/workspace/glide', '../glide-other'), null);
});
