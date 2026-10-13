import { z } from 'zod';
import type { Octokit } from '@octokit/rest';
import type { PrContext } from './workspace.js';

/**
 * Sticky review-state comment: one bot-owned top-level comment per PR,
 * rewritten by every review run (post_review and skip_review alike), so
 * the PR always shows the reviewer's current verdict instead of a trail
 * of per-run summaries. The next run finds it again by STATE_MARKER and
 * hands its body back to the agent so open findings carry over.
 *
 * The agent fills a fixed schema and the runtime renders it, which keeps
 * the comment's shape identical across runs and models.
 */

export const STATE_MARKER = '<!-- valkey-reviewer:state -->';

/**
 * `text` with every STATE_MARKER removed, for model-written text the app
 * posts as a comment, so that comment cannot pass for the state comment.
 * Repeats until none is left: removing one copy can join the text around
 * it into a new one.
 */
export function stripStateMarker(text: string): string {
  let out = text;
  while (out.includes(STATE_MARKER)) out = out.replaceAll(STATE_MARKER, '');
  return out;
}

export const reviewStateSchema = z.object({
  status: z.enum(['needs_work', 'ready_for_human_review']).describe(
    '"ready_for_human_review" only when you would approve this PR as it stands: no open blocking finding and no open direction concern. Otherwise "needs_work".',
  ),
  summary: z.string().min(1).describe('One or two short, plain sentences on where the PR stands now.'),
  risk: z.enum(['low', 'medium', 'high']).describe('Risk of merging the PR as it stands at this head.'),
  risk_reason: z.string().min(1).describe('One short sentence: what breaks, and for whom, if this change is wrong.'),
  findings: z.array(z.object({
    location: z.string().describe('`path:line`, or "" for a PR-wide finding.'),
    summary: z.string().min(1).describe('The finding in one short sentence.'),
    blocking: z.boolean().describe('true if this must be fixed before merge.'),
    resolved: z.boolean().describe('true if fixed at the current head (carry-over findings from the previous state).'),
  })).default([]).describe('Every finding from this run plus every finding carried over from the previous state comment, each marked open or resolved.'),
  backport: z.object({
    verdict: z.enum(['needed', 'not_needed', 'unclear']),
    branches: z.array(z.string()).default([]).describe('Release branches that need the backport, named as in the PR overview\'s release-line list, e.g. ["8.1", "9.0"]. Empty unless verdict is "needed".'),
    reason: z.string().min(1).describe('One short sentence, e.g. which commit introduced the bug and which release lines carry it.'),
  }),
  direction: z.string().default('').describe('A different approach for the whole PR, only if you checked it against the code and it is clearly better than what the PR does. Empty otherwise.'),
});

export type ReviewState = z.infer<typeof reviewStateSchema>;

/**
 * Returns an error message when the state contradicts itself, else null.
 * `releaseBranches` are the maintained release lines the workspace found;
 * when known, a "needed" backport may only name those.
 */
export function validateReviewState(state: ReviewState, releaseBranches?: readonly string[] | null): string | null {
  if (state.status === 'ready_for_human_review') {
    const openBlocking = state.findings.filter((f) => f.blocking && !f.resolved);
    if (openBlocking.length > 0) {
      return `status is "ready_for_human_review" but ${openBlocking.length} blocking finding(s) are still open. Mark them resolved only if fixed at this head; otherwise set status to "needs_work".`;
    }
    if (state.direction.trim()) {
      return 'status is "ready_for_human_review" but `direction` proposes a different approach. Either set status to "needs_work" or clear `direction`.';
    }
  }
  const bp = state.backport;
  if (bp.verdict === 'needed') {
    if (bp.branches.length === 0) {
      return 'backport verdict is "needed" but `backport.branches` is empty. List the release branches that need it, or use "unclear".';
    }
    if (releaseBranches) {
      const known = new Set(releaseBranches);
      const unknown = bp.branches.filter((b) => !known.has(b));
      if (unknown.length > 0) {
        const allowed = releaseBranches.length > 0
          ? `the maintained release lines: ${releaseBranches.join(', ')}`
          : 'a maintained release line, and none was found. Use "not_needed" or "unclear" and explain in `reason`';
        return `backport.branches has ${unknown.map((b) => `"${b}"`).join(', ')}, but each entry must be one of ${allowed}.`;
      }
    }
  }
  return null;
}

