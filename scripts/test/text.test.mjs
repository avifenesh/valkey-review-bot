import assert from 'node:assert/strict';
import test from 'node:test';
import { asciiJson, printable, quoted } from '../lib/text.mjs';

// One of each kind: C0 (ESC, BEL, CR), DEL, C1 (NEL, CSI), zero-width and
// bidi characters, the BOM, the soft hyphen, a tag character, and the
// line and paragraph separators.
const UNSAFE = ['\u001b', '\u0007', '\r', '\u007f', '\u0085', '\u009b', '\u200b', '\u200d', '\u200e', '\u202e', '\u2066', '\u2069',
  '\ufeff', '\u00ad', '\u{e0041}', '\u2028', '\u2029', '\u061c'];
const UNSAFE_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

test('printable shows each control, escape or format character as ?', () => {
  for (const c of UNSAFE) assert.equal(printable(`a${c}b`), 'a?b', `U+${c.codePointAt(0).toString(16)}`);
  assert.equal(printable('\u001b[2Jclear'), '?[2Jclear');
  assert.equal(printable('src/\u202eko'), 'src/?ko');
  assert.equal(printable('caf\u00e9 \u{1f600}'), 'caf\u00e9 \u{1f600}', 'other text is unchanged');
  assert.equal(printable(42), '42');
});

test('printable keeps a value on one line unless asked for several', () => {
  assert.equal(printable('one\ntwo\r\nthree\tfour'), 'one two three four');
  assert.equal(printable('one\ntwo\r\nthree\tfour\u001b', { multiline: true }), 'one\ntwo\nthree\tfour?');
  assert.equal(printable('a\rb', { multiline: true }), 'a?b');
});

test('asciiJson and quoted are exact and plain ASCII', () => {
  const value = { text: `x${UNSAFE.join('')}\ny\u00e9\u{1f600}'`, n: 1 };
  for (const json of [asciiJson(value), asciiJson(value, 2)]) {
    assert.match(json, /^[\n\x20-\x7e]*$/);
    assert.deepEqual(JSON.parse(json), value);
  }
  const q = quoted(`a"\n${UNSAFE.join('')}`);
  assert.match(q, /^"[\x20-\x7e]*"$/);
  assert.ok(!UNSAFE_RE.test(q));
  assert.equal(JSON.parse(q), `a"\n${UNSAFE.join('')}`);
});
