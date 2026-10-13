import { spawn } from 'node:child_process';
import { buildChildEnv, resolveInside } from '../../../common/src/tools/child-env.js';
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

      return await new Promise<string>((resolve) => {
        const child = spawn('make', args, { cwd, env: buildChildEnv() });
        const chunks: Buffer[] = [];
        let total = 0;
        const MAX = 1_000_000;
        let truncated = false;
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 3000);
        }, 8 * 60_000);
        const onData = (b: Buffer) => {
          if (total + b.length > MAX) {
            chunks.push(b.subarray(0, Math.max(0, MAX - total)));
            total = MAX;
            truncated = true;
            child.kill('SIGTERM');
          } else {
            chunks.push(b);
            total += b.length;
          }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('error', (err) => {
          clearTimeout(timer);
          resolve(`ERROR: could not run make: ${err.message}`);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          const out = Buffer.concat(chunks).toString('utf8');
          resolve(`${out}${truncated ? '\n[output truncated]' : ''}\n[exit ${code}]`);
        });
      });
    },
  });
}
