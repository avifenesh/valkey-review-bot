import assert from 'node:assert/strict';
import test from 'node:test';
import { intSetting, loadEnv, parseReviewerMap, renderTemplate } from '../dist/curator/src/config.js';

const BASE = {
  BEDROCK_MODEL_ID: 'primary-model',
  FALLBACK_MODEL_ID: 'fallback-model',
  MANTLE_REGION: 'us-east-1',
  AWS_REGION: 'us-west-2',
  ASSETS_BUCKET: 'bucket',
  PROMPT_S3_KEY: 'curator/prompt.md',
  CONCERNS_TABLES_JSON: '{"valkey-review":"valkey_review_concerns"}',
  SKILLS_REGISTRIES_JSON: '{"valkey-review":"registry-1"}',
};

test('loadEnv reads the documented defaults', () => {
  const env = loadEnv(BASE);
  assert.equal(env.modelId, 'primary-model');
  assert.equal(env.graduationThreshold, 4);
  assert.equal(env.maxIterations, 40);
  assert.equal(env.maxTokens, 16384);
  assert.equal(env.reasoningEffort, 'medium');
  assert.equal(env.fallbackReasoningEffort, 'high');
  assert.equal(env.skillKey, '');
  assert.equal(env.curatorSkillsRegistryId, '');
  assert.deepEqual(env.concernsTables, { 'valkey-review': 'valkey_review_concerns' });
});

test('loadEnv requires model ids and regions', () => {
  for (const key of ['BEDROCK_MODEL_ID', 'FALLBACK_MODEL_ID', 'MANTLE_REGION', 'AWS_REGION', 'CONCERNS_TABLES_JSON', 'SKILLS_REGISTRIES_JSON']) {
    const env = { ...BASE, [key]: '' };
    assert.throws(() => loadEnv(env), new RegExp(key));
  }
});

test('integer settings reject values that are not integers in range', () => {
  assert.equal(intSetting({}, 'N', 7, 1, 10), 7);
  assert.equal(intSetting({ N: ' 3 ' }, 'N', 7, 1, 10), 3);
  for (const bad of ['abc', '4.5', '-1', '1e3', '0x10']) {
    assert.throws(() => intSetting({ N: bad }, 'N', 7, 1, 10), /must be an integer/, bad);
  }
  assert.throws(() => intSetting({ N: '11' }, 'N', 7, 1, 10), /between 1 and 10/);
  assert.throws(() => loadEnv({ ...BASE, GRADUATION_THRESHOLD: '1' }), /GRADUATION_THRESHOLD/);
  assert.throws(() => loadEnv({ ...BASE, MAX_ITERATIONS: 'many' }), /MAX_ITERATIONS/);
});

test('reviewer maps must be objects of non-empty strings', () => {
  assert.throws(() => parseReviewerMap('X', 'not json'), /X is not valid JSON/);
  assert.throws(() => parseReviewerMap('X', '["a"]'), /JSON object/);
  assert.throws(() => parseReviewerMap('X', '{"a":""}'), /X\.a/);
  assert.throws(() => parseReviewerMap('X', '{}'), /no entries/);
});

test('renderTemplate fills placeholders and rejects unknown ones', () => {
  assert.equal(renderTemplate('needs {{GRADUATION_THRESHOLD}} votes', { GRADUATION_THRESHOLD: '4' }), 'needs 4 votes');
  assert.throws(() => renderTemplate('{{TYPO}}', { GRADUATION_THRESHOLD: '4' }), /TYPO/);
});

test('skill maintenance settings default to report mode', () => {
  const env = loadEnv(BASE);
  assert.deepEqual(env.upstreamRepos, {});
  assert.equal(env.checkPromptKey, '');
  assert.equal(env.checkMaxRounds, 25);
  assert.equal(env.checkApplyEdits, false);
  assert.equal(env.retireSkills, false);
  assert.equal(env.checkOpenPullRequests, false);
  assert.equal(env.skillsRepo, null);
  assert.equal(env.checkDir, '/tmp/skill-check');
});

