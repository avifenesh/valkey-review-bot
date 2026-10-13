import { botMatcher, isAppLogin, type ReceiverConfig, type ReviewRoute } from './config.js';
import { curatorEnvelope, extractFeedback } from './feedback.js';
import { fetchReviewComment, type GitHubApi, type WebhookPayload } from './github.js';
import { classifyCommentBody, isAuthorReplyOutsideBotThread } from './heuristics.js';
import { detectMention, handleMention, type Mention, type Verdict } from './mention.js';
import type { AutomaticTrigger, ReviewEnvelope } from './review-envelope.js';
import { lowercaseHeaders, rawBody, verifySignature, type ApiGatewayEvent } from './signature.js';
import { releaseQuietly, type DeliveryStore } from './store.js';

/**
 * One webhook delivery, from signature check to queue message.
 *
 *   1. Verify X-Hub-Signature-256 over the raw body. On a mismatch, fetch
 *      the secret again once in case it was rotated.
 *   2. pull_request opened, reopened, ready_for_review or synchronize (new
 *      commits) on a review route: route gates, idempotency key
 *      repo#pr#head_sha (#ready or #push appended for ready_for_review
 *      and new commits), the pull request's pending marker, the pull
 *      request's cap on automatic reviews, the route's daily review
 *      budget, then the route's queue. The review holds the marker until
 *      its run starts and covers every push, reopen or ready_for_review
 *      that comes before then. A review of new commits first waits in
 *      the queue for pushReviewDelaySeconds.
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
 * is released, and an automatic review gives back its round and pending
 * marker, so that a redelivery is processed again.
 */

export interface ApiGatewayResponse {
  readonly statusCode: number;
  readonly body: string;
}

export interface SendOptions {
  /** SQS per-message delay, at most 900 seconds. */
  readonly delaySeconds?: number;
}

