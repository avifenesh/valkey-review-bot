import { Model } from '@strands-agents/sdk';

/**
 * A model that plays back one scripted turn per call (the last one
 * repeats) and records the history each call was sent.
 */
export class ScriptedModel extends Model {
  constructor(turns) {
    super();
    this.turns = turns;
    this.calls = 0;
    this.sent = [];
    this.config = { modelId: 'scripted' };
  }
  getConfig() { return this.config; }
  updateConfig(config) { Object.assign(this.config, config); }
  async *stream(messages) {
    this.sent.push([...messages]);
    const turn = this.turns[Math.min(this.calls, this.turns.length - 1)];
    this.calls++;
    yield* turn(this.calls);
  }
}

export const toolTurn = (name, input) => async function* (n) {
  yield { type: 'modelMessageStartEvent', role: 'assistant' };
  yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name, toolUseId: `call-${n}` } };
  yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(input) } };
  yield { type: 'modelContentBlockStopEvent' };
  yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
};

export const textTurn = (text) => async function* () {
  yield { type: 'modelMessageStartEvent', role: 'assistant' };
  yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } };
  yield { type: 'modelContentBlockStopEvent' };
  yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
};

export const failingTurn = (error) => async function* () { throw error; };

/** The text blocks of a message, joined by newlines. */
export const textOf = (message) => message.content.filter((b) => b.type === 'textBlock').map((b) => b.text).join('\n');
