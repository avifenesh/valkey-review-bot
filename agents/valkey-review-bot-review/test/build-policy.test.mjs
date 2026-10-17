import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  CDK_OPTIONS, NPM_SCRIPTS, OFFLINE_ENV, SUBCOMMANDS, SUBCOMMAND_NAMES, TSC_OPTIONS, buildToolEnabled, checkBuildArgs, describeBuildTool, finalArgs,
} from '../src/tools/build-policy.ts';

const ok = (sub, args, dir = 'infra') => assert.equal(checkBuildArgs(sub, args, dir), null, `${sub} ${args.join(' ')} in ${dir}`);
const refused = (sub, args, pattern, dir = 'infra') => {
  const r = checkBuildArgs(sub, args, dir);
  assert.ok(r, `${sub} ${args.join(' ')} in ${dir} should be refused`);
  if (pattern) assert.match(r, pattern);
};

test('the subcommands are npm, npx and node', () => {
  assert.deepEqual([...SUBCOMMAND_NAMES], ['npm', 'npx', 'node']);
  assert.deepEqual(SUBCOMMANDS.npx.prefix, ['--offline', '--no', '--']);
});

test('npm runs only the build, typecheck and test scripts', () => {
  ok('npm', ['run', 'typecheck'], 'agents/common');
  ok('npm', ['run', 'build'], 'agents/curator');
  ok('npm', ['run', 'test'], 'webhook');
  ok('npm', ['test']);
  ok('npm', ['test', '--', '--testNamePattern=registry']);
  ok('npm', ['test', '--', 'test/infra.test.ts']);
  ok('npm', ['run', 'test', '--', '--testNamePattern=registry']);
  // cdk runs any CDK command, deploy included. watch runs until the time cap.
  for (const script of ['cdk', 'watch', 'start', 'prepare', 'lint:fix', '']) {
    refused('npm', ['run', script], /not allowed/);
  }
  assert.deepEqual([...NPM_SCRIPTS], ['build', 'typecheck', 'test']);
});

test('npm run build is refused in infra, where tsc writes .js next to the sources', () => {
  for (const dir of ['infra', './infra', 'infra/']) refused('npm', ['run', 'build'], /not allowed in infra/, dir);
  ok('npm', ['run', 'typecheck'], 'infra');
  ok('npm', ['test'], 'infra');
});

test('cdk synth always runs with --no-notices', () => {
  assert.deepEqual(finalArgs('npx', ['cdk', 'synth', '-c', 'config=deploy.config.example.json']),
    ['--offline', '--no', '--', 'cdk', 'synth', '-c', 'config=deploy.config.example.json', '--no-notices']);
  assert.deepEqual(finalArgs('npx', ['cdk', 'synth', '--no-notices', '-c', 'config=x.json']),
    ['--offline', '--no', '--', 'cdk', 'synth', '--no-notices', '-c', 'config=x.json']);
  assert.deepEqual(finalArgs('npm', ['run', 'typecheck']), ['run', 'typecheck']);
});

test('npm refuses installs, publishes and every option of its own', () => {
  for (const args of [
    ['ci'], ['install'], ['i', 'left-pad'], ['update'], ['publish'], ['login'], ['exec', 'tsc'], ['audit'], [],
  ]) refused('npm', args);
  for (const args of [
    ['test', '--prefix', '/tmp'],
    ['run', 'build', '--workspace', 'x'],
    ['test', '--registry=https://example.com'],
    ['run', 'test', 'install'],
  ]) refused('npm', args, /no options of its own/);
});