export interface DeliveryDeps {
  /** The webhook secret. refresh=true fetches it again after a mismatch. */
  readonly webhookSecret: (refresh: boolean) => Promise<string>;
  readonly store: DeliveryStore;
  readonly sendMessage: (
    queueUrl: string,
    body: object,
    attributes: Readonly<Record<string, string | number>>,
    options?: SendOptions,
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
/** The pull_request actions that start an automatic review, and the trigger each sends. */
const REVIEW_TRIGGERS: ReadonlyMap<string, AutomaticTrigger> = new Map([
  ['opened', 'opened'],
  ['reopened', 'reopened'],
  ['ready_for_review', 'ready_for_review'],
  ['synchronize', 'push'],
]);

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

  async function returnAutoReviewQuietly(repo: string, prNumber: number): Promise<void> {
    try {
      await deps.store.returnAutoReview(repo, prNumber);
    } catch (err) {
      console.error(`[store] could not give back an automatic review of ${repo}#${prNumber}; the pull request has one fewer`, err);
    }
  }

  async function clearPendingQuietly(repo: string, prNumber: number, marker: string): Promise<void> {
    try {
      await deps.store.clearReviewPending(repo, prNumber, marker);
    } catch (err) {
      console.error(`[store] could not clear the pending marker of ${repo}#${prNumber}; automatic reviews are skipped until it expires`, err);
    }
  }

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
    const trigger = REVIEW_TRIGGERS.get(action);
    if (!trigger) return skip(`action=${action}`);

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
    // (ready_for_review, which always has draft=false), and skip new
    // commits on a draft. Other routes review on open and on new commits,
    // draft or not, and ignore ready_for_review.
    if (route.skipDrafts) {
      if (pr?.draft === true) return skip('draft');
    } else if (action === 'ready_for_review') {
      return skip(`action=${action}`);
    }

    if (route.authorAllowlist.length > 0) {
      const author = (pr?.user?.login ?? '').toLowerCase();
      if (!route.authorAllowlist.includes(author)) return skip(`author-not-allowed=${token(author)}`);
    }

    // ready_for_review and new commits have their own key and heartbeat
    // nonce. A draft's head may already have been reviewed while the PR
    // was briefly open as non-draft, and that completed run must not
    // stand in for the review it gets when marked ready. A review of new
    // commits is skipped, and recorded completed, when the PR is closed
    // by the time it runs; a reopen at that head must not then be dropped
    // as its duplicate, or its run be taken for done by the worker. The
    // cost: a reopen at a head that a review of new commits did cover is
    // reviewed again, using a round.
    const ready = trigger === 'ready_for_review';
    const pushed = trigger === 'push';
    const nonce = ready ? 'ready' : pushed ? 'push' : undefined;
    const key = `${repo}#${prNumber}#${headSha}${nonce ? `#${nonce}` : ''}`;
    if (!(await deps.store.claim(key, { action }))) return skip('duplicate');

    // What this review has taken so far, given back newest first when it
    // is not queued, so a redelivery can try again. Each step logs its
    // own failure instead of throwing.
    const taken: (() => Promise<void>)[] = [() => releaseQuietly(release, key)];
    const giveBack = async (): Promise<void> => {
      for (let undo = taken.pop(); undo; undo = taken.pop()) await undo();
    };

    // A skipped delivery relies on the marker's owner, the waiting review,
    // to cover its head. The owner takes the marker before its cap and
    // budget checks and gives it back when it does not queue (a store
    // error or a failed send, as well as the cap and the budget). So the
    // skipped delivery's key is released, and a redelivery of it is
    // processed instead of being dropped as a duplicate. What remains:
    // GitHub does not redeliver on its own, so in that case this head is
    // reviewed only after a manual redelivery or the next push, as it is
    // when the worker drops the waiting review (still waiting for another
    // review past its run budget); and a redelivery that comes after the
    // waiting review has started queues another review of this head.
    const joinWaitingReview = async (): Promise<Outcome> => {
      await giveBack();
      log(`[auto-review] route=${route.routeId} repo=${repo} pr=${prNumber} head=${headSha} joins the waiting review; skipped`);
      return skip('auto-review-pending');
    };

    try {
      // Every automatic review holds the pull request's pending marker
      // from here until the worker starts its run, so at most one waits
      // at a time. A push, reopen or ready_for_review that comes while one
      // waits joins it instead of using a round: the runtime reviews the
      // head as it is when the run starts. A review of new commits also
      // waits in the queue first, so that a burst of pushes gets one
      // review. An event after the waiting review has started queues the
      // next review.
      //
      // A marker can outlive its review. Until it expires, an hour after
      // its delay, every automatic review of the pull request then joins
      // a review that is not waiting any more. That happens when:
      //   - the review worker lacks IDEMPOTENCY_TABLE, or GetItem on that
      //     table: the review runs and leaves its marker;
      //   - the worker lacks DeleteItem on it: the review never runs, and
      //     dead-letters;
      //   - this function stops (a timeout) after taking the marker and
      //     before the send, or before giving the marker back;
      //   - the worker hits a store error while it lets go of the marker
      //     of a review it drops, which it logs.
      // A worker without UpdateItem on that table only lets a waiting
      // review's marker expire. infra/lib/webhook-stack.ts must give each
      // review worker IDEMPOTENCY_TABLE and all three grants on it.
      const marker = await deps.store.markReviewPending(repo, prNumber, pushed ? config.pushReviewDelaySeconds : 0);
      if (marker === null) return await joinWaitingReview();
      taken.push(() => clearPendingQuietly(repo, prNumber, marker));

      const cap = config.maxAutomaticReviewsPerPr;
      const round = await deps.store.takeAutoReview(repo, prNumber, cap);
      if (round === 0) {
        await giveBack();
        log(`[auto-review] route=${route.routeId} repo=${repo} pr=${prNumber} cap=${cap} reached; skipped`);
        return skip('auto-review-cap');
      }
      taken.push(() => returnAutoReviewQuietly(repo, prNumber));

      if (!(await deps.store.takeReviewSlot(route.routeId, config.dailyReviewBudget))) {
        // Given back so a redelivery after the budget resets can still review.
        await giveBack();
        console.warn(`[budget] route=${route.routeId} daily budget of ${config.dailyReviewBudget} reviews used up; skipped ${repo}#${prNumber}`);
        return skip(`budget-exhausted=${route.routeId}`);
      }

      // A failed send below still uses its budget slot. Failures are rare
      // and the count only has to bound spend. A send that errors after
      // SQS accepted the message (a timeout, say) gives back the round and
      // the marker of a review that will still run: the pull request can
      // then get one automatic review more than the cap, and the worker,
      // finding no marker, runs that review like any other.
      //
      // trigger and skip_drafts let the runtime skip the run if the pull
      // request is closed, or a draft on this route, by the time it starts.
      const envelope: ReviewEnvelope = {
        repo,
        pr_number: prNumber,
        installation_id: target.installationId,
        head_sha: headSha,
        ...(nonce ? { run_nonce: nonce } : {}),
        pending_marker: marker,
        trigger,
        skip_drafts: route.skipDrafts,
      };
      const delay = pushed ? { delaySeconds: config.pushReviewDelaySeconds } : undefined;
      await deps.sendMessage(route.queueUrl, envelope, { repo, pr_number: prNumber, action }, delay);
      log(`[auto-review] route=${route.routeId} repo=${repo} pr=${prNumber} round=${round}/${cap} queued${delay ? ` delay=${delay.delaySeconds}s` : ''}`);
    } catch (err) {
      await giveBack();
      throw err;
    }
    return { status: 200, body: { ok: true, enqueued: key } };
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
