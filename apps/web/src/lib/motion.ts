import { useSyncExternalStore } from 'react';

const REDUCED = '(prefers-reduced-motion: reduce)';

/**
 * Smooth scrolling, unless the reader has asked for reduced motion. A script's explicit
 * `behavior: 'smooth'` isn't overridden by the stylesheet's reduced-motion rule, so scripts ask.
 */
export function scrollBehavior(): ScrollBehavior {
  return window.matchMedia(REDUCED).matches ? 'auto' : 'smooth';
}

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** Whether the reader has asked for reduced motion (false while rendering on the server). */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(REDUCED).matches,
    () => false,
  );
}
