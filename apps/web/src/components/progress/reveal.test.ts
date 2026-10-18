import { describe, expect, it } from 'vitest';

import { keptPrefix, REVEAL, revealCount, revealCut, revealDeadline, settledText } from './reveal';

/** Plays arrivals through 60 fps frames; returns what was on screen at each frame. */
function play(
  arrivals: Array<{ at: number; text: string }>,
  options: { completeAt?: number; until: number },
) {
  const frames: Array<{ at: number; shown: number; target: number }> = [];
  let shown = 0;
  let text = '';
  let arrivedAt = 0;
  let next = 0;
  for (let at = 0; at <= options.until; at += 1_000 / 60) {
    while (next < arrivals.length && arrivals[next]!.at <= at) {
      text = arrivals[next]!.text;
      arrivedAt = arrivals[next]!.at;
      next += 1;
    }
    const completeAt =
      options.completeAt !== undefined && at >= options.completeAt ? options.completeAt : null;
    const remainingMs = revealDeadline(arrivedAt, completeAt) - at;
    shown = revealCount({ shown, target: text.length, elapsedMs: 1_000 / 60, remainingMs });
    frames.push({ at, shown: revealCut(text, shown), target: text.length });
  }
  return frames;
}

/** A 95-word answer arriving as the live model sent one: 7 pieces in under 0.6 s. */
const answer = Array.from({ length: 95 }, (_, i) => `word${i}`).join(' ');
const bursts = [0, 90, 170, 260, 350, 440, 580].map((at, i, all) => ({
  at,
  text: answer.slice(0, Math.round((answer.length * (i + 1)) / all.length)),
}));

describe('revealing streamed text', () => {
  it('starts on the first frame after text arrives', () => {
    const frames = play(bursts, { until: 100 });
    const first = frames.find((f) => f.target > 0)!;
    expect(first.shown).toBeGreaterThan(0);
  });

  it('shows everything that arrived within the catch-up time, so the wait stays bounded', () => {
    const frames = play(bursts, { until: 3_000 });
    const lastArrival = bursts.at(-1)!.at;
    const allShown = frames.find((f) => f.shown === answer.length)!;
    expect(allShown.at).toBeLessThanOrEqual(lastArrival + REVEAL.catchUpMs + 20);
    // ...and doesn't simply wait for the deadline: it spreads the text out over the time.
    expect(allShown.at).toBeGreaterThan(lastArrival + 300);
  });

  it('turns large pieces into small steady steps', () => {
    const frames = play(bursts, { until: 3_000 });
    const steps = frames.slice(1).map((f, i) => f.shown - frames[i]!.shown);
    const largestPiece = Math.max(
      ...bursts.map((b, i) => b.text.length - (bursts[i - 1]?.text.length ?? 0)),
    );
    // On arrival the whole piece would jump in at once; revealed, no frame adds more than a few words.
    expect(Math.max(...steps)).toBeLessThan(largestPiece / 3);
    expect(steps.every((s) => s >= 0)).toBe(true);
  });

  it('finishes quickly once the whole answer is in', () => {
    const frames = play(bursts, { until: 3_000, completeAt: 600 });
    const allShown = frames.find((f) => f.shown === answer.length)!;
    expect(allShown.at).toBeLessThanOrEqual(600 + REVEAL.finishMs + 20);
  });

  it('keeps a short answer brisk rather than typed out slowly', () => {
    const short = 'She is a curator at the Metropolitan Museum of Art.';
    const frames = play([{ at: 0, text: short }], { until: 2_000 });
    const allShown = frames.find((f) => f.shown === short.length)!;
    expect(allShown.at).toBeLessThanOrEqual((short.length / REVEAL.minCharsPerSecond) * 1_000 + 40);
  });
});

describe('where to cut', () => {
  it('ends on a whole word', () => {
    const text = 'The Rockefeller Wing reopened in May.';
    expect(text.slice(0, revealCut(text, 6))).toBe('The Rockefeller');
    expect(revealCut(text, 100)).toBe(text.length);
    expect(revealCut(text, 0)).toBe(0);
  });

  it('reveals a very long word in parts, and never splits a character pair', () => {
    const link = `See ${'x'.repeat(60)} for details.`;
    expect(revealCut(link, 10)).toBe(10);
    const emoji = 'Art 🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨';
    for (let count = 1; count < emoji.length; count += 1) {
      const cut = revealCut(emoji, count);
      const last = emoji.charCodeAt(cut - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  it('holds back a word still arriving until it is complete or the text ends', () => {
    expect(settledText('For Omenai’s r', false)).toBe('For Omenai’s');
    expect(settledText('For Omenai’s readers ', false)).toBe('For Omenai’s readers');
    expect(settledText('For Omenai’s r', true)).toBe('For Omenai’s r');
    expect(settledText('Omenai', false)).toBe('Omenai');
  });

  it('keeps what still agrees when the text changes behind what is shown', () => {
    expect(keptPrefix('The museum [S', 'The museum reopened')).toBe('The museum '.length);
    expect(keptPrefix('The museum', 'The museum reopened')).toBe('The museum'.length);
  });
});
