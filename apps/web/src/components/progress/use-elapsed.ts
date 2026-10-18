'use client';

import { useEffect, useState } from 'react';

/**
 * Milliseconds since `since` (an ISO time on the server's clock), kept current every second while
 * `active`. The view's `serverNow` sets the offset, so a browser clock that is minutes out can't
 * make a stage look slow (or quick).
 */
export function useElapsed(
  since: string | null | undefined,
  serverNow: string | null | undefined,
  active = true,
): number | null {
  const [received, setReceived] = useState(() => ({ serverNow, at: Date.now() }));
  const [now, setNow] = useState(() => Date.now());

  // Re-anchor to the server's clock whenever a fresh reading arrives.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setReceived({ serverNow, at: Date.now() }));
    return () => cancelAnimationFrame(frame);
  }, [serverNow]);

  useEffect(() => {
    if (!active || !since) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active, since]);

  if (!since) return null;
  const offset = received.serverNow ? Date.parse(received.serverNow) - received.at : 0;
  return Math.max(0, now + offset - Date.parse(since));
}
