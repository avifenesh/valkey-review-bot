import { buildChildEnv, resolveInside } from '../../../common/src/tools/child-env.js';
import { runBounded } from '../../../common/src/tools/spawn.js';
import { z } from 'zod';
import { tool } from '@strands-agents/sdk';
import { SUBCOMMAND_NAMES, SUBCOMMANDS, checkBuildArgs, describeBuildTool } from './build-policy.js';

export function buildGlideBuildTool(opts: { workspaceRoot: string }) {
  return tool({
    name: 'build',
    description: describeBuildTool(),
    inputSchema: z.object({
      subcommand: z.enum(SUBCOMMAND_NAMES),
      args: z.array(z.string()).min(1).describe('argv tokens after the subcommand, e.g. ["test", "--lib"] or [":client:compileJava"]'),
      subdir: z.string().optional().describe('cwd relative to the checkout. Defaults to the subcommand\'s directory (glide-core for cargo, java for gradle, go for go, node for npm and npx).'),
    }),
    callback: async (input) => {
      const refused = checkBuildArgs(input.subcommand, input.args);
      if (refused) return `ERROR: ${refused}`;

      const spec = SUBCOMMANDS[input.subcommand];
      const subdir = input.subdir ?? spec.defaultDir;
      const cwd = resolveInside(opts.workspaceRoot, subdir);
      if (!cwd) return `ERROR: subdir "${subdir}" is outside the workspace.`;

      const r = await runBounded(spec.binary, input.args, {
        cwd, env: buildChildEnv(), timeoutMs: 8 * 60_000, maxBytes: 1_000_000, maxErrBytes: 128_000, graceMs: 3000,
      });
      return `${r.out}\n${r.err ? `\n--- stderr ---\n${r.err}` : ''}\n[exit ${r.code}]`;
    },
  });
}
