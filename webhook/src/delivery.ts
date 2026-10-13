import { botMatcher, isAppLogin, type ReceiverConfig, type ReviewRoute } from './config.js';
import { curatorEnvelope, extractFeedback } from './feedback.js';
import { fetchReviewComment, type GitHubApi, type WebhookPayload } from './github.js';
import { classifyCommentBody, isAuthorReplyOutsideBotThread } from './heuristics.js';
import { detectMention, handleMention, type Mention, type Verdict } from './mention.js';
import type { ReviewEnvelope } from './review-envelope.js';
import { lowercaseHeaders, rawBody, verifySignature, type ApiGatewayEvent } from './signature.js';
import { releaseQuietly, type DeliveryStore } from './store.js';

/**
 * One webhook delivery, from signature check to queue message.
 *
 *   1. Verify X-Hub-Signature-256 over the raw body. On a mismatch, fetch
 *      the secret again once in case it was rotated.
 *   2. pull_request opened, reopened or ready_for_review on a review route:
 *      route gates, idempotency key repo#pr#head_sha, the route's daily
 *      review budget, then the route's queue. New commits (synchronize)
 *      do not start a review; a maintainer can ask for one with an
 *      @mention.
 *   3. issue_comment, pull_request_review_comment, pull_request_review:
 *      an @mention of the bot is a review request (src/mention.ts).
 *      Everything else, and a thread reply even when it also starts a
 *      re-review, is checked as maintainer feedback and sent to the
 *      curator queue.
 *
 * Status codes: 401 for a bad signature, 400 for a payload this code
 * cannot use, 500 when the work could not be queued. GitHub does not
 * retry failed deliveries; they can be redelivered from the App's
 * advanced settings. When queuing fails, the delivery's idempotency key
 * is released so that a redelivery is processed again.
 */

export interface ApiGatewayResponse {
  readonly statusCode: number;
  readonly body: string;
}

export interface DeliveryDeps {
  /** The webhook secret. refresh=true fetches it again after a mismatch. */
  readonly webhookSecret: (refresh: boolean) => Promise<string>;
  readonly store: DeliveryStore;
  readonly sendMessage: (
    queueUrl: string,
    body: object,
    attributes: Readonly<Record<string, string | number>>,
  ) => Promise<void>;
  /** A GitHub client authenticated as the installation. */
  readonly github: (installationId: number) => Promise<GitHubApi>;
  readonly approveInstruction: (instruction: string) => Promise<Verdict>;
  readonly log?: (line: string) => void;
}

