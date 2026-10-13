import { spawn } from 'node:child_process';

export interface BoundedResult {
  readonly code: number;
  readonly out: string;
  /** With `mergeStderr`, empty unless the command could not start. */
  readonly err: string;
  /** stdout went past the cap; the process was stopped and `out` ends with "[output truncated]". */
  readonly truncated: boolean;
}

export interface BoundedOptions {
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  /** Cap on stdout, or on stdout and stderr together with `mergeStderr`. */
  readonly maxBytes: number;
  /** Cap on stderr. Default 64 KB. */
  readonly maxErrBytes?: number;
  /** Collect stderr into `out`, in arrival order. */
  readonly mergeStderr?: boolean;
  /** Time from SIGTERM to SIGKILL. Default 2 s. */
  readonly graceMs?: number;
}

/**
 * Run a command without a shell and with bounded time and output, for the
 * tools the model calls. stdout past `maxBytes` is cut off and the process
 * stopped; stderr keeps its first `maxErrBytes`. A command that cannot
 * start resolves with code 127.
 *
 * The command runs in its own process group, and stopping it signals the
 * whole group, so what it started (sub-makes, test binaries) stops too.
 * Waiting for output ends a grace period after the command exits or is
 * stopped, even if some process outside the group still holds the pipes.
 */
export function runBounded(cmd: string, args: readonly string[], opts: BoundedOptions): Promise<BoundedResult> {
  const maxErrBytes = opts.maxErrBytes ?? 64_000;
  const graceMs = opts.graceMs ?? 2000;
  return new Promise((resolve) => {
    const child = spawn(cmd, args as string[], { cwd: opts.cwd, env: opts.env, detached: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let stopping = false;
    let settled = false;
    let exitCode: number | null = null;
    let afterExit: NodeJS.Timeout | undefined;
    let giveUp: NodeJS.Timeout | undefined;

    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        // The group has already exited.
      }
    };

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(afterExit);
      clearTimeout(giveUp);
      child.stdout.destroy();
      child.stderr.destroy();
      const outStr = Buffer.concat(out).toString('utf8') + (truncated ? '\n[output truncated]' : '');
      resolve({ code: code ?? 1, out: outStr, err: Buffer.concat(err).toString('utf8'), truncated });
    };

    // SIGTERM the group, SIGKILL it after the grace period, and stop
    // waiting for output a grace period after that.
    const stop = () => {
      if (stopping || settled) return;
      stopping = true;
      signalGroup('SIGTERM');
      setTimeout(() => signalGroup('SIGKILL'), graceMs).unref();
      giveUp = setTimeout(() => finish(exitCode), 2 * graceMs);
    };

    const timer = setTimeout(stop, opts.timeoutMs);

    const onOut = (b: Buffer) => {
      if (truncated) return;
      if (outBytes + b.length > opts.maxBytes) {
        out.push(b.subarray(0, Math.max(0, opts.maxBytes - outBytes)));
        outBytes = opts.maxBytes;
        truncated = true;
        stop();
      } else {
        out.push(b);
        outBytes += b.length;
      }
    };
    child.stdout.on('data', onOut);
    child.stderr.on('data', opts.mergeStderr ? onOut : (b: Buffer) => {
      if (errBytes >= maxErrBytes) return;
      const kept = b.subarray(0, maxErrBytes - errBytes);
      err.push(kept);
      errBytes += kept.length;
    });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 127, out: '', err: `could not run ${cmd}: ${e.message}`, truncated: false });
    });
    child.on('exit', (code) => {
      exitCode = code;
      // 'close' waits for every process that holds stdout or stderr. If
      // the command left some running, stop them after the grace period.
      if (!settled) afterExit = setTimeout(stop, graceMs);
    });
    child.on('close', (code) => finish(code ?? exitCode));
  });
}
