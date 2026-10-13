import { z } from 'zod';
import { tool } from '@strands-agents/sdk';
import { fail, ok, type CuratorRun } from './run.js';

export const DECISIONS = ['bumped', 'updated', 'merged', 'created', 'deleted', 'graduated', 'dropped', 'noop'] as const;

/**
 * Terminal tool. It records the decision on the run; the agent loop
 * stops after the tool round that contains it (see curate.ts), so the
 * model gets no further turn.
 */
export function buildCuratorDoneTool(run: CuratorRun) {
  return tool({
    name: 'curator_done',
    description:
`End the run. Call exactly once, last.
- \`decision\`: "bumped", "updated", "merged", "created", "deleted", "graduated" (a bump or merge followed by submit_skill), "dropped" (noise or out of scope, no change) or "noop" (a possible concern, but too weak to record yet).
- \`summary\`: one sentence of rationale naming the record_ids you touched, or "none".

No tool call is honored after this one.`,
    inputSchema: z.object({
      decision: z.enum(DECISIONS),
      summary: z.string().min(1).max(1000),
    }),
    callback: async (input) => {
      if (run.done) return fail('curator_done: already called');
      run.done = { decision: input.decision, summary: input.summary };
      return ok({ decision: input.decision });
    },
  });
}