test('skill maintenance settings are read and checked', () => {
  const env = loadEnv({
    ...BASE,
    UPSTREAM_REPOS_JSON: '{"valkey-review":"valkey-io/valkey","valkey-glide-review":""}',
    CHECK_PROMPT_S3_KEY: 'curator/skill-check.md',
    CHECK_MAX_ROUNDS: '40',
    CHECK_APPLY_EDITS: 'true',
    RETIRE_SKILLS: 'true',
    CHECK_OPEN_PULL_REQUESTS: 'true',
    SKILLS_REPO: 'valkey-io/valkey-review-bot',
    SKILLS_REPO_SIGN_OFF: 'Valkey Reviewer <reviewer@example.com>',
    SKILLS_REPO_TOKEN_FUNCTION: 'ValkeyReviewerSubstrate-SkillsRepoBroker-1A2B',
    SKILL_CHECK_DIR: '/var/tmp/checks/',
  });
  // An empty upstream means no checks for that reviewer.
  assert.deepEqual(env.upstreamRepos, { 'valkey-review': 'valkey-io/valkey' });
  assert.equal(env.checkPromptKey, 'curator/skill-check.md');
  assert.equal(env.checkMaxRounds, 40);
  assert.equal(env.checkApplyEdits, true);
  assert.equal(env.retireSkills, true);
  assert.equal(env.checkOpenPullRequests, true);
  assert.deepEqual(env.skillsRepo, {
    repo: 'valkey-io/valkey-review-bot',
    baseBranch: 'main',
    signOff: 'Valkey Reviewer <reviewer@example.com>',
    tokenFunction: 'ValkeyReviewerSubstrate-SkillsRepoBroker-1A2B',
  });
  assert.equal(env.checkDir, '/var/tmp/checks');
  assert.equal(loadEnv({ ...BASE, UPSTREAM_REPOS_JSON: '{}' }).upstreamRepos['valkey-review'], undefined);
  assert.equal(loadEnv({ ...BASE, SKILLS_REPO: 'o/r', SKILLS_REPO_BASE_BRANCH: 'release/1.0' }).skillsRepo.baseBranch, 'release/1.0');
});

test('bad skill maintenance settings fail at boot', () => {
  const bad = [
    [{ UPSTREAM_REPOS_JSON: 'nope' }, /UPSTREAM_REPOS_JSON is not valid JSON/],
    [{ UPSTREAM_REPOS_JSON: '["valkey-io/valkey"]' }, /UPSTREAM_REPOS_JSON must be a JSON object/],
    [{ UPSTREAM_REPOS_JSON: '{"valkey-review":"https://github.com/valkey-io/valkey"}' }, /UPSTREAM_REPOS_JSON\.valkey-review/],
    [{ UPSTREAM_REPOS_JSON: '{"valkey-review":"valkey-io/.."}' }, /UPSTREAM_REPOS_JSON\.valkey-review/],
    [{ UPSTREAM_REPOS_JSON: '{"valkey-review":7}' }, /must be a string/],
    [{ CHECK_MAX_ROUNDS: '4' }, /CHECK_MAX_ROUNDS must be between 5 and 100/],
    [{ CHECK_MAX_ROUNDS: '101' }, /CHECK_MAX_ROUNDS/],
    [{ CHECK_APPLY_EDITS: 'yes' }, /CHECK_APPLY_EDITS must be "true" or "false"/],
    [{ RETIRE_SKILLS: '1' }, /RETIRE_SKILLS/],
    [{ CHECK_OPEN_PULL_REQUESTS: 'on' }, /CHECK_OPEN_PULL_REQUESTS/],
    [{ SKILLS_REPO: 'not a repo' }, /SKILLS_REPO must look like/],
    [{ SKILLS_REPO: 'o/r', SKILLS_REPO_BASE_BRANCH: 'main..x' }, /SKILLS_REPO_BASE_BRANCH/],
    [{ SKILLS_REPO: 'o/r', SKILLS_REPO_SIGN_OFF: 'just a name' }, /SKILLS_REPO_SIGN_OFF/],
    [{ SKILLS_REPO: 'o/r', SKILLS_REPO_TOKEN_FUNCTION: 'bad name!' }, /SKILLS_REPO_TOKEN_FUNCTION is not/],
    [{ SKILLS_REPO: 'o/r', CHECK_OPEN_PULL_REQUESTS: 'true' }, /SKILLS_REPO_TOKEN_FUNCTION is required/],
    [{ SKILL_CHECK_DIR: 'relative' }, /SKILL_CHECK_DIR/],
    [{ SKILL_CHECK_DIR: '/' }, /SKILL_CHECK_DIR/],
    [{ SKILL_CHECK_DIR: '/tmp/../etc' }, /SKILL_CHECK_DIR/],
  ];
  for (const [extra, message] of bad) assert.throws(() => loadEnv({ ...BASE, ...extra }), message, JSON.stringify(extra));
  // Pull requests on without a skills repository are only reported, so they need no broker.
  assert.equal(loadEnv({ ...BASE, CHECK_OPEN_PULL_REQUESTS: 'true' }).skillsRepo, null);
});
