/**
 * Regex filters that keep obvious noise away from the curator:
 * acknowledgements, emoji, bare links, test pings, quotes with no reply.
 * They run on every feedback delivery before any network call, so they
 * stay cheap and lean toward keeping a comment. The curator makes the
 * real decision on everything that passes.
 */

const ACK_RE =
  /^\s*(lgtm|\+1|:\+1:|thanks?|thx|ty|done|ack|ok|ok!|agreed?|sgtm|sounds good|will do|fixed|updated?|got it|noted|right|yes|yep|yup|sure|np|makes sense|good(?: (?:point|call|catch))?|nice|\u{1F44D}+)[\s!.,]*$/iu;

const DITTO_RE =
  /^\s*(same|ditto|here too|same here|same as above|as above|same comment|similar|\+same)[\s.!]*$/i;

// Emoji and whitespace only: reactions typed as a comment.
const EMOJI_ONLY_RE =
  /^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\s]+$/u;

const URL_ONLY_RE = /^\s*https?:\/\/\S+\s*$/;

// A test or "ignore this" marker, dropped only when little else is said:
// "please ignore, testing" goes, "nvm, the lock is held by the caller"
// stays.
const TEST_MARKER_PHRASE_RE =
  /\b(please ignore|pls ignore|please disregard|just testing|just a test|test message|test delivery|disregard this|nvm|never ?mind|wip+)\b/i;
const MAX_WORDS_BESIDE_TEST_MARKER = 3;
const TERSE_TEST_MARKER_RE =
  /^\s*(test(ing)?|wip|work in progress|ping|pinging)[\s.!:,\u2014-]*$/i;

export type NoiseReason =
  | 'ack'
  | 'ditto'
  | 'emoji-only'
  | 'url-only'
  | 'mention-short'
  | 'quote-heavy'
  | 'test-marker'
  | 'too-short';

export interface HeuristicResult {
  readonly noise: boolean;
  readonly reason?: NoiseReason;
}

/**
 * The comment's own prose: fenced code blocks (``` or ~~~, closed or
 * not), inline code and quoted lines removed.
 */
export function stripQuotesAndCode(body: string): string {
  return body
    .replace(/(```|~~~)[\s\S]*?(\1|$)/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .split('\n')
    .filter((line) => !line.trim().startsWith('>'))
    .join('\n')
    .trim();
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

function isQuoteHeavy(body: string, prose: string): boolean {
  const nonEmpty = body.split('\n').filter((l) => l.trim().length > 0);
  if (nonEmpty.length < 2) return false;
  const quoted = nonEmpty.filter((l) => l.trim().startsWith('>')).length;
  return quoted / nonEmpty.length > 0.7 && wordCount(prose) <= 5;
}

function isTestMarker(body: string, prose: string): boolean {
  if (TERSE_TEST_MARKER_RE.test(body)) return true;
  return TEST_MARKER_PHRASE_RE.test(prose)
    && wordCount(prose.replace(TEST_MARKER_PHRASE_RE, ' ')) <= MAX_WORDS_BESIDE_TEST_MARKER;
}

/**
 * Classifies a comment body. Returns { noise: true, reason } for the
 * first rule that matches, { noise: false } when the comment survives.
 *
 * Short comments are kept when they ask a question (a "?" in the prose)
 * or carry a ```suggestion block; both checks run before the
 * quote-heavy, short-mention and length rules.
 */
export function classifyCommentBody(body: string): HeuristicResult {
  const b = (body ?? '').trim();
  if (!b) return { noise: true, reason: 'too-short' };

  if (ACK_RE.test(b)) return { noise: true, reason: 'ack' };
  if (DITTO_RE.test(b)) return { noise: true, reason: 'ditto' };
  if (EMOJI_ONLY_RE.test(b)) return { noise: true, reason: 'emoji-only' };
  if (URL_ONLY_RE.test(b)) return { noise: true, reason: 'url-only' };

  const prose = stripQuotesAndCode(b);
  if (isTestMarker(b, prose)) return { noise: true, reason: 'test-marker' };

  if (b.includes('```suggestion') || prose.includes('?')) return { noise: false };

  if (isQuoteHeavy(b, prose)) return { noise: true, reason: 'quote-heavy' };

  // "@someone PTAL" and similar pings.
  if (/^@\w/.test(b) && wordCount(b) <= 6) return { noise: true, reason: 'mention-short' };

  if (wordCount(prose) < 4) return { noise: true, reason: 'too-short' };

  return { noise: false };
}

/**
 * True when the PR author replies in a review thread this App did not
 * start. Exchanges between the author and other reviewers ("done", "good
 * point, will do") teach the curator nothing about the bot's reviews.
 * Replies to the App's own comments are kept: they confirm or dispute a
 * finding.
 */
export function isAuthorReplyOutsideBotThread(ctx: {
  readonly commenterLogin: string;
  readonly prAuthorLogin: string;
  readonly parentIsApp: boolean;
}): boolean {
  if (!ctx.commenterLogin || !ctx.prAuthorLogin) return false;
  if (ctx.commenterLogin.toLowerCase() !== ctx.prAuthorLogin.toLowerCase()) return false;
  return !ctx.parentIsApp;
}
