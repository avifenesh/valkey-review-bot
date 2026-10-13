import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  GO_MOD_READ_ONLY, NPM_BLOCKED_SCRIPTS, SUBCOMMANDS, SUBCOMMAND_NAMES, buildToolEnabled, checkBuildArgs, describeBuildTool,
} from '../src/tools/build-policy.ts';

const ok = (sub, args) => assert.equal(checkBuildArgs(sub, args), null, `${sub} ${args.join(' ')}`);
const refused = (sub, args, pattern) => {
  const r = checkBuildArgs(sub, args);
  assert.ok(r, `${sub} ${args.join(' ')} should be refused`);
  if (pattern) assert.match(r, pattern);
};

test('gradle accepts allowed tasks alone or with a project path', () => {
  ok('gradle', [':client:test']);
  ok('gradle', ['test']);
  ok('gradle', [':client:compileJava']);
  ok('gradle', [':client:compileTestJava', ':client:spotlessCheck']);
  ok('gradle', [':client:build', '-x', 'javadoc', '--offline']);
  ok('gradle', [':client:test', '--tests', 'glide.api.models.CommandTests']);
  ok('gradle', [':client:test', '--tests=glide.ConnectionTests']);
});

test('gradle refuses tasks outside the set, by the last path segment', () => {
  refused('gradle', [':client:clean'], /not allowed/);
  refused('gradle', [':client:javadoc'], /not allowed/);
  refused('gradle', [':client:test', ':client:buildRust'], /buildRust/);
  refused('gradle', [':client:test:extra'], /not allowed/);
  refused('gradle', [':client:'], /not allowed/);
  // Gradle would expand these abbreviations; exact names only.
  refused('gradle', [':client:pTML']);
  refused('gradle', [':client:b']);
  refused('gradle', ['--offline', ':client:test'], /first gradle argument must be a task/);
});

test('gradle refuses publish and upload tasks anywhere in argv', () => {
  for (const args of [
    [':client:publish'],
    ['publishToMavenLocal'],
    [':client:test', ':client:publishAllPublicationsToMavenRepository'],
    [':client:test', '-x', 'publish'],
    [':client:uploadArchives'],
    [':client:test', 'Upload'],
  ]) refused('gradle', args, /publish and upload tasks are blocked/);
});

test('mvn and pytest are gone', () => {
  assert.deepEqual([...SUBCOMMAND_NAMES], ['cargo', 'gradle', 'go', 'npm', 'npx']);
  assert.equal(SUBCOMMANDS.mvn, undefined);
  assert.equal(SUBCOMMANDS.pytest, undefined);
});

test('other subcommands check args[0] and blocked tokens', () => {
  ok('cargo', ['test', '--lib']);
  ok('cargo', ['clippy', '--all-targets']);
  refused('cargo', ['fmt'], /not allowed/);
  refused('cargo', ['publish']);
  refused('cargo', ['clippy', '--fix']);
  refused('cargo', ['install', 'cargo-zigbuild']);
  ok('go', ['vet', './...']);
  refused('go', ['get', 'example.com/x']);
  refused('go', ['test', './...', 'install']);
  ok('npm', ['run', 'build']);
  refused('npm', ['install']);
  refused('npm', ['run', 'publish']);
  ok('npx', ['tsc', '--noEmit']);
  refused('cargo', []);
});

test('npm run refuses the glide scripts that rewrite sources or delete lock files', () => {
  ok('npm', ['run', 'build']);
  ok('npm', ['run', 'build:ts']);
  ok('npm', ['run', 'clean:build']);
  ok('npm', ['run', 'lint']);
  ok('npm', ['run', 'prettier:check']);
  ok('npm', ['run', 'build:rust-client']);
  ok('npm', ['test', '--', '--testPathPattern=ClientLibraryNameResolver']);
  for (const script of ['lint:fix', 'prettier:format', 'staged', 'format', 'format:prettier', 'format:rs', 'clean']) {
    assert.ok(NPM_BLOCKED_SCRIPTS.includes(script), script);
    refused('npm', ['run', script], /not allowed for npm/);
  }
});

test('go mod runs only the subcommands that leave go.mod and go.sum alone', () => {
  for (const sub of ['graph', 'verify', 'why']) ok('go', ['mod', sub]);
  ok('go', ['mod', 'why', '-m', 'github.com/google/uuid']);
  for (const sub of ['tidy', 'edit', 'download', 'vendor', 'init']) {
    refused('go', ['mod', sub], new RegExp(`go mod "${sub}" not allowed`));
  }
  refused('go', ['mod'], /go mod "" not allowed/);
  // -mod=mod lets ordinary build commands rewrite go.mod and go.sum.
  refused('go', ['build', '-mod=mod', './...'], /not allowed for go/);
  refused('go', ['test', '-mod', 'mod', './...'], /not allowed for go/);
  ok('go', ['test', '-run', 'TestMod', './...']);
});

