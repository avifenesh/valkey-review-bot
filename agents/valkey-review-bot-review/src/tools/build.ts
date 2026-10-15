import { buildChildEnv, resolveInside } from '../../../common/src/tools/child-env.js';
import { runBounded } from '../../../common/src/tools/spawn.js';
import { z } from 'zod';
import { tool } from '@strands-agents/sdk';
import { OFFLINE_ENV, SUBCOMMAND_NAMES, SUBCOMMANDS, checkBuildArgs, describeBuildTool, finalArgs } from './build-policy.js';

export function buildReviewBotBuildTool(opts: { workspaceRoot: string }) {
  return tool({
    name: 'build',
    description: describeBuildTool(),
    inputSchema: z.object({
      subcommand: z.enum(SUBCOMMAND_NAMES),
      args: z.array(z.string()).min(1).describe('argv tokens after the subcommand, e.g. ["run", "typecheck"], ["tsc", "--noEmit"] or ["--test", "test/prompt.test.mjs"]'),
      dir: z.string().describe('Package directory relative to the checkout, e.g. "infra", "webhook" or "agents/common".'),
    }),
    callback: async (input) => {
      const refused = checkBuildArgs(input.subcommand, input.args, input.dir);
      if (refused) return `ERROR: ${refused}`;

      const cwd = resolveInside(opts.workspaceRoot, input.dir);
      if (!cwd) return `ERROR: dir "${input.dir}" is outside the workspace.`;

      const spec = SUBCOMMANDS[input.subcommand];
      const r = await runBounded(spec.binary, finalArgs(input.subcommand, input.args), {
        cwd, env: { ...buildChildEnv(), ...OFFLINE_ENV }, timeoutMs: 8 * 60_000, maxBytes: 1_000_000, maxErrBytes: 128_000, graceMs: 3000,
      });
      return `${r.out}\n${r.err ? `\n--- stderr ---\n${r.err}` : ''}\n[exit ${r.code}]`;
    },
  });
}