test('npx runs tsc --noEmit with a few read-only options', () => {
  ok('npx', ['tsc', '--noEmit'], 'webhook');
  ok('npx', ['tsc', '--noEmit', '-p', 'tsconfig.json'], 'agents/curator');
  ok('npx', ['tsc', '--project', 'test/tsconfig.json', '--noEmit', '--pretty']);
  refused('npx', ['tsc'], /needs --noEmit/);
  refused('npx', ['tsc', '-p', 'tsconfig.json'], /needs --noEmit/);
  for (const args of [
    ['tsc', '--noEmit', '-w'],
    ['tsc', '--noEmit', '--watch'],
    ['tsc', '--noEmit', '-watch'],
    ['tsc', '--noEmit', '--outDir', 'src'],
    ['tsc', '--noEmit', '-b'],
    ['tsc', '--noEmit', '--build'],
    ['tsc', '--noEmit', '--init'],
    ['tsc', '--noEmit', '--generateTrace', 'src'],
    ['tsc', '--noEmit', 'src/x.ts'],
  ]) refused('npx', args, /tsc option/);
  for (const value of ['/etc/tsconfig.json', '../../x/tsconfig.json', 'a/../../tsconfig.json', '', '-w']) {
    refused('npx', ['tsc', '--noEmit', '-p', value], /relative path inside the checkout/);
  }
});

test('npx cdk runs only synth, in infra, with a config file', () => {
  ok('npx', ['cdk', 'synth', '--quiet', '-c', 'config=deploy.config.example.json']);
  ok('npx', ['cdk', 'synth', '-q', '--context', 'config=test/fixtures/deploy.json', 'ValkeyReviewBotReviewAgent'], './infra/');
  ok('npx', ['cdk', 'synth', '-c', 'config=deploy.config.example.json', 'Valkey*', '--no-notices']);
  for (const command of ['deploy', 'bootstrap', 'destroy', 'diff', 'import', 'watch', 'acknowledge', 'context', 'init', '']) {
    refused('npx', ['cdk', command, '-c', 'config=deploy.config.example.json'], /runs only "synth"/);
  }
  refused('npx', ['cdk', 'synth', '-c', 'config=deploy.config.example.json'], /only in infra/, 'webhook');
  refused('npx', ['cdk', 'synth', '-c', 'config=deploy.config.example.json'], /only in infra/, '.');
  refused('npx', ['cdk', 'synth', '--quiet'], /needs -c config=<file>/);
  for (const value of ['config=/etc/passwd.json', 'config=../x.json', 'config=a/../../x.json', 'config=x.txt', '@aws-cdk/core:x=true', 'config=']) {
    refused('npx', ['cdk', 'synth', '-c', value], /takes only config=<file>/);
  }
  for (const option of ['--app', '-a', '--output', '-o', '--profile', '--role-arn', '--plugin', '--ec2creds', '--require-approval', '--force']) {
    refused('npx', ['cdk', 'synth', '-c', 'config=deploy.config.example.json', option, 'x'], /cdk option/);
  }
  refused('npx', ['cdk', 'synth', '-c', 'config=deploy.config.example.json', 'node bin/x.js'], /not a stack name/);
});

test('npx runs no other package', () => {
  for (const name of ['eslint', 'prettier', 'jest', 'ts-node', 'esbuild', 'aws-cdk', 'left-pad', '--yes']) {
    refused('npx', [name], /not allowed/);
  }
});

test('node runs only --test on test files inside the checkout', () => {
  ok('node', ['--test', 'test/prompt.test.mjs'], 'agents/valkey-review');
  ok('node', ['--test', '--experimental-strip-types', '--test-name-pattern=receiver', 'test/delivery.test.mjs', 'test/store.test.mjs'], 'webhook');
  ok('node', ['--test', '--test-skip-pattern=slow', 'test/skill-facts.test.mjs'], 'scripts');
  refused('node', ['test/x.test.mjs'], /not allowed/);
  refused('node', ['-e', 'process.exit(0)'], /not allowed/);
  refused('node', ['--test'], /at least one test file/);
  for (const arg of ['--require=./x.js', '--import', '-e', '--eval=1', '--inspect', '--experimental-test-coverage', '--test-reporter-destination=src/a.ts']) {
    refused('node', ['--test', arg, 'test/a.test.mjs'], /node option/);
  }
  for (const file of ['/tmp/x.test.mjs', '../x.test.mjs', 'test/../../x.test.mjs', 'src/agent.ts', 'test']) {
    refused('node', ['--test', file], /test files by relative path/);
  }
});