test('npx refuses every way prettier and eslint write files', () => {
  ok('npx', ['tsc', '--noEmit', '-p', 'tsconfig.json']);
  ok('npx', ['prettier', '--check', 'src/BaseClient.ts']);
  ok('npx', ['prettier', '-l', '-c', '.']);
  ok('npx', ['eslint', '-c', '../eslint.config.mjs', 'src']);
  // prettier 3 writes with each of these: the long form, its alias, the
  // one-letter long form, and -w in any short-option cluster.
  for (const args of [
    ['prettier', '-w', '.'],
    ['prettier', '--write', '.'],
    ['prettier', '--write=true', '.'],
    ['prettier', '--w', '.'],
    ['prettier', '--w=1', '.'],
    ['prettier', '-w=true', '.'],
  ]) refused('npx', args, /not allowed for npx/);
  for (const args of [
    ['prettier', '-lw', '.'],
    ['prettier', '-cw', '.'],
    ['prettier', '-wl', '.'],
    ['prettier', '-write', '.'],
    ['tsc', '-noEmit'],
  ]) refused('npx', args, /prettier reads "-lw" as "-l -w"/);
  for (const args of [
    ['eslint', '--fix', 'src'],
    ['eslint', '--fix=true', 'src'],
    ['eslint', '--fix-dry-run', 'src'],
    ['eslint', '--fix-type', 'problem', 'src'],
  ]) refused('npx', args, /eslint --fix rewrites files/);
  // eslint writes its report over whatever path -o names.
  refused('npx', ['eslint', '-o', 'src/BaseClient.ts', 'src'], /not allowed for npx/);
  refused('npx', ['eslint', '--output-file=src/BaseClient.ts', 'src'], /not allowed for npx/);
  // tsc -w watches until the time cap.
  refused('npx', ['tsc', '-w'], /not allowed for npx/);
});

test('the tool description names every action', () => {
  const d = describeBuildTool();
  for (const name of SUBCOMMAND_NAMES) {
    for (const action of SUBCOMMANDS[name].actions) assert.ok(d.includes(action), `${name} ${action}`);
  }
  assert.ok(!d.includes('mvn') && !d.includes('pytest'));
});

test('the tool description names every blocked token', () => {
  const d = describeBuildTool();
  for (const name of SUBCOMMAND_NAMES) {
    for (const token of SUBCOMMANDS[name].forbidden) assert.ok(d.includes(token), `${name} ${token}`);
  }
  assert.match(d, /starting with `--fix`/);
  assert.match(d, /`-lw`/);
  assert.ok(d.includes(`\`go mod\` takes only ${GO_MOD_READ_ONLY.join(', ')}`));
  assert.ok(d.includes(`\`npm run\` refuses ${NPM_BLOCKED_SCRIPTS.join(', ')}`));
});

test('ALLOW_BUILD enables the tool and ALLOW_MAKE is an alias', () => {
  assert.equal(buildToolEnabled({}), false);
  assert.equal(buildToolEnabled({ ALLOW_BUILD: 'true' }), true);
  assert.equal(buildToolEnabled({ ALLOW_MAKE: 'true' }), true);
  assert.equal(buildToolEnabled({ ALLOW_BUILD: 'false', ALLOW_MAKE: 'true' }), false);
});

test('the prompt lists exactly the actions the tool accepts', () => {
  const prompt = readFileSync(new URL('../config/prompt.md', import.meta.url), 'utf8');
  const section = prompt.slice(prompt.indexOf('### Build'), prompt.indexOf('## Workflow'));
  for (const name of SUBCOMMAND_NAMES) {
    const line = section.split('\n').find((l) => l.startsWith(`- \`${name}\``));
    assert.ok(line, `Build section has a line for ${name}`);
    // The first sentence after the colon is the action list.
    const list = line.slice(line.indexOf(':') + 1).split(/\.(\s|$)/)[0];
    const actions = [...list.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    assert.deepEqual(actions, [...SUBCOMMANDS[name].actions], name);
  }
  assert.ok(!/\bmvn\b|\bpytest\b|dev\.py/.test(section), 'no mvn, pytest or dev.py in the Build section');
});

test('the prompt names what go mod, npm run and npx refuse', () => {
  const prompt = readFileSync(new URL('../config/prompt.md', import.meta.url), 'utf8');
  const line = (name) => prompt.split('\n').find((l) => l.startsWith(`- \`${name}\``));
  const names = (name, tokens) => {
    for (const token of tokens) assert.ok(line(name).includes(`\`${token}\``), `${name} line names ${token}`);
  };
  names('go', [...GO_MOD_READ_ONLY, '-mod']);
  names('npm', NPM_BLOCKED_SCRIPTS);
  names('npx', ['-w', '--write', '--fix', '-o', '--output-file', '-lw']);
});

test('the npm commands the prompt suggests are accepted', () => {
  const prompt = readFileSync(new URL('../config/prompt.md', import.meta.url), 'utf8');
  const section = prompt.slice(prompt.indexOf('### Build'), prompt.indexOf('## Workflow'));
  const npmLines = section.split('\n').filter((l) => l.startsWith('- `npm '));
  const examples = npmLines.flatMap((l) => [...l.matchAll(/`args: (\[[^\]]*\])`/g)].map((m) => JSON.parse(m[1])));
  const scripts = [...section.matchAll(/`npm run ([\w:-]+)`/g)].map((m) => ['run', m[1]]);
  assert.ok(examples.length > 0 && scripts.length > 0);
  for (const args of [...examples, ...scripts]) ok('npm', args);
});

// The prompt tells the reviewer to write without em dashes, so its own
// prose and the skill's do the same.
test('the prompt and the skill have no em dashes', () => {
  for (const file of ['prompt.md', 'skill.md']) {
    const text = readFileSync(new URL(`../config/${file}`, import.meta.url), 'utf8');
    const lines = text.split('\n').map((l, i) => `${i + 1}: ${l}`).filter((l) => l.includes('—'));
    assert.deepEqual(lines, [], file);
  }
});
