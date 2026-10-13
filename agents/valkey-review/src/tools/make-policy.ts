/**
 * What the make tool lets the reviewer run. This file has no imports so
 * the tests can load it directly.
 */

/**
 * Targets that compile the code under review or run its C unit tests. The
 * Tcl suites (`make test`) take far longer than a review allows. Install
 * targets write outside the checkout, and `persist-settings` runs
 * `distclean`, which throws away the dependency builds.
 */
export const MAKE_ALLOWED_TARGETS: readonly string[] = [
  'all', 'valkey-server', 'valkey-cli', 'valkey-benchmark', 'valkey-sentinel',
  'test-unit',
  'clean',
  'Makefile.dep',
];

/** Variables the reviewer may set as `VAR=value`. */
export const MAKE_ALLOWED_VARS: readonly string[] = [
  'CFLAGS', 'BUILD_TLS', 'USE_SYSTEMD', 'MALLOC', 'SANITIZER',
  'VERBOSE', 'PROG_SUFFIX', 'DEBUG', 'OPTIMIZATION',
];

const VAR_VALUE = /^[A-Za-z0-9_\-. /=]+$/;

export interface MakeRequest {
  readonly targets: readonly string[];
  readonly vars?: Readonly<Record<string, string>>;
  readonly parallel: number;
}

/** The make argv for a request, or the reason it is refused. */
export function makeArgs(req: MakeRequest): { args: string[] } | { error: string } {
  for (const t of req.targets) {
    if (!MAKE_ALLOWED_TARGETS.includes(t)) {
      return { error: `target "${t}" not allowed. Allowed: ${MAKE_ALLOWED_TARGETS.join(', ')}.` };
    }
  }
  const assignments: string[] = [];
  for (const [k, v] of Object.entries(req.vars ?? {})) {
    if (!MAKE_ALLOWED_VARS.includes(k)) {
      return { error: `var "${k}" not allowed. Allowed: ${MAKE_ALLOWED_VARS.join(', ')}.` };
    }
    if (!VAR_VALUE.test(v)) return { error: `var "${k}" value has forbidden characters.` };
    assignments.push(`${k}=${v}`);
  }
  return { args: [`-j${req.parallel}`, ...req.targets, ...assignments] };
}

/**
 * Whether the build tool is offered at all. ALLOW_BUILD is the setting.
 * ALLOW_MAKE is its older name and is read only when ALLOW_BUILD is unset.
 */
export function buildToolEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env.ALLOW_BUILD || env.ALLOW_MAKE || 'false';
  return value.toLowerCase() === 'true';
}
