import { spawn } from 'node:child_process';
import { buildChildEnv, resolveInside } from '../../../common/src/tools/child-env.js';
import { z } from 'zod';
import { tool } from '@strands-agents/sdk';
import { SUBCOMMAND_NAMES, SUBCOMMANDS, checkBuildArgs, describeBuildTool } from './build-policy.js';

interface RunResult { code: number; out: string; err: string; truncated: boolean; }

function runBounded(cmd: string, args: readonly string[], opts: { cwd: string; timeoutMs: number; maxBytes: number; }): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args as string[], { cwd: opts.cwd, env: buildChildEnv() });
    let outBuf = Buffer.alloc(0);
    let errBuf = Buffer.alloc(0);
    let truncated = false;

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000);
    }, opts.timeoutMs);

    child.stdout.on('data', (b: Buffer) => {
      if (outBuf.length + b.length > opts.maxBytes) {
        outBuf = Buffer.concat([outBuf, b.subarray(0, Math.max(0, opts.maxBytes - outBuf.length))]);
        truncated = true;
        child.kill('SIGTERM');
      } else {
        outBuf = Buffer.concat([outBuf, b]);
      }
    });
    child.stderr.on('data', (b: Buffer) => {
      if (errBuf.length + b.length > 128_000) return;
      errBuf = Buffer.concat([errBuf, b]);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, out: '', err: `could not run ${cmd}: ${err.message}`, truncated: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        out: outBuf.toString('utf8'),
        err: errBuf.toString('utf8'),
        truncated,
      });
    });
  });
}

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

      const r = await runBounded(spec.binary, input.args, { cwd, timeoutMs: 8 * 60_000, maxBytes: 1_000_000 });
      const tail = r.truncated ? '\n[output truncated]' : '';
      return `${r.out}${tail}\n${r.err ? `\n--- stderr ---\n${r.err}` : ''}\n[exit ${r.code}]`;
    },
  });
}
