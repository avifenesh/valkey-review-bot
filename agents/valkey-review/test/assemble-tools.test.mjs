import '../../common/test/support/ts-resolve.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ctx = (workspacePath) => ({
  owner: 'o', repo: 'r', prNumber: 1, headSha: 'a'.repeat(40), workspacePath, upstreamRepo: 'o/r', previousState: null,
});

// assembleTools must hand onTerminal to the common tools. Without it the
// run cannot tell when the review was posted, and run-agent refuses to
// start the model. A type-check cannot catch a missing optional field.
test('assembleTools wires the terminal callback into the common tools', async () => {
  const { assembleTools } = await import('../src/tools/index.ts');
  const { isTerminalCallbackWired } = await import('../../common/src/tools/gh.ts');
  const workspacePath = mkdtempSync(path.join(tmpdir(), 'assemble-tools-'));
  const onTerminal = () => {};
  const tools = await assembleTools({
    ctx: ctx(workspacePath),
    octokit: {},
    tokens: { get: async () => 't' },
    allowWrite: false,
    env: {},
    onTerminal,
  });
  assert.ok(tools.length > 0);
  assert.equal(isTerminalCallbackWired(onTerminal), true);
});

/** Every tool the agent can get: writes allowed and the make tool on. */
async function fullToolNames() {
  const { assembleTools } = await import('../src/tools/index.ts');
  const prev = process.env.ALLOW_BUILD;
  process.env.ALLOW_BUILD = 'true';
  try {
    const tools = await assembleTools({
      ctx: ctx(mkdtempSync(path.join(tmpdir(), 'assemble-tools-'))),
      octokit: {},
      tokens: { get: async () => 't' },
      allowWrite: true,
      env: {},
      onTerminal: () => {},
    });
    return tools.map((t) => t.name);
  } finally {
    if (prev === undefined) delete process.env.ALLOW_BUILD;
    else process.env.ALLOW_BUILD = prev;
  }
}

test('the valkey tool set has lsp and make but no shell or batch tool', async () => {
  assert.deepEqual((await fullToolNames()).sort(), [
    'edit', 'gh_api_read', 'git', 'glob', 'grep', 'lsp', 'make', 'multi_edit', 'post_review', 'read', 'skip_review', 'write',
  ]);
});

test('the prompt names exactly the tools the agent has', async () => {
  const names = await fullToolNames();
  const prompt = readFileSync(new URL('../config/prompt.md', import.meta.url), 'utf8');
  const section = prompt.slice(prompt.indexOf('## Tools'), prompt.indexOf('## Workflow'));
  for (const name of names) assert.ok(section.includes(`\`${name}\``), `Tools section names ${name}`);
  // First cells of the tool tables, e.g. "| `write` / `edit` / `multi_edit` |".
  const tabled = section.split('\n')
    .filter((l) => l.startsWith('| `'))
    .flatMap((l) => [...l.split('|')[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]));
  assert.ok(tabled.length > 0);
  for (const name of tabled) assert.ok(names.includes(name), `the prompt lists ${name}, which the agent does not have`);
  for (const absent of ['bash', 'batch', 'post_issue_comment']) {
    assert.ok(!prompt.includes(`\`${absent}\``), `the prompt does not offer ${absent}`);
  }
  // clangd is the only server the lsp tool starts.
  const lspRow = section.split('\n').find((l) => l.startsWith('| `lsp`'));
  assert.match(lspRow, /clangd/);
  assert.doesNotMatch(lspRow, /rust-analyzer|jdtls|pyright|gopls|typescript-language-server/);
});