const RISK_LABEL: Record<ReviewState['risk'], string> = { low: 'Low', medium: 'Medium', high: 'High' };

function findingLine(f: ReviewState['findings'][number]): string {
  const where = f.location.trim() ? `\`${f.location.trim()}\` ` : '';
  const minor = f.blocking ? '' : '(minor) ';
  return `- ${minor}${where}${f.summary.trim()}`;
}

export function renderReviewState(state: ReviewState, headSha: string, now: Date = new Date()): string {
  const open = state.findings.filter((f) => !f.resolved);
  const resolved = state.findings.filter((f) => f.resolved);
  const lines: string[] = [STATE_MARKER, '### Review state', ''];

  lines.push(state.status === 'ready_for_human_review'
    ? '**Ready for human review.**'
    : '**Not ready for human review yet.**');
  lines.push(state.summary.trim(), '');

  lines.push(`**Risk:** ${RISK_LABEL[state.risk]}. ${state.risk_reason.trim()}`, '');

  if (open.length > 0) {
    lines.push(`**Open findings (${open.length})**`);
    for (const f of open) lines.push(findingLine(f));
  } else {
    lines.push('**Open findings:** none.');
  }
  lines.push('');
  if (resolved.length > 0) {
    lines.push(`**Resolved (${resolved.length})**`);
    for (const f of resolved) lines.push(findingLine(f));
    lines.push('');
  }

  const bp = state.backport;
  const bpHead = bp.verdict === 'needed'
    ? `Needed${bp.branches.length > 0 ? ` for ${bp.branches.join(', ')}` : ''}.`
    : bp.verdict === 'not_needed' ? 'Not needed.' : 'Unclear.';
  lines.push(`**Backport:** ${bpHead} ${bp.reason.trim()}`, '');

  if (state.direction.trim()) {
    lines.push('**Direction**', state.direction.trim(), '');
  }

  const stamp = now.toISOString().slice(0, 16).replace('T', ' ');
  lines.push(`<sub>Updated for ${headSha.slice(0, 10)} at ${stamp} UTC. The bot rewrites this comment on every review.</sub>`);
  return lines.join('\n');
}

/**
 * Creates the state comment on first use and edits it afterwards. One
 * writer per run, shared by post_review and skip_review, so a retried
 * terminal call edits the comment it just created instead of adding a
 * second one.
 */
export interface StateCommentWriter {
  write(body: string): Promise<{ id: number; url: string }>;
}

interface RequestErrorFields {
  readonly status?: unknown;
  readonly message?: unknown;
  readonly response?: { readonly headers?: Readonly<Record<string, unknown>> };
}

/**
 * 404: the comment was deleted. 403: the app may no longer edit it. Both
 * mean "start a new one", except that GitHub also answers 403 to rate
 * limiting, which a new comment would not fix.
 */
function isGone(err: unknown): boolean {
  const e = (err ?? {}) as RequestErrorFields;
  if (e.status === 404) return true;
  if (e.status !== 403) return false;
  const headers = e.response?.headers ?? {};
  const rateLimited = headers['retry-after'] !== undefined
    || headers['x-ratelimit-remaining'] === '0'
    || (typeof e.message === 'string' && /rate limit/i.test(e.message));
  return !rateLimited;
}

export function createStateCommentWriter(octokit: Octokit, ctx: PrContext): StateCommentWriter {
  let commentId = ctx.previousState?.id ?? null;
  return {
    async write(body: string) {
      if (commentId !== null) {
        try {
          const { data } = await octokit.issues.updateComment({
            owner: ctx.owner, repo: ctx.repo, comment_id: commentId, body,
          });
          return { id: data.id, url: data.html_url };
        } catch (err) {
          if (!isGone(err)) throw err;
          console.warn(`[review-state] state comment ${commentId} cannot be edited (status ${(err as { status: number }).status}); creating a new one`);
        }
      }
      const { data } = await octokit.issues.createComment({
        owner: ctx.owner, repo: ctx.repo, issue_number: ctx.prNumber, body,
      });
      commentId = data.id;
      return { id: data.id, url: data.html_url };
    },
  };
}
