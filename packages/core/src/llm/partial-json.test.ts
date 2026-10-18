import { describe, expect, it } from 'vitest';

import { parsePartialJson } from './partial-json.js';

interface Answer {
  scope?: string;
  statements?: Array<{ type?: string; text?: string; sources?: string[]; excerpt?: string }>;
}

const plain = JSON.stringify({
  scope: 'editorial',
  statements: [
    {
      type: 'analysis',
      text: 'Partly: it’s an institutional story, “the Met’s” wing \\ reopened in 2025.',
      sources: [],
      excerpt: '',
    },
    {
      type: 'fact',
      text: 'Café 🎨 with a tab\tand a line\nbreak, and "quotes".',
      sources: ['S1', 'S2'],
      excerpt: 'A curator at the Metropolitan since 1996',
    },
  ],
  evidence: 'partial',
  score: 12.5,
  ok: true,
  none: null,
  suggestedFocus: '',
});

// Escapes as a model may send them: \u escapes, a surrogate pair, an escaped backslash at the end.
const escaped =
  '{"scope":"related","statements":[{"type":"fact","text":"Caf\\u00e9 \\ud83c\\udfa8 back\\\\slash \\"q\\" ends\\\\","sources":["S1"],"excerpt":"x"}],"evidence":"sufficient","suggestedFocus":""}';

function checkEveryPrefix(json: string) {
  const final = JSON.parse(json) as Answer;
  let shown = 0;
  for (let n = 0; n <= json.length; n += 1) {
    const prefix = json.slice(0, n);
    let partial: Answer | undefined;
    expect(() => {
      partial = parsePartialJson(prefix) as Answer | undefined;
    }, prefix).not.toThrow();
    if (!partial) continue;
    const statements = partial.statements ?? [];
    // Never more statements than the answer has, and never fewer than already shown.
    expect(statements.length, prefix).toBeLessThanOrEqual(final.statements!.length);
    expect(statements.length, prefix).toBeGreaterThanOrEqual(shown - 1);
    shown = Math.max(shown, statements.length);
    statements.forEach((statement, i) => {
      if (typeof statement.text === 'string')
        expect(final.statements![i]!.text!.startsWith(statement.text), prefix).toBe(true);
    });
    if (typeof partial.scope === 'string')
      expect(final.scope!.startsWith(partial.scope), prefix).toBe(true);
  }
  expect(parsePartialJson(json)).toEqual(final);
}

describe('parsePartialJson', () => {
  it('reads every prefix of an answer without throwing, and only ever shows true prefixes', () => {
    checkEveryPrefix(plain);
    checkEveryPrefix(escaped);
  });

  it('shows the text of a statement while it is still being written', () => {
    const prefix = '{"scope":"about_story","statements":[{"type":"fact","text":"The wing reop';
    expect(parsePartialJson(prefix)).toEqual({
      scope: 'about_story',
      statements: [{ type: 'fact', text: 'The wing reop' }],
    });
  });

  it('drops an unfinished key, an unfinished literal and a dangling separator', () => {
    expect(parsePartialJson('{"scope":"editorial","stat')).toEqual({ scope: 'editorial' });
    expect(parsePartialJson('{"scope":"editorial","score":1')).toEqual({ scope: 'editorial' });
    expect(parsePartialJson('{"a":[1,')).toEqual({ a: [1] });
    expect(parsePartialJson('{"a":')).toEqual({});
  });

  it('never ends a preview inside an escape', () => {
    expect(parsePartialJson('{"t":"a\\')).toEqual({ t: 'a' });
    expect(parsePartialJson('{"t":"a\\u00')).toEqual({ t: 'a' });
    expect(parsePartialJson('{"t":"a\\ud83c')).toEqual({ t: 'a' });
    expect(parsePartialJson('{"t":"a\\\\')).toEqual({ t: 'a\\' });
  });

  it('ignores a Markdown fence and gives up on text that is not JSON', () => {
    expect(parsePartialJson('```json\n{"scope":"related"')).toEqual({ scope: 'related' });
    expect(parsePartialJson('Sorry, I can’t help')).toBeUndefined();
    expect(parsePartialJson('')).toBeUndefined();
  });
});
