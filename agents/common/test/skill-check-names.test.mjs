import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const { classifyToken, extractNames, MAX_NAMES } = await import('../src/skill-check/names.ts');
const { listSuppressedBlocks } = await import('../src/skill-check/edits.ts');

const fixture = (name) => readFileSync(new URL(`./fixtures/skills/${name}`, import.meta.url), 'utf8');
const tokens = (md) => extractNames(md).map((n) => n.token);
const skill = (body, description = 'Use when reviewing a PR.') =>
  `---\nname: test-skill\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`;

test('each kind of code name is classified', () => {
  const cases = {
    'src/server.c': 'path',
    'src/modules/': 'dir',
    'glide-core/src/client/**': 'glob',
    '*.log': 'glob',
    'REPL_STATE_*': 'prefix',
    'ConnectionManager::reconnect': 'qualified',
    'server.primary': 'qualified',
    'ht->safe_iterators': 'qualified',
    replicationCachePrimaryUsingMyself: 'symbol',
    RDB_INCOMPATIBLE: 'symbol',
    REPLCONF: 'symbol',
    'hash-max-listpack-entries': 'config',
  };
  const md = skill(Object.keys(cases).map((t) => `- \`${t}\``).join('\n'));
  assert.deepEqual(Object.fromEntries(extractNames(md).map((n) => [n.token, n.kind])), cases);
  for (const [token, kind] of Object.entries(cases)) assert.equal(classifyToken(token), kind, token);
});

test('weak words, URLs, placeholders, prose and fenced names are dropped', () => {
  const md = skill([
    'Call `foo()` and `HSET`, `NULL`, `dict`, `the`, `x`, `8.0`, `v2.5.3`.',
    'See `https://github.com/valkey-io/valkey` and `<placeholder>` and `$VAR` and `a=b` and `"quoted"`.',
    'Prose in backticks: `a span with spaces`, `sds *err`, `CLUSTER_NODE_*_SUPPORTED`, `/abs/path.c`, `../up.c`.',
    '',
    '```c',
    'static int fencedOnlyName_c(void);',
    'call `insideFenceName_x`',
    '```',
    '',
    '~~~',
    '`tildeFenced_name`',
    '~~~',
    '',
    'Kept: `keptAfterFence_name`.',
  ].join('\n'));
  assert.deepEqual(tokens(md), ['keptAfterFence_name']);
});

test('spans lose a call or index suffix, a line suffix and a leading & or ./', () => {
  const md = skill('`emptyDB(EMPTYDB_NO_FLAGS)` `rdbLoad(rdb, &rsi, RDBFLAGS_NONE)` `deprecated_configs[]` `src/server.c:123` `src/t_hash.c:10-20` `&commandSetType` `./src/db.c`');
  assert.deepEqual(tokens(md), ['emptyDB', 'rdbLoad', 'deprecated_configs', 'src/server.c', 'src/t_hash.c', 'commandSetType', 'src/db.c']);
});

test('spans of 2-120 characters only', () => {
  const long = `a_${'b'.repeat(130)}`;
  const md = skill(`\`${long}\` \`x\` \`ok_name\``);
  assert.deepEqual(tokens(md), ['ok_name']);
});

test('double-backtick spans are read', () => {
  assert.deepEqual(tokens(skill('Use `` server.primary `` here.')), ['server.primary']);
});

test('the frontmatter description contributes paths and A::b names, but not its prose', () => {
  const md = skill('Body cites `bodyOnly_name`.',
    'Use when reviewing a PR that touches glide-core/src/timeout_watchdog.rs, src/modules/ or `src/rdb.c`, or calls ConnectionManager::reconnect. Not for valkey-io/valkey forks, Node.js or e.g. the server.c file.');
  assert.deepEqual(extractNames(md), [
    { token: 'glide-core/src/timeout_watchdog.rs', kind: 'path' },
    { token: 'src/modules/', kind: 'dir' },
    { token: 'src/rdb.c', kind: 'path' },
    { token: 'ConnectionManager::reconnect', kind: 'qualified' },
    { token: 'bodyOnly_name', kind: 'symbol' },
  ]);
});

test('frontmatter lines other than the description are not read', () => {
  const md = '---\nname: `name_in_frontmatter`\ndescription: plain words\n---\n`body_name`\n';
  assert.deepEqual(tokens(md), ['body_name']);
});

test('a skill without frontmatter is all body', () => {
  assert.deepEqual(tokens('# Title\n\nUses `emptyDB`.\n'), ['emptyDB']);
});

test('suppressed pieces and their markers are skipped', () => {
  const md = skill([
    '<!-- suppressed: superseded in 9.1.2, 2026-10-13; `emptyDB` is now `emptyData`; evidence: valkey-io/valkey@0123456789abcdef0123456789abcdef01234567:src/db.c:10 -->',
    'Call `emptyDB` with `old_flag_name`.',
    '<!-- /suppressed -->',
    'Call `emptyData` with `old_flag_name`.',
  ].join('\n'));
  assert.deepEqual(tokens(md), ['emptyData', 'old_flag_name']);
});

test('an opening marker with no closing one hides only itself', () => {
  const md = skill('<!-- suppressed: superseded in 9.1.2, 2026-10-13; `markerName_x`; evidence: x -->\n`still_cited`\n');
  assert.deepEqual(tokens(md), ['still_cited']);
});