test('the environment hides credential sources and keeps npm offline', () => {
  assert.equal(OFFLINE_ENV.AWS_CONFIG_FILE, '/dev/null');
  assert.equal(OFFLINE_ENV.AWS_SHARED_CREDENTIALS_FILE, '/dev/null');
  assert.equal(OFFLINE_ENV.AWS_EC2_METADATA_DISABLED, 'true');
  assert.equal(OFFLINE_ENV.NPM_CONFIG_OFFLINE, 'true');
  // None of these carries a credential: buildChildEnv's own pattern would remove them otherwise.
  for (const name of Object.keys(OFFLINE_ENV)) assert.doesNotMatch(name, /TOKEN|SECRET|PASSWORD|PRIVATE_KEY|KEY_ID|ACCESS_KEY|SESSION/);
});

test('the tool description names every action and option', () => {
  const d = describeBuildTool();
  for (const name of SUBCOMMAND_NAMES) {
    for (const action of SUBCOMMANDS[name].actions) assert.ok(d.includes(action), `${name} ${action}`);
  }
  for (const word of [...NPM_SCRIPTS, ...TSC_OPTIONS, ...CDK_OPTIONS, 'config=<file>', '--test-name-pattern=<pattern>']) {
    assert.ok(d.includes(word), word);
  }
});

test('ALLOW_BUILD enables the tool and ALLOW_MAKE is an alias', () => {
  assert.equal(buildToolEnabled({}), false);
  assert.equal(buildToolEnabled({ ALLOW_BUILD: 'true' }), true);
  assert.equal(buildToolEnabled({ ALLOW_MAKE: 'true' }), true);
  assert.equal(buildToolEnabled({ ALLOW_BUILD: 'false', ALLOW_MAKE: 'true' }), false);
});

const buildSection = () => {
  const prompt = readFileSync(new URL('../config/prompt.md', import.meta.url), 'utf8');
  return prompt.slice(prompt.indexOf('### Build'), prompt.indexOf('## Workflow'));
};

test('the prompt lists exactly the actions the tool accepts', () => {
  const section = buildSection();
  for (const name of SUBCOMMAND_NAMES) {
    const line = section.split('\n').find((l) => l.startsWith(`- \`${name}\``));
    assert.ok(line, `Build section has a line for ${name}`);
    // The first sentence after the colon is the action list.
    const list = line.slice(line.indexOf(':') + 1).split(/\.(\s|$)/)[0];
    const actions = [...list.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    assert.deepEqual(actions, [...SUBCOMMANDS[name].actions], name);
  }
  const npm = section.split('\n').find((l) => l.startsWith('- `npm`'));
  for (const script of NPM_SCRIPTS) assert.ok(npm.includes(`\`${script}\``), `npm line names ${script}`);
});

test('every command the prompt suggests is accepted', () => {
  const section = buildSection();
  // Examples are written as `subcommand` ... `args: [...]` ... `dir: "..."` on one line.
  const examples = [...section.matchAll(/`(npm|npx|node)`, `args: (\[[^\]]*\])`, `dir: "([^"]+)"`/g)];
  assert.ok(examples.length >= 4, `found ${examples.length} examples`);
  for (const [, sub, args, dir] of examples) ok(sub, JSON.parse(args), dir);
});

// The prompt tells the reviewer to write without em dashes, so its own
// prose and the skill's do the same.
test('the prompt and the skill have no em dashes', () => {
  for (const file of ['prompt.md', 'skill.md']) {
    const text = readFileSync(new URL(`../config/${file}`, import.meta.url), 'utf8');
    const lines = text.split('\n').map((l, i) => `${i + 1}: ${l}`).filter((l) => l.includes('\u2014'));
    assert.deepEqual(lines, [], file);
  }
});