interface Outcome {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

interface Target {
  readonly repo: string;
  readonly installationId: number;
}

const FEEDBACK_EVENTS: ReadonlySet<string> = new Set(['issue_comment', 'pull_request_review_comment', 'pull_request_review']);
const REVIEW_ACTIONS: ReadonlySet<string> = new Set(['opened', 'reopened', 'ready_for_review']);

const skip = (reason: string): Outcome => ({ status: 200, body: { ok: true, skipped: reason } });
const fail = (status: number, error: string): Outcome => ({ status, body: { error } });

/** The decision= value of the delivery log line, which scripts/dump-hour.sh tallies. */
function decisionOf(outcome: Outcome): string {
  const b = outcome.body;
  if (b.skipped) return `skipped:${b.skipped}`;
  if (b.enqueued) return `enqueued:${b.enqueued}`;
  if (b.error) return `err:${b.error}`;
  return b.ok ? 'ok' : 'unknown';
}

/** Log values are single tokens so the key=value line splits on spaces. */
function token(value: unknown): string {
  return value === undefined || value === null || value === '' ? '-' : String(value).replace(/\s+/g, '_');
}

export function createDeliveryHandler(
  config: ReceiverConfig,
  deps: DeliveryDeps,
): (event: ApiGatewayEvent) => Promise<ApiGatewayResponse> {
  const isBotAuthor = botMatcher(config.botLogin, config.knownBotLogins);
  const log = deps.log ?? ((line: string) => console.log(line));
  const release = (key: string): Promise<void> => deps.store.release(key);

  async function signatureMatches(body: Buffer, header: string | undefined): Promise<boolean> {
    if (!header) return false;
    const secret = await deps.webhookSecret(false);
    if (verifySignature(body, header, secret)) return true;
    const fresh = await deps.webhookSecret(true);
    return fresh !== secret && verifySignature(body, header, fresh);
  }

  async function enqueueClaimed(
    key: string,
    queueUrl: string,
    body: object,
    attributes: Readonly<Record<string, string | number>>,
  ): Promise<Outcome> {
    try {
      await deps.sendMessage(queueUrl, body, attributes);
    } catch (err) {
      await releaseQuietly(release, key);
      throw err;
    }
    return { status: 200, body: { ok: true, enqueued: key } };
  }

  async function pullRequest(payload: WebhookPayload, target: Target): Promise<Outcome> {
    const { repo } = target;
    const action = payload.action ?? '';
    // Narrowed further per route below; anything else never reviews.
    if (!REVIEW_ACTIONS.has(action)) return skip(`action=${action}`);

    // Dependency bumps and other automated PRs are not reviewed.
    const pr = payload.pull_request;
    if (isBotAuthor(pr?.user)) return skip(`bot-author=${token(pr?.user?.login)}`);

    const prNumber = pr?.number;
    const headSha = pr?.head?.sha;
    if (typeof prNumber !== 'number' || !headSha) return fail(400, 'missing-pr-fields');

    const route = config.reviewRoutes.get(repo.toLowerCase());
    if (!route) return skip(`unrouted-repo=${repo}`);
    if (route.mentionOnly) return skip(`mention-only-route=${route.routeId}`);

    // skipDrafts routes review a draft when it is marked ready
    // (ready_for_review, which always has draft=false). Other routes
    // review on open, draft or not, and ignore ready_for_review.
    if (route.skipDrafts) {
      if (pr?.draft === true) return skip('draft');
    } else if (action === 'ready_for_review') {
      return skip(`action=${action}`);
    }

    if (route.authorAllowlist.length > 0) {
      const author = (pr?.user?.login ?? '').toLowerCase();
      if (!route.authorAllowlist.includes(author)) return skip(`author-not-allowed=${token(author)}`);
    }

    // A ready_for_review run has its own key and heartbeat nonce: the same
    // head SHA may already have been reviewed while the PR was briefly
    // open as non-draft, and that completed run must not stand in for
    // this one.
    const ready = action === 'ready_for_review';
    const key = `${repo}#${prNumber}#${headSha}${ready ? '#ready' : ''}`;
    if (!(await deps.store.claim(key, { action }))) return skip('duplicate');

    let admitted: boolean;
    try {
      admitted = await deps.store.takeReviewSlot(route.routeId, config.dailyReviewBudget);
    } catch (err) {
      await releaseQuietly(release, key);
      throw err;
    }
    if (!admitted) {
      // Released so a redelivery after the budget resets can still review.
      await releaseQuietly(release, key);
      console.warn(`[budget] route=${route.routeId} daily budget of ${config.dailyReviewBudget} reviews used up; skipped ${repo}#${prNumber}`);
      return skip(`budget-exhausted=${route.routeId}`);
    }

    // A failed send below still uses its budget slot. Failures are rare
    // and the count only has to bound spend.
    const envelope: ReviewEnvelope = {
      repo,
      pr_number: prNumber,
      installation_id: target.installationId,
      head_sha: headSha,
      ...(ready ? { run_nonce: 'ready' } : {}),
    };
    return enqueueClaimed(key, route.queueUrl, envelope, { repo, pr_number: prNumber, action });
  }

  async function mention(m: Mention, route: ReviewRoute, target: Target): Promise<Outcome> {
    return handleMention(m, target, {
      botLogin: config.botLogin,
      github: await deps.github(target.installationId),
      claim: (key) => deps.store.claim(key, { action: 'mention' }),
      release,
      approveInstruction: deps.approveInstruction,
      enqueue: (envelope) => deps.sendMessage(route.queueUrl, envelope, {
        repo: target.repo,
        pr_number: envelope.pr_number,
        action: 'mention',
      }),
    });
  }

  async function feedback(eventType: string, payload: WebhookPayload, target: Target): Promise<Outcome> {
    const { repo } = target;
    if (!config.curatorQueueUrl) return skip('curator-queue-not-wired');
    const extracted = extractFeedback(eventType, payload, isBotAuthor);
    if ('skip' in extracted) return skip(extracted.skip);
    const route = config.curatorRoutes.get(repo.toLowerCase());
    if (!route) return skip(`unrouted-repo=${repo}`);
    const { item } = extracted;

    const noise = classifyCommentBody(item.body);
    if (noise.noise) return skip(`noise:${noise.reason}`);

    // A reply in a review thread: the thread's first comment says whether
    // the App started the thread, and if it did, the curator gets the
    // App's comment next to the reply. If the lookup fails the reply
    // still goes to the curator, without the App's comment.
    let botCommentBody = '';
    if (item.parentCommentId !== undefined) {
      try {
        const api = await deps.github(target.installationId);
        const parent = await fetchReviewComment(api, repo, item.parentCommentId);
        if (parent) {
          const parentIsApp = isAppLogin(parent.author, config.botLogin);
          if (isAuthorReplyOutsideBotThread({ commenterLogin: item.actor, prAuthorLogin: item.prAuthor, parentIsApp })) {
            return skip('noise:author-reply-to-non-bot');
          }
          if (parentIsApp) botCommentBody = parent.body;
        }
      } catch (err) {
        console.warn(`[feedback] could not read comment ${item.parentCommentId} on ${repo}; forwarding without it`, err);
      }
    }

    const key = `curator#${item.feedbackId}`;
    if (!(await deps.store.claim(key, { eventType }))) return skip('duplicate-feedback');
    const envelope = curatorEnvelope({
      item,
      reviewerId: route.reviewerId,
      repo,
      installationId: target.installationId,
      botCommentBody,
    });
    return enqueueClaimed(key, config.curatorQueueUrl, envelope, {
      repo,
      reviewer_id: route.reviewerId,
      feedback_id: item.feedbackId,
      kind: item.kind,
    });
  }

  async function dispatch(eventType: string, payload: WebhookPayload): Promise<Outcome> {
    if (eventType === 'ping') return { status: 200, body: { ok: true, ping: true } };
    if (eventType !== 'pull_request' && !FEEDBACK_EVENTS.has(eventType)) return skip(`event=${token(eventType)}`);

    const repo = payload.repository?.full_name;
    if (!repo) return fail(400, 'missing-repository');
    const installationId = payload.installation?.id ?? config.installationId;
    if (typeof installationId !== 'number') return fail(400, 'missing-installation');
    const target = { repo, installationId };

    if (eventType === 'pull_request') return pullRequest(payload, target);

    // A summons is a command, not feedback: it ends here. A thread reply
    // may start a re-review and then still goes to the curator.
    const m = detectMention(eventType, payload, { botLogin: config.botLogin, isBotAuthor });
    if (m) {
      const route = config.reviewRoutes.get(repo.toLowerCase());
      if (m.kind === 'summon') return route ? mention(m, route, target) : skip(`mention:unrouted-repo=${repo}`);
      if (route?.threadReplyReview) {
        const outcome = await mention(m, route, target);
        if (outcome.status >= 500) return outcome;
        log(`[mention] repo=${repo} pr=${m.prNumber} decision=${decisionOf(outcome)}`);
      }
    }
    return feedback(eventType, payload, target);
  }

  return async (event) => {
    const headers = lowercaseHeaders(event);
    const body = rawBody(event);
    // Fields from the payload are logged only once the signature checks out.
    let fields: string | undefined;
    let outcome: Outcome;
    try {
      if (!(await signatureMatches(body, headers['x-hub-signature-256']))) {
        outcome = fail(401, 'bad-signature');
      } else {
        const eventType = headers['x-github-event'] ?? '';
        let payload: WebhookPayload | undefined;
        try {
          const parsed: unknown = JSON.parse(body.toString('utf8'));
          if (typeof parsed === 'object' && parsed !== null) payload = parsed as WebhookPayload;
        } catch {
          // Reported as bad-json below.
        }
        fields = [
          `event=${token(eventType)}`,
          `action=${token(payload?.action)}`,
          `repo=${token(payload?.repository?.full_name)}`,
          `actor=${token(payload?.sender?.login)}`,
        ].join(' ');
        outcome = payload ? await dispatch(eventType, payload) : fail(400, 'bad-json');
      }
    } catch (err) {
      console.error('[receiver] delivery failed', err);
      outcome = fail(500, 'internal');
    }
    log(`[delivery] ${fields ? `${fields} ` : ''}status=${outcome.status} decision=${token(decisionOf(outcome))}`);
    return { statusCode: outcome.status, body: JSON.stringify(outcome.body) };
  };
}