test('only the blocks parseSuppressed reads as well formed hide their names', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567';
  const open = (release = '9.1.2', reason = '`emptyDB` is now `emptyData`', evidence = `valkey-io/valkey@${SHA}:src/db.c:10`) =>
    `<!-- suppressed: superseded in ${release}, 2026-10-13; ${reason}; evidence: ${evidence} -->`;
  const close = '<!-- /suppressed -->';
  let n = 0;
  const name = () => `\`name_${n++}_x\``;
  const cases = {
    'well formed': [open(), name(), close, name()],
    'branch label': [open('unstable@0123456789ab'), name(), close, name()],
    'indented and CRLF': [`  ${open()}\r`, `${name()}\r`, `  ${close}\r`, name()],
    'release not a tag or label': [open('main'), name(), close, name()],
    'reason ends the comment': [open('9.1.2', 'a --> b'), name(), close, name()],
    'bad citation': [open('9.1.2', 'x', `valkey-io/valkey@${SHA}:../etc/passwd:1`), name(), close, name()],
    'bad date': [open('9.1.2', 'x').replace('2026-10-13', '2026-02-30'), name(), close, name()],
    'unclosed': [open(), name(), name()],
    'empty': [open(), close, name()],
    'malformed close': [open(), name(), '<!-- /suppressed x -->', name()],
    'nested': [open(), name(), open(), name(), close, name(), close, name()],
    'opened inside a fence': ['```', open(), '```', name(), close, name()],
  };
  for (const [label, body] of Object.entries(cases)) {
    const md = skill(body.join('\n'));
    const found = new Set(tokens(md));
    const hidden = listSuppressedBlocks(md);
    const lines = md.split('\n');
    let fenced = false;
    lines.forEach((line, i) => {
      if (line.startsWith('```')) fenced = !fenced;
      const m = /`(name_\d+_x)`/.exec(line);
      if (!m || fenced) return;
      const inBlock = hidden.some((b) => i + 1 > b.startLine && i + 1 < b.endLine);
      assert.equal(found.has(m[1]), !inBlock, `${label}: ${m[1]} at line ${i + 1}`);
    });
    assert.equal(found.has('emptyDB') || found.has('emptyData'), false, `${label}: marker lines are never read`);
  }
  // The well-formed cases do hide their piece.
  assert.equal(listSuppressedBlocks(skill(cases['well formed'].join('\n'))).length, 1);
  assert.equal(listSuppressedBlocks(skill(cases.nested.join('\n'))).length, 1);
});

test('names are deduped in first-seen order and capped', () => {
  assert.deepEqual(tokens(skill('`b_name` `a_name` `b_name` `a_name`')), ['b_name', 'a_name']);
  const many = Array.from({ length: MAX_NAMES + 50 }, (_, i) => `\`sym_${i}\``).join(' ');
  const names = tokens(skill(many));
  assert.equal(names.length, MAX_NAMES);
  assert.equal(names[0], 'sym_0');
  assert.equal(names.at(-1), `sym_${MAX_NAMES - 1}`);
});

test('CRLF line endings do not change the result', () => {
  const md = skill('Uses `emptyDB`.\n\n```\n`fenced_name`\n```\n`after_fence`');
  assert.deepEqual(tokens(md.replace(/\n/g, '\r\n')), tokens(md));
});

test('the Valkey fixture yields its cited names, without fenced placeholders', () => {
  const names = extractNames(fixture('valkey-rdb-load.md'));
  const byToken = Object.fromEntries(names.map((n) => [n.token, n.kind]));
  assert.deepEqual(names.slice(0, 3).map((n) => n.token), ['src/rdb.c', 'src/replication.c', 'src/debug.c'], 'description paths come first');
  for (const [token, kind] of Object.entries({
    emptyDB: 'symbol',
    rdbLoadRio: 'symbol',
    replicaLoadPrimaryRDBFromSocket: 'symbol',
    replicationCachePrimaryUsingMyself: 'symbol',
    RDB_INCOMPATIBLE: 'symbol',
    'server.primary': 'qualified',
    'lazyfree-lazy-user-flush': 'config',
    'REPL_STATE_*': 'prefix',
    'src/dict.c': 'path',
  })) assert.equal(byToken[token], kind, token);
  for (const dropped of ['rdbLoadFromSomething', 'exampleHelper_DoNotCite', 'dict', 'debug loadaof']) {
    assert.equal(byToken[dropped], undefined, dropped);
  }
});

test('the GLIDE fixture reads its folded description and Rust paths', () => {
  const names = extractNames(fixture('glide-reconnect.md'));
  const byToken = Object.fromEntries(names.map((n) => [n.token, n.kind]));
  assert.deepEqual(names.slice(0, 3), [
    { token: 'glide-core/src/client/reconnecting_connection.rs', kind: 'path' },
    { token: 'glide-core/redis-rs/redis/src/retry_strategies.rs', kind: 'path' },
    { token: 'ReconnectingConnection::reconnect', kind: 'qualified' },
  ]);
  for (const [token, kind] of Object.entries({
    get_infinite_backoff_dur_iterator: 'symbol',
    'ReconnectReason::ConnectionDropped': 'qualified',
    'glide-core/src/client/**': 'glob',
    IAMTokenHandle: 'symbol',
    'java/': 'dir',
  })) assert.equal(byToken[token], kind, token);
  assert.equal(byToken.reconnect, undefined, 'a plain lowercase word is weak');
});
