import path from 'node:path';

/**
 * Environment for build and test processes the reviewer starts (make,
 * cargo, gradle, npm, go, ...). Those processes run code from the pull
 * request under review, so they get the runtime's environment minus
 * anything that carries credentials: AWS settings, GitHub tokens, and
 * any variable whose name says token, secret, password, or credential.
 */
const CREDENTIAL_NAME = /^(AWS_|AMAZON_|GH_|GITHUB_)|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY/i;

export function buildChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!CREDENTIAL_NAME.test(name)) env[name] = value;
  }
  return env;
}

/**
 * Resolve a subdirectory the model asked for, refusing anything outside
 * the workspace root (`..`, absolute paths).
 */
export function resolveInside(root: string, subdir: string | undefined): string | null {
  if (!subdir) return root;
  const full = path.resolve(root, subdir);
  return full === root || full.startsWith(root + path.sep) ? full : null;
}
