import { spawn } from 'node:child_process';

export interface BoundedResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  /** stdout went past the cap; the process was stopped and `out` ends with "[output truncated]". */
  readonly truncated: boolean;
}

/**
 * Run a command without a shell and with bounded time and output, for the
 * argv-only tools the model calls. stdout past `maxBytes` is cut off and
 * the process stopped; stderr keeps its first 64 KB. A command that
 * cannot start resolves with code 127.
 */
export function runBounded(
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxBytes: number },
): Promise<BoundedResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args as string[], { cwd: opts.cwd, env: opts.env });
    let out = Buffer.alloc(0);
    let err = Buffer.alloc(0);
    let truncated = false;

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, opts.timeoutMs);

    child.stdout.on('data', (b: Buffer) => {
      if (truncated) return;
      if (out.length + b.length > opts.maxBytes) {
        out = Buffer.concat([out, b.subarray(0, Math.max(0, opts.maxBytes - out.length))]);
        truncated = true;
        child.kill('SIGTERM');
      } else {
        out = Buffer.concat([out, b]);
      }
    });
    child.stderr.on('data', (b: Buffer) => {
      if (err.length + b.length > 64_000) return;
      err = Buffer.concat([err, b]);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 127, out: '', err: `could not run ${cmd}: ${e.message}`, truncated: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const outStr = out.toString('utf8') + (truncated ? '\n[output truncated]' : '');
      resolve({ code: code ?? 1, out: outStr, err: err.toString('utf8'), truncated });
    });
  });
}
