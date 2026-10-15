const UNITS = [
  ['d', 86_400],
  ['h', 3_600],
  ['m', 60],
  ['s', 1],
] as const;

/**
 * Formats a duration in seconds as a compact string, e.g. `3725` becomes `"1h 2m 5s"`.
 * Fractional seconds are truncated and zero-valued units are omitted.
 */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    throw new RangeError(`Expected a non-negative number of seconds, received ${totalSeconds}`);
  }

  let remaining = Math.floor(totalSeconds);
  const parts: string[] = [];

  for (const [unit, size] of UNITS) {
    const value = Math.floor(remaining / size);
    remaining %= size;
    if (value > 0) {
      parts.push(`${value}${unit}`);
    }
  }

  return parts.length > 0 ? parts.join(' ') : '0s';
}
