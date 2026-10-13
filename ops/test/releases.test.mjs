import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isRepoName, latestReleaseTag, pickReleaseTag, RELEASE_LIST_PAGE, RELEASE_TAG_RE } from '../src/releases.ts';

// Trimmed copies of GET repos/<repo>/releases?per_page=50, taken on 2026-10-13.
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const VALKEY = fixture('valkey-releases.json');
const GLIDE = fixture('glide-releases.json');

const ga = (tag) => ({ tag_name: tag, draft: false, prerelease: false });

test('the highest GA release wins over newer releases on older lines and prereleases', () => {
  // 9.0.6 is newer by date and 9.2.0-rc1 is a prerelease.
  assert.equal(VALKEY[0].tag_name, '9.2.0-rc1');
  assert.equal(VALKEY[1].tag_name, '9.0.6');
  assert.equal(pickReleaseTag(VALKEY), '9.1.2');
  // rust/v0.9.0 is newer and v2.2.9-java does not match the GA shape.
  assert.equal(GLIDE[0].tag_name, 'rust/v0.9.0');
  assert.equal(pickReleaseTag(GLIDE), 'v2.5.3');
});

test('drafts, prereleases and releases without both flags are excluded', () => {
  assert.equal(pickReleaseTag([
    { tag_name: '10.0.0', draft: true, prerelease: false },
    { tag_name: '9.9.0', draft: false, prerelease: true },
    { tag_name: '9.8.0' },
    { tag_name: '9.7.0', draft: false },
    ga('9.1.0'),
  ]), '9.1.0');
  assert.equal(pickReleaseTag([{ tag_name: '9.9.0', draft: false, prerelease: true }]), null);
});

test('only X.Y.Z tags with an optional v are GA tags', () => {
  for (const tag of ['9.1.2', 'v2.5.3', '0.0.1', '1234.5678.9012']) assert.match(tag, RELEASE_TAG_RE, tag);
  for (const tag of ['9.2.0-rc1', 'v2.2.9-java', 'rust/v0.9.0', 'node/v2.1.2', '9.1', '9.1.2.3', 'V9.1.2', '12345.0.0', ' 9.1.2', '9.1.2\n']) {
    assert.doesNotMatch(tag, RELEASE_TAG_RE, JSON.stringify(tag));
  }
  assert.equal(pickReleaseTag(['9.1.2', null, 7, ga('rust/v9.9.9'), { draft: false, prerelease: false }]), null);
});

test('versions compare as numbers, and the first of equal versions is kept', () => {
  assert.equal(pickReleaseTag([ga('9.9.0'), ga('9.10.0'), ga('9.2.11')]), '9.10.0');
  assert.equal(pickReleaseTag([ga('v2.0.10'), ga('v2.0.9')]), 'v2.0.10');
  assert.equal(pickReleaseTag([ga('v1.2.3'), ga('1.2.3')]), 'v1.2.3');
  assert.equal(pickReleaseTag([]), null);
});

test('repository names are checked before they reach a URL', () => {
  for (const repo of ['valkey-io/valkey', 'valkey-io/valkey-glide', 'a/b.c', 'o/.github']) assert.ok(isRepoName(repo), repo);
  for (const repo of ['', 'valkey', 'a/b/c', 'owner/..', 'owner/.', '../x', '-a/b', 'owner/name?per_page=1', 'owner/na me', 'owner/name#x']) {
    assert.ok(!isRepoName(repo), repo);
  }
});

function quiet(t) {
  return { warn: t.mock.method(console, 'warn', () => {}), log: t.mock.method(console, 'log', () => {}) };
}

const jsonResponse = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('latestReleaseTag reads the releases anonymously with a User-Agent and a timeout', async (t) => {
  const logs = quiet(t);
  const calls = [];
  const tag = await latestReleaseTag('valkey-io/valkey', async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(VALKEY);
  });
  assert.equal(tag, '9.1.2');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.github.com/repos/valkey-io/valkey/releases?per_page=${RELEASE_LIST_PAGE}`);
  assert.equal(RELEASE_LIST_PAGE, 50);
  const { headers, signal, method } = calls[0].init;
  assert.equal(method, undefined, 'a plain GET');
  assert.equal(headers['User-Agent'], 'valkey-reviewer-decay');
  assert.equal(headers.Accept, 'application/vnd.github+json');
  assert.ok(!('Authorization' in headers), 'no credentials');
  assert.ok(signal instanceof AbortSignal);
  assert.match(logs.log.mock.calls[0].arguments[0], /^\[release\] valkey-io\/valkey tag=9\.1\.2$/);
});

test('latestReleaseTag gives null and a [release] line when the API refuses or fails', async (t) => {
  const logs = quiet(t);
  for (const status of [403, 429, 500, 502, 404]) {
    const headers = status === 403 ? { 'x-ratelimit-remaining': '0' } : {};
    assert.equal(await latestReleaseTag('valkey-io/valkey', async () => jsonResponse({ message: 'no' }, status, headers)), null, String(status));
  }
  assert.equal(await latestReleaseTag('valkey-io/valkey', async () => { throw new TypeError('fetch failed'); }), null);
  assert.equal(await latestReleaseTag('valkey-io/valkey', async () => jsonResponse({ message: 'not a list' })), null);
  assert.equal(await latestReleaseTag('valkey-io/valkey', async () => new Response('<html>', { status: 200 })), null);
  assert.equal(await latestReleaseTag('valkey-io/valkey', async () => jsonResponse([ga('9.2.0-rc1')])), null);

  const lines = logs.warn.mock.calls.map((c) => c.arguments[0]);
  assert.equal(lines.length, 9);
  for (const line of lines) assert.match(line, /^\[release\] valkey-io\/valkey: /);
  assert.match(lines[0], /returned 403 ratelimit_remaining=0;/);
  assert.match(lines[5], /fetch failed/);
  assert.match(lines[8], /no GA release among the latest 50/);
});

test('latestReleaseTag gives null when the request times out', async (t) => {
  quiet(t);
  const hanging = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
  const started = Date.now();
  assert.equal(await latestReleaseTag('valkey-io/valkey-glide', hanging, 20), null);
  assert.ok(Date.now() - started < 5_000);
});

test('latestReleaseTag rejects a malformed repository before any request', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return jsonResponse(VALKEY); };
  for (const repo of ['valkey', 'owner/..', 'a/b/c', 'evil.example/x?y']) {
    await assert.rejects(latestReleaseTag(repo, fetchImpl), /owner\/name/, repo);
  }
  assert.equal(called, false);
});
