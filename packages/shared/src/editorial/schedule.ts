/**
 * Daily runs are identified by the Chicago-local calendar date of their *scheduled* time, so a
 * delayed or retried firing maps to the same run. America/Chicago changes clocks at 02:00 local,
 * so local midnight exists exactly once every day.
 */
export const NEWSROOM_TIME_ZONE = 'America/Chicago';

const chicagoDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: NEWSROOM_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** `YYYY-MM-DD` in America/Chicago for the given instant. */
export function chicagoDateKey(instant: Date): string {
  if (Number.isNaN(instant.getTime())) throw new RangeError('Invalid date');
  return chicagoDate.format(instant);
}

export function dailyRunKey(scheduledAt: Date): string {
  return `daily-discovery:${chicagoDateKey(scheduledAt)}`;
}

export function manualRunKey(requestedAt: Date): string {
  return `manual:${requestedAt.toISOString()}`;
}

export const RUN_KEY_PATTERN =
  /^(daily-discovery:\d{4}-\d{2}-\d{2}|manual:\d{4}-\d{2}-\d{2}T[\d:.]+Z)$/;
