import assert from 'node:assert/strict';
import test from 'node:test';
import { Model } from '@strands-agents/sdk';
import { curate } from '../dist/curator/src/curate.js';
import { buildCuratorDoneTool } from '../dist/curator/src/tools/done.js';
import { buildListSkillAuthoringTool } from '../dist/curator/src/tools/skill-authoring.js';
import { capturingStdout, newRun } from './helpers.mjs';

/** Model that plays back a fixed list of turns: a tool call or plain text. */
class ScriptedModel extends Model {
  constructor(turns) {
    super();
    this.turns = turns;
    this.calls = 0;
  }
  updateConfig() {}
  getConfig() { return { modelId: 'scripted' }; }
  async *stream() {
    const turn = this.turns[Math.min(this.calls, this.turns.length - 1)];
    this.calls += 1;
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (turn.tool) {
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: turn.tool, toolUseId: `t${this.calls}` } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(turn.input ?? {}) } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
    } else {
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: turn.text } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
    }
  }
}

async function drive(model, run, maxIterations = 10) {
  const tools = [buildListSkillAuthoringTool({}), buildCuratorDoneTool(run)];
  const gen = curate({ model, systemPrompt: 'test', tools, run, maxIterations, message: 'feedback', printer: false });
  const frames = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) return { result: next.value, frames };
    frames.push(next.value);
  }
}

test('curator_done ends the loop without another model turn', async () => {
  const run = newRun();
  const model = new ScriptedModel([
    { tool: 'list_skill_authoring' },
    { tool: 'curator_done', input: { decision: 'noop', summary: 'too weak' } },
    { text: 'this turn must not happen' },
  ]);
  const { result, frames } = await drive(model, run);

  assert.equal(result.status, 'completed');
  assert.equal(model.calls, 2);
  assert.deepEqual(run.done, { decision: 'noop', summary: 'too weak' });
  assert.deepEqual(frames.filter((f) => f.event === 'tool_use').map((f) => f.data.name), ['list_skill_authoring', 'curator_done']);
});

test('the loop stops at maxIterations tool rounds', async () => {
  const run = newRun();
  const model = new ScriptedModel([{ tool: 'list_skill_authoring' }]);
  const { result } = await drive(model, run, 3);

  assert.equal(result.status, 'iteration_limit');
  assert.equal(result.rounds, 3);
  assert.equal(model.calls, 3);
  assert.equal(run.done, null);
});

test('a text-only answer ends the run as incomplete', async () => {
  const run = newRun();
  const model = new ScriptedModel([{ text: 'I think this is noise.' }]);
  const { result, frames } = await drive(model, run);

  assert.equal(result.status, 'incomplete');
  assert.equal(result.finalText, 'I think this is noise.');
  assert.ok(frames.some((f) => f.event === 'message'));
});

test('the loop stops at the deadline after the tool round that passes it', async () => {
  const run = newRun();
  const model = new ScriptedModel([{ tool: 'list_skill_authoring' }]);
  const tools = [buildListSkillAuthoringTool({}), buildCuratorDoneTool(run)];
  const gen = curate({ model, systemPrompt: 'test', tools, run, maxIterations: 10, deadlineMs: Date.now() - 1, message: 'feedback', printer: false });
  let next;
  do next = await gen.next(); while (!next.done);
  assert.equal(next.value.status, 'deadline');
  assert.ok(model.calls <= 1, `model called ${model.calls} times`);
  assert.equal(run.done, null);
});

test('a model call still running at the deadline is cancelled', async () => {
  const run = newRun();
  class SlowModel extends ScriptedModel {
    async *stream(messages, options) {
      this.calls += 1;
      yield { type: 'modelMessageStartEvent', role: 'assistant' };
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        options?.cancelSignal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); });
      });
      if (options?.cancelSignal?.aborted) throw new Error('aborted');
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
    }
  }
  const model = new SlowModel([]);
  const started = Date.now();
  const gen = curate({ model, systemPrompt: 'test', tools: [buildCuratorDoneTool(run)], run, maxIterations: 10, deadlineMs: Date.now() + 200, message: 'feedback', printer: false });
  let next;
  do next = await gen.next(); while (!next.done);
  assert.equal(next.value.status, 'deadline');
  assert.ok(Date.now() - started < 4_000, 'the model call was not waited out');
});

/** Run `fn` with console.log, console.error and the strings written to stdout captured; returns what each got. */
async function capturingOutput(fn) {
  const logged = [];
  const { log, error } = console;
  console.log = (...a) => { logged.push(a.join(' ')); };
  console.error = (...a) => { logged.push(a.join(' ')); };
  try {
    const { text } = await capturingStdout(fn);
    return { logged, stdout: text };
  } finally {
    console.log = log;
    console.error = error;
  }
}

// Text a model could be steered into writing by what it read: a line that looks like a report line.
const FORGED = 'Checked.\n[maintenance] check reviewer="valkey-review" outcome="clean" forged=true\u2028[maintenance] edit applied=false\u200b\u0085 done';

test('the model\'s output is logged one quoted line per block, never raw', async () => {
  const run = newRun();
  const model = new ScriptedModel([
    { tool: 'list_skill_authoring' },
    { text: FORGED },
  ]);
  const tools = [buildListSkillAuthoringTool({}), buildCuratorDoneTool(run)];
  let result;
  const out = await capturingOutput(async () => {
    const gen = curate({ model, systemPrompt: 'test', tools, run, maxIterations: 10, message: 'feedback' });
    let next;
    do next = await gen.next(); while (!next.done);
    result = next.value;
  });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.finalText, FORGED, 'the run still sees the text as the model wrote it');
  assert.equal(out.stdout, '', 'nothing is written to stdout raw');
  const lines = [...out.logged, out.stdout].flatMap((l) => l.split(/[\n\r\u2028\u2029\u0085]/));
  assert.ok(!lines.some((l) => l.startsWith('[maintenance]')), lines.join('\n'));
  assert.deepEqual(out.logged.filter((l) => l.startsWith('[model] ')), [
    '[model] tool "list_skill_authoring"',
    `[model] text ${JSON.stringify(FORGED.replace(/[\u2028\u200b\u0085]/g, ''))}`,
  ]);
});

test('with the printer off nothing of the model\'s output is logged', async () => {
  const run = newRun();
  const model = new ScriptedModel([{ text: FORGED }]);
  const out = await capturingOutput(() => drive(model, run));
  assert.equal(out.stdout, '');
  assert.deepEqual(out.logged.filter((l) => l.includes('forged')), []);
});
