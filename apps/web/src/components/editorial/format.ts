import {
  CROSS_CUTTING_TAGS,
  FORMAT_POTENTIAL,
  PILLARS,
  REGIONS,
  SCORING_DIMENSIONS,
  type PillarId,
  type RegionId,
  type ScoringDimension,
} from '@repo/shared';

/** Display labels from the controlled vocabularies, plus date formatting in newsroom time (Chicago). */

export const NEWSROOM_TZ = 'America/Chicago';

export const pillarLabel = (id: PillarId | null) => (id ? PILLARS[id].label : 'Unclassified');
export const regionLabel = (id: RegionId) => REGIONS[id].label;
export const tagLabel = (id: string) =>
  (CROSS_CUTTING_TAGS.labels as Record<string, string>)[id] ?? id;
export const formatLabel = (id: string) =>
  (FORMAT_POTENTIAL.labels as Record<string, string>)[id] ?? id;
export const dimensionLabel = (id: ScoringDimension) => SCORING_DIMENSIONS[id].label;
export const dimensionWeight = (id: ScoringDimension) => SCORING_DIMENSIONS[id].weight;

export function subcategoryLabel(id: string): string {
  for (const pillar of Object.values(PILLARS)) {
    const label = (pillar.subcategories as Record<string, string>)[id];
    if (label) return label;
  }
  return id;
}

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: NEWSROOM_TZ,
});
const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: NEWSROOM_TZ,
});
const timeFormat = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: NEWSROOM_TZ,
});
// en-GB names Chicago's zone "GMT-5"; en-US gives the familiar "CDT" / "CST".
const zoneFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: NEWSROOM_TZ,
  timeZoneName: 'short',
});
const zone = (date: Date) =>
  zoneFormat.formatToParts(date).find((part) => part.type === 'timeZoneName')?.value ?? '';
const longDateFormat = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: NEWSROOM_TZ,
});

export const formatDate = (iso: string | null) =>
  iso ? dateFormat.format(new Date(iso)) : 'Undated';
export const formatDateTime = (iso: string | null) =>
  iso ? `${dateTimeFormat.format(new Date(iso))} ${zone(new Date(iso))}` : '—';
export const formatLongDate = (iso: string | null) =>
  iso ? longDateFormat.format(new Date(iso)) : '—';
export const formatTime = (iso: string | null) =>
  iso ? `${timeFormat.format(new Date(iso))} ${zone(new Date(iso))}` : '—';

/** "2026-10-15" (a newsroom day) → its date at noon UTC, safe to format in Chicago time. */
export const dayToDate = (day: string) => new Date(`${day}T12:00:00Z`);
export const formatLongDay = (day: string) => longDateFormat.format(dayToDate(day));
export const formatDay = (day: string) => dateFormat.format(dayToDate(day));

export const compactNumber = new Intl.NumberFormat('en-GB', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export function placeLabel(
  geography: ReadonlyArray<{ country: string; city: string | null }>,
): string {
  return geography.map((g) => (g.city ? `${g.city}, ${g.country}` : g.country)).join(' · ');
}
