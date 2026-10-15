import { createHash } from 'node:crypto';

/**
 * Deterministic normalisation used before any model is involved: exact duplicates and
 * near-identical revisits are resolved here for free.
 */

const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igshid',
  '_hsenc',
  '_hsmi',
  'ref_src',
  'cmpid',
  'ocid',
]);

/**
 * Canonical form of an article URL: https, lower-case host without `www.`, no fragment, no
 * tracking parameters, remaining parameters sorted, no trailing slash. Returns null for anything
 * that isn't an http(s) URL.
 */
export function canonicalizeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.protocol = 'https:';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  url.hash = '';
  url.port = '';
  const params = [...url.searchParams.entries()]
    .filter(
      ([key]) => !key.toLowerCase().startsWith('utm_') && !TRACKING_PARAMS.has(key.toLowerCase()),
    )
    .sort(([a], [b]) => a.localeCompare(b));
  url.search = new URLSearchParams(params).toString();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}

export function hostOf(canonicalUrl: string): string {
  return new URL(canonicalUrl).hostname;
}

/** Display names for frequent publishers; anything else shows its host. */
const PUBLISHER_NAMES: Record<string, string> = {
  'businessday.ng': 'BusinessDay',
  'guardian.ng': 'The Guardian Nigeria',
  'theguardian.com': 'The Guardian',
  'theartnewspaper.com': 'The Art Newspaper',
  'artnews.com': 'ARTnews',
  'artreview.com': 'ArtReview',
  'frieze.com': 'Frieze',
  'hyperallergic.com': 'Hyperallergic',
  'contemporaryand.com': 'Contemporary And (C&)',
  'okayafrica.com': 'OkayAfrica',
  'dezeen.com': 'Dezeen',
  'wallpaper.com': 'Wallpaper*',
  'designboom.com': 'designboom',
  'archdaily.com': 'ArchDaily',
  'artsy.net': 'Artsy',
  'nytimes.com': 'The New York Times',
  'bbc.com': 'BBC',
  'bbc.co.uk': 'BBC',
  'african.business': 'African Business',
  'bellanaija.com': 'BellaNaija',
};

export function publisherName(host: string): string {
  return PUBLISHER_NAMES[host] ?? host;
}

/** Parses provider dates (ISO 8601 or RFC 1123); null when absent or unparseable. */
export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function contentHash(text: string): string {
  return createHash('sha256').update(normalizeText(text), 'utf8').digest('hex');
}

const SHINGLE_SIZE = 5;
const MAX_COMPARE_CHARS = 20_000;

function shingles(text: string): Set<string> {
  const words = normalizeText(text.slice(0, MAX_COMPARE_CHARS))
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(' ')
    .filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE_SIZE <= words.length; i += 1) {
    out.add(words.slice(i, i + SHINGLE_SIZE).join(' '));
  }
  if (out.size === 0 && words.length > 0) out.add(words.join(' '));
  return out;
}

/** Jaccard similarity of word 5-shingles, 0–1. */
export function textSimilarity(a: string, b: string): number {
  const sa = shingles(a);
  const sb = shingles(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let intersection = 0;
  for (const shingle of sa) if (sb.has(shingle)) intersection += 1;
  return intersection / (sa.size + sb.size - intersection);
}

/** Lower-cased title without punctuation or a trailing " - Publisher" / " | Section" suffix. */
export function normalizeTitle(title: string): string {
  return title
    .replace(/\s+[-|–—]\s+[^-|–—]{2,40}$/u, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function titleSimilarity(a: string, b: string): number {
  const ta = new Set(
    normalizeTitle(a)
      .split(' ')
      .filter((w) => w.length > 2),
  );
  const tb = new Set(
    normalizeTitle(b)
      .split(' ')
      .filter((w) => w.length > 2),
  );
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const word of ta) if (tb.has(word)) intersection += 1;
  return intersection / (ta.size + tb.size - intersection);
}

export const TRUNCATION_MARKER = ' […excerpt truncated]';

/** Cuts text for a prompt and says so, so a model never mistakes our cut for a defect in the source. */
export function excerpt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}${TRUNCATION_MARKER}`;
}
