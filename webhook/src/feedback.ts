import type { GitHubUser } from './config.js';
import type { WebhookPayload } from './github.js';

/**
 * Which deliveries count as maintainer feedback for the curator, and the
 * envelope the curator receives. agents/curator validates the same
 * envelope and repeats the association and bot checks.
 */

export type FeedbackKind = 'review_comment_reply' | 'issue_comment_reply' | 'resolution';

/** author_association values whose comments may teach the curator. */
export const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export interface FeedbackItem {
  readonly kind: FeedbackKind;
  /** Stable per GitHub object: rc-, ic- or pr- followed by its id. */
  readonly feedbackId: string;
  readonly body: string;
  readonly actor: string;
  readonly actorAssociation: string;
  readonly prNumber: number;
  readonly prAuthor: string;
  readonly path?: string;
  readonly line?: number;
  /** Set when a review comment replies in a thread: the thread's first comment. */
  readonly parentCommentId?: number;
}

export type Extracted = { readonly item: FeedbackItem } | { readonly skip: string };

type Author = { readonly actor: string; readonly actorAssociation: string } | { readonly skip: string };

function author(
  user: GitHubUser | undefined,
  association: string | undefined,
  isBotAuthor: (user: GitHubUser | undefined) => boolean,
): Author {
  if (!user?.login) return { skip: 'not-feedback:no-author' };
  if (isBotAuthor(user)) return { skip: 'not-feedback:bot-author' };
  const actorAssociation = (association ?? '').toUpperCase();
  if (!TRUSTED_ASSOCIATIONS.has(actorAssociation)) {
    return { skip: `not-feedback:association=${actorAssociation || 'none'}` };
  }
  return { actor: user.login, actorAssociation };
}

/**
 * Picks the feedback out of a delivery, or names the reason it is not
 * feedback. Only new content counts: a created comment or a submitted
 * review, on a pull request, by an OWNER, MEMBER or COLLABORATOR who is
 * not a bot. Edits and deletions never reach the curator.
 */
export function extractFeedback(
  eventType: string,
  payload: WebhookPayload,
  isBotAuthor: (user: GitHubUser | undefined) => boolean,
): Extracted {
  const action = payload.action ?? '';

  if (eventType === 'pull_request_review_comment') {
    if (action !== 'created') return { skip: `not-feedback:action=${action}` };
    const c = payload.comment;
    const prNumber = payload.pull_request?.number;
    if (typeof c?.id !== 'number' || typeof prNumber !== 'number') return { skip: 'not-feedback:malformed' };
    const who = author(c.user, c.author_association, isBotAuthor);
    if ('skip' in who) return who;
    const line = c.line ?? c.original_line;
    return {
      item: {
        kind: 'review_comment_reply',
        feedbackId: `rc-${c.id}`,
        body: c.body ?? '',
        ...who,
        prNumber,
        prAuthor: payload.pull_request?.user?.login ?? '',
        ...(c.path ? { path: c.path } : {}),
        ...(typeof line === 'number' ? { line } : {}),
        ...(typeof c.in_reply_to_id === 'number' ? { parentCommentId: c.in_reply_to_id } : {}),
      },
    };
  }

  if (eventType === 'pull_request_review') {
    if (action !== 'submitted') return { skip: `not-feedback:action=${action}` };
    const r = payload.review;
    const prNumber = payload.pull_request?.number;
    if (typeof r?.id !== 'number' || typeof prNumber !== 'number') return { skip: 'not-feedback:malformed' };
    const who = author(r.user, r.author_association, isBotAuthor);
    if ('skip' in who) return who;
    return {
      item: {
        kind: 'resolution',
        feedbackId: `pr-${r.id}`,
        body: r.body ?? '',
        ...who,
        prNumber,
        prAuthor: payload.pull_request?.user?.login ?? '',
      },
    };
  }

  if (eventType === 'issue_comment') {
    if (action !== 'created') return { skip: `not-feedback:action=${action}` };
    // issue_comment also fires on plain issues; only a pull request has issue.pull_request.
    if (!payload.issue?.pull_request) return { skip: 'not-feedback:not-a-pull-request' };
    const c = payload.comment;
    const prNumber = payload.issue.number;
    if (typeof c?.id !== 'number' || typeof prNumber !== 'number') return { skip: 'not-feedback:malformed' };
    const who = author(c.user, c.author_association, isBotAuthor);
    if ('skip' in who) return who;
    return {
      item: {
        kind: 'issue_comment_reply',
        feedbackId: `ic-${c.id}`,
        body: c.body ?? '',
        ...who,
        prNumber,
        prAuthor: payload.issue.user?.login ?? '',
      },
    };
  }

  return { skip: `not-feedback:event=${eventType}` };
}

export interface CuratorEnvelope {
  readonly reviewer_id: string;
  readonly feedback_id: string;
  readonly kind: FeedbackKind;
  readonly human_body: string;
  readonly actor: string;
  readonly actor_association: string;
  readonly repo: string;
  readonly pr_number: number;
  readonly pr_author: string;
  /**
   * The App comment the feedback answers. body is the App's comment when
   * the feedback replies in a thread the App started, and empty
   * otherwise; path and line locate the feedback itself.
   */
  readonly bot_comment: { readonly body: string; readonly path: string | null; readonly line: number | null };
  readonly installation_id: number;
}

export function curatorEnvelope(opts: {
  readonly item: FeedbackItem;
  readonly reviewerId: string;
  readonly repo: string;
  readonly installationId: number;
  /** Text of the App comment the feedback replies to, or empty. */
  readonly botCommentBody: string;
}): CuratorEnvelope {
  const { item } = opts;
  return {
    reviewer_id: opts.reviewerId,
    feedback_id: item.feedbackId,
    kind: item.kind,
    human_body: item.body,
    actor: item.actor,
    actor_association: item.actorAssociation,
    repo: opts.repo,
    pr_number: item.prNumber,
    pr_author: item.prAuthor,
    bot_comment: { body: opts.botCommentBody, path: item.path ?? null, line: item.line ?? null },
    installation_id: opts.installationId,
  };
}
