/**
 * Text in the curator's log stream that the curator did not write
 * itself: what a model wrote (its replies and reasoning, an audit's
 * summary, a feedback run's summary, the ids it passed to tools), and
 * strings from a table or a request. A model's text can be steered by
 * what it read, upstream code or a maintainer's comment, so it never
 * reaches the log raw. It goes in as one JSON string without the
 * characters a log line never shows, so it can neither start a line of
 * its own nor pass for a "[maintenance]" report line.
 */

/** Characters a log line never shows, as in ops/src/decay.ts. */
const INVISIBLE_RE = /[\p{Cf}\p{Zl}\p{Zp}\u007f-\u009f]/gu;

/** `value` as a JSON string, without INVISIBLE_RE characters; JSON escapes the C0 controls, newlines included. */
export function quoted(value: string): string {
  return JSON.stringify(value.replace(INVISIBLE_RE, ''));
}
