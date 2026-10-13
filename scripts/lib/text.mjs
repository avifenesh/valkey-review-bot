// Text for the operator's terminal. Every value the scripts print that a
// table, the registry, an upstream repository or a model chose goes
// through one of these, so it cannot move the cursor, clear the screen,
// hide text, reorder how a line reads or start a line of its own.

/**
 * Control characters (C0, DEL and C1, so ESC and CSI among them), Unicode
 * format characters (zero-width characters, bidi marks, embeddings,
 * overrides and isolates, the BOM, the soft hyphen, tag characters) and
 * the line and paragraph separators.
 */
const UNSAFE_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * `value` as plain text for one line: line breaks and tabs become spaces
 * and every other UNSAFE_RE character becomes '?', so the operator sees
 * that something was there. With `multiline`, newlines and tabs are kept.
 */
export function printable(value, { multiline = false } = {}) {
  let text = String(value).replace(/\r\n/g, '\n');
  if (!multiline) text = text.replace(/[\n\t]/g, ' ');
  return text.replace(UNSAFE_RE, (c) => (c === '\n' || c === '\t' ? c : '?'));
}

/**
 * JSON.stringify(value, null, space) with every character outside ASCII,
 * and DEL, written as a \u escape: the same data, and nothing in it can
 * act on a terminal.
 */
export function asciiJson(value, space) {
  return JSON.stringify(value, null, space).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * A value for one output line, JSON-quoted with non-ASCII escaped too, so
 * it can neither break the line nor reorder how the terminal shows it, and
 * stays exact.
 */
export const quoted = (value) => asciiJson(String(value));
