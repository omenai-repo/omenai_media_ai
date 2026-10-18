/**
 * Reads a JSON value from the beginning of a streamed answer: any prefix of a JSON document is
 * closed off at its last safe point and parsed, so the text of a string still being written can
 * be shown as it arrives. Provider-neutral: it relies only on the text being a prefix of valid
 * JSON, not on any provider's key order or chunking.
 *
 * What it returns is a preview, never the answer: the complete text is always parsed and
 * validated against its schema separately. Returns undefined when nothing can be read yet.
 */

type Frame =
  | { kind: 'object'; state: 'key' | 'colon' | 'value' | 'comma' }
  | { kind: 'array'; state: 'value' | 'comma' };

const LITERAL_CHAR = /[-+0-9.eEtrufalsn]/;
const HEX = /[0-9a-fA-F]/;

export function parsePartialJson(input: string): unknown {
  // A model may wrap JSON in a Markdown fence despite instructions; the preview ignores it.
  const text = input.replace(/^\s*```(?:json)?\s*/i, '');
  const stack: Frame[] = [];
  let inString = false;
  let stringIsKey = false;
  /** Opening quote of the key being read, so an unfinished key can be dropped. */
  let keyStart = -1;
  /** Inside a string: a backslash was just read. */
  let escaped = false;
  /** Inside a \uXXXX escape: hex digits still expected. */
  let unicodeLeft = 0;
  /** End index of the last \uXXXX escape when it was the first half of a surrogate pair. */
  let highSurrogateEnd = -1;
  /** Start of a number or true/false/null still being read. */
  let literalStart = -1;

  const top = () => stack.at(-1);
  const valueDone = () => {
    const frame = top();
    if (frame) frame.state = 'comma';
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (unicodeLeft > 0) {
        if (!HEX.test(ch)) return undefined;
        unicodeLeft -= 1;
        if (unicodeLeft === 0) {
          const code = parseInt(text.slice(i - 3, i + 1), 16);
          highSurrogateEnd = code >= 0xd800 && code <= 0xdbff ? i : -1;
        }
      } else if (escaped) {
        escaped = false;
        if (ch === 'u') unicodeLeft = 4;
      } else if (ch === '\\') escaped = true;
      else if (ch === '"') {
        inString = false;
        if (stringIsKey) {
          const frame = top();
          if (frame?.kind === 'object') frame.state = 'colon';
        } else valueDone();
      }
      continue;
    }
    if (literalStart >= 0) {
      if (LITERAL_CHAR.test(ch)) continue;
      literalStart = -1;
      valueDone();
    }
    if (/\s/.test(ch)) continue;
    const frame = top();
    switch (ch) {
      case '{':
        stack.push({ kind: 'object', state: 'key' });
        break;
      case '[':
        stack.push({ kind: 'array', state: 'value' });
        break;
      case '}':
      case ']':
        stack.pop();
        valueDone();
        break;
      case '"':
        inString = true;
        stringIsKey = frame?.kind === 'object' && frame.state === 'key';
        if (stringIsKey) keyStart = i;
        highSurrogateEnd = -1;
        break;
      case ':':
        if (frame?.kind === 'object') frame.state = 'value';
        break;
      case ',':
        if (frame) frame.state = frame.kind === 'object' ? 'key' : 'value';
        break;
      default:
        if (!LITERAL_CHAR.test(ch)) return undefined;
        literalStart = i;
    }
  }

  // Close off what is still open, at the last point that can form valid JSON.
  let cut = text;
  if (inString && stringIsKey) {
    // An unfinished key can't be shown: drop it.
    cut = text.slice(0, keyStart);
    const frame = top();
    if (frame?.kind === 'object') frame.state = 'key';
  } else if (inString) {
    // Drop an unfinished escape ("\", "\u00") or the first half of a surrogate pair.
    let end = text.length;
    if (escaped) end -= 1;
    else if (unicodeLeft > 0) end -= 2 + (4 - unicodeLeft);
    else if (highSurrogateEnd === text.length - 1) end -= 6;
    cut = text.slice(0, end) + '"';
    valueDone();
  } else if (literalStart >= 0) {
    // "12" may become "125" and "tr" can't stand alone: drop a literal still being read.
    cut = text.slice(0, literalStart);
    const frame = top();
    if (frame) frame.state = 'value';
  }

  const frame = top();
  if (frame?.kind === 'object' && (frame.state === 'colon' || frame.state === 'value')) {
    // A key with no value yet: drop the key and its colon.
    cut = cut.replace(/"(?:[^"\\]|\\.)*"\s*:?\s*$/, '');
  }
  cut = cut.replace(/,\s*$/, '');

  const closing = [...stack]
    .reverse()
    .map((f) => (f.kind === 'object' ? '}' : ']'))
    .join('');
  if (!cut.trim()) return undefined;
  try {
    return JSON.parse(cut + closing) as unknown;
  } catch {
    return undefined;
  }
}
