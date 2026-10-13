import { buildChildEnv, resolveInside } from '../../../common/src/tools/child-env.js';
import { runBounded } from '../../../common/src/tools/spawn.js';
import { z } from 'zod';
import { tool } from '@strands-agents/sdk';
import { MAKE_ALLOWED_TARGETS, MAKE_ALLOWED_VARS, makeArgs } from './make-policy.js';

export function buildMakeTool(opts: { workspaceRoot: string }) {
  return tool({
    name: 'make',
    description:
`Run make in the valkey checkout, from the repo root or from src/. Only compile and unit-test targets are allowed. The Tcl integration tests are out of scope for the reviewer.

Allowed targets: ${MAKE_ALLOWED_TARGETS.join(', ')}.
Allowed vars (as \`VAR=value\`): ${MAKE_ALLOWED_VARS.join(', ')}.

Output is capped at 1 MB and 8 minutes. The tool returns stdout+stderr; exit code is reported at the end.`,
    inputSchema: z.object({
      targets: z.array(z.string()).default(['all']).describe('Make targets, e.g. ["all"] or ["test-unit"]'),
      vars: z.record(z.string(), z.string()).optional().describe('Variable assignments, e.g. { CFLAGS: "-O0 -g" }'),
      parallel: z.number().int().min(1).max(16).default(4).describe('Value for -j'),
      subdir: z.enum(['', 'src']).default('').describe('"" for repo root; "src" for valkey/src'),
    }),
    callback: async (input) => {
      const checked = makeArgs(input);
      if ('error' in checked) return `ERROR: ${checked.error}`;
      const args = checked.args;
      const cwd = resolveInside(opts.workspaceRoot, input.subdir);
      if (!cwd) return `ERROR: subdir "${input.subdir}" is outside the workspace.`;

      const r = await runBounded('make', args, {
        cwd, env: buildChildEnv(), timeoutMs: 8 * 60_000, maxBytes: 1_000_000, mergeStderr: true, graceMs: 3000,
      });
      if (r.err) return `ERROR: ${r.err}`;
      return `${r.out}\n[exit ${r.code}]`;
    },
  });
}
