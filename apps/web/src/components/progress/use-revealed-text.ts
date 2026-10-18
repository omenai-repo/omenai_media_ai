'use client';

import { useEffect, useRef, useState } from 'react';

import { usePrefersReducedMotion } from '@/lib/motion';

import { keptPrefix, revealCount, revealCut, revealDeadline, settledText } from './reveal';

/**
 * Streamed text, revealed at a steady pace (see `reveal.ts`). Text already there when the
 * component appears is shown at once, so a page opened partway doesn't replay it; only text that
 * arrives afterwards is revealed. With reduced motion, text is shown exactly as it arrives.
 *
 * `complete`: the whole text has arrived, so what's left is shown within `REVEAL.finishMs`.
 */
export function useRevealedText(
  received: string,
  complete = false,
): { shown: string; caughtUp: boolean } {
  const text = settledText(received, complete);
  const reduced = usePrefersReducedMotion();
  const [count, setCount] = useState(text.length);
  const live = useRef({
    text,
    count: text.length,
    arrivedAt: 0,
    completeAt: null as number | null,
  });

  // New text: keep what still agrees with what's shown, and restart the catch-up clock.
  useEffect(() => {
    const s = live.current;
    if (text === s.text) return;
    s.count = Math.min(s.count, keptPrefix(s.text, text));
    s.text = text;
    s.arrivedAt = performance.now();
  }, [text]);

  useEffect(() => {
    if (complete) live.current.completeAt ??= performance.now();
  }, [complete]);

  // One loop while the text is on screen: each frame moves the cut a little further.
  useEffect(() => {
    if (reduced) return;
    let last = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const s = live.current;
      s.count = revealCount({
        shown: s.count,
        target: s.text.length,
        elapsedMs: now - last,
        remainingMs: revealDeadline(s.arrivedAt, s.completeAt) - now,
      });
      last = now;
      setCount(revealCut(s.text, s.count));
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [reduced]);

  const shown = reduced ? text : text.slice(0, Math.min(count, text.length));
  return { shown, caughtUp: shown.length >= text.length };
}
