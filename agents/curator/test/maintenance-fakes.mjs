import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Model } from '@strands-agents/sdk';

/**
 * Fakes for the maintenance tests: a concerns table that evaluates the
 * expressions maintenance.ts writes, a skills registry, an upstream git
 * repository served over file://, and a scripted model.
 */

export function conditionFailed() {
  return Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
}

/**
 * One condition clause against an item: `#n = :v`, `#n <> :v`,
 * attribute_exists, attribute_not_exists, or an OR of those in
 * parentheses. Anything else throws, so a test cannot pass on a clause it
 * did not evaluate.
 */
function clauseHolds(item, clause, names, values) {
  const attr = (p) => (item === undefined ? undefined : item[names[p]]);
  const or = clause.match(/^\((.+)\)$/);
  if (or) return or[1].split(' OR ').some((c) => clauseHolds(item, c, names, values));
  let m;
  if ((m = clause.match(/^attribute_exists\((#\w+)\)$/))) return attr(m[1]) !== undefined;
  if ((m = clause.match(/^attribute_not_exists\((#\w+)\)$/))) return attr(m[1]) === undefined;
  if ((m = clause.match(/^(#\w+) = (:\w+)$/))) return attr(m[1]) !== undefined && attr(m[1]) === values[m[2]];
  if ((m = clause.match(/^(#\w+) <> (:\w+)$/))) return attr(m[1]) !== undefined && attr(m[1]) !== values[m[2]];
  throw new Error(`cannot evaluate "${clause}"`);
}

export function conditionHolds(item, input) {
  if (!input.ConditionExpression) return true;
  const names = input.ExpressionAttributeNames ?? {};
  const values = input.ExpressionAttributeValues ?? {};
  return input.ConditionExpression.split(' AND ').every((c) => clauseHolds(item, c, names, values));
}

/** Apply `SET #n = :v, ...` and `REMOVE #n, ...` to a copy of the item. */
export function applyUpdate(item, input) {
  const names = input.ExpressionAttributeNames ?? {};
  const values = input.ExpressionAttributeValues ?? {};
  const next = structuredClone(item ?? input.Key);
  const m = input.UpdateExpression.match(/^(?:SET (.+?))?(?:\s*REMOVE (.+))?$/);
  if (!m || (!m[1] && !m[2])) throw new Error(`cannot apply "${input.UpdateExpression}"`);
  for (const clause of m[1] ? m[1].split(', ') : []) {
    const set = clause.match(/^(#\w+) = (:\w+)$/);
    if (!set) throw new Error(`cannot apply "${clause}"`);
    const value = values[set[2]];
    if (value instanceof Set && value.size === 0) throw new Error('DynamoDB stores no empty set');
    next[names[set[1]]] = structuredClone(value);
  }
  for (const p of m[2] ? m[2].split(', ') : []) {
    if (!/^#\w+$/.test(p)) throw new Error(`cannot remove "${p}"`);
    delete next[names[p]];
  }
  return next;
}

/** Placeholders defined must be the ones the expressions use, as DynamoDB requires. */
function checkPlaceholders(input) {
  const text = [input.UpdateExpression, input.ConditionExpression].filter(Boolean).join(' ');
  const used = new Set(text.match(/#\w+/g) ?? []);
  const usedValues = new Set(text.match(/:\w+/g) ?? []);
  const defined = Object.keys(input.ExpressionAttributeNames ?? {});
  const definedValues = Object.keys(input.ExpressionAttributeValues ?? {});
  if (defined.length !== used.size || defined.some((d) => !used.has(d))) throw new Error(`names ${defined} do not match ${[...used]}`);
  if (definedValues.length !== usedValues.size || definedValues.some((d) => !usedValues.has(d))) throw new Error(`values ${definedValues} do not match ${[...usedValues]}`);
}

/**
 * A concerns table in memory. `hooks.beforeUpdate(input, table)` runs
 * before each update is evaluated, to model a concurrent writer; it may
 * also throw.
 */
export function memoryTable(items = [], hooks = {}) {
  const keyOf = (key) => `${key.area_bucket}\u0000${key.record_id}`;
  const rows = new Map(items.map((item) => [keyOf(item), structuredClone(item)]));
  const calls = [];
  const table = {
    calls,
    item: (key) => rows.get(keyOf(key)),
    put: (item) => rows.set(keyOf(item), structuredClone(item)),
    updates: () => calls.filter((c) => c.op === 'UpdateCommand'),
    async send(command) {
      const op = command.constructor.name;
      const input = command.input;
      calls.push({ op, input });
      if (op === 'GetCommand') {
        if (input.ConsistentRead !== true) throw new Error('reads must be consistent');
        const row = rows.get(keyOf(input.Key));
        return { Item: row ? structuredClone(row) : undefined };
      }
      if (op === 'UpdateCommand') {
        checkPlaceholders(input);
        await hooks.beforeUpdate?.(input, table);
        const current = rows.get(keyOf(input.Key));
        if (!conditionHolds(current, input)) throw conditionFailed();
        rows.set(keyOf(input.Key), applyUpdate(current, input));
        return {};
      }
      throw new Error(`unexpected ${op}`);
    },
  };
  return table;
}

/** A skills registry in memory, keyed by name. `opts.deprecate` replaces the default deprecation. */
export function fakeRegistry(records = [], opts = {}) {
  const byName = new Map(records.map((r) => [r.name, { recordId: `rec-${r.name}`, recordArn: `arn:rec-${r.name}`, description: '', status: 'DRAFT', ...r }]));
  const calls = [];
  return {
    calls,
    record: (name) => byName.get(name),
    async get(name) {
      calls.push(['get', name]);
      const r = byName.get(name);
      return r ? { ...r } : null;
    },
    async update(input) {
      calls.push(['update', input.name]);
      if (opts.update) return opts.update(input, byName);
      const r = byName.get(input.name);
      if (!r) throw new Error(`no skill record named "${input.name}" to update`);
      if (r.status === 'DEPRECATED' || r.status === 'REJECTED') throw Object.assign(new Error('retired'), { name: 'SkillRetiredError' });
      r.skillMd = input.skillMd;
      r.description = input.description;
      return { status: 'UPDATING' };
    },
    async deprecate(recordId, reason) {
      calls.push(['deprecate', recordId, reason]);
      if (opts.deprecate) return opts.deprecate(recordId, reason, byName);
      const r = [...byName.values()].find((x) => x.recordId === recordId);
      r.status = 'DEPRECATED';
      return 'DEPRECATED';
    },
  };
}

const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com',
};

export const tempDir = (prefix) => realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));

/**
 * A bare upstream over file:// whose default branch is `unstable`, with
 * one commit per entry of `commits` (path -> content, null deletes).
 * Returns the URL and the commits' SHAs, oldest first.
 */
export function makeUpstream(commits) {
  const root = tempDir('maint-upstream-');
  const bare = path.join(root, 'upstream.git');
  const work = path.join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', bare], { env: gitEnv });
  const git = (cwd) => (...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: 'pipe' }).trim();
  const b = git(bare);
  b('symbolic-ref', 'HEAD', 'refs/heads/unstable');
  b('config', 'uploadpack.allowFilter', 'true');
  b('config', 'uploadpack.allowAnySHA1InWant', 'true');
  mkdirSync(work);
  const w = git(work);
  w('init', '-q', '-b', 'unstable');
  const shas = [];
  for (const files of commits) {
    for (const [file, content] of Object.entries(files)) {
      const full = path.join(work, file);
      if (content === null) rmSync(full);
      else {
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
    }
    w('add', '-A');
    w('commit', '-q', '--allow-empty', '-m', `commit ${shas.length}`);
    shas.push(w('rev-parse', 'HEAD'));
  }
  w('remote', 'add', 'origin', bare);
  w('push', '-q', 'origin', 'unstable');
  return { root, url: `file://${bare}`, shas, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Model that plays back a fixed list of turns: a tool call or plain text. A turn may be a function of the call number. */
export class ScriptedModel extends Model {
  constructor(turns) {
    super();
    this.turns = turns;
    this.calls = 0;
  }
  updateConfig() {}
  getConfig() { return { modelId: 'scripted' }; }
  async *stream() {
    let turn = this.turns[Math.min(this.calls, this.turns.length - 1)];
    this.calls += 1;
    if (typeof turn === 'function') turn = await turn(this.calls);
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (turn.tool) {
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: turn.tool, toolUseId: `t${this.calls}` } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(turn.input ?? {}) } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
    } else if (turn.error) {
      throw new Error(turn.error);
    } else {
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: turn.text } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
    }
  }
}

/** Run an async generator to its end; returns its return value and the frames it yielded. */
export async function drain(gen) {
  const frames = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) return { result: next.value, frames };
    frames.push(next.value);
  }
}

/** Capture console.log and console.warn lines while `fn` runs. */
export async function captureLogs(fn) {
  const lines = [];
  const { log, warn } = console;
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    const value = await fn();
    return { value, lines };
  } finally {
    console.log = log;
    console.warn = warn;
  }
}
