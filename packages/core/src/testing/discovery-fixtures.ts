/**
 * TEST FIXTURES ONLY. Invented articles on example.* domains, modelled on the kinds of results a
 * real discovery search returns (a genuine exhibition, a syndicated copy, a listicle, brand
 * promotion, a sales listing). They are not real reporting and must never be shown as such.
 */
import { SCORING_DIMENSION_IDS, type ScoringDimension } from '@repo/shared';

import type { EvaluationOutput } from '../discovery/schemas.js';
import { stripMarkdown } from '../research/citations.js';
import type { ExtractedPage, SearchClient, SearchHit } from '../search/types.js';

export interface FixtureArticle extends SearchHit {
  content: string;
  /** Image URLs "found on the page" (fixture only). */
  images: string[];
}

function body(title: string, detail: string): string {
  return Array.from(
    { length: 18 },
    (_, i) =>
      `${i === 0 ? `${title}. ` : ''}${detail} (paragraph ${i + 1} of the fixture text, detail ${i * 17}).`,
  ).join(' ');
}

/**
 * Fixture images are stable placeholder photographs from picsum.photos (seeded URLs), used only
 * in the fixtures database to exercise image layouts. They are not real story imagery.
 */
const fixtureImage = (seed: string) => `https://picsum.photos/seed/omenai-${seed}/1600/1066`;

function article(
  url: string,
  title: string,
  publishedDate: string,
  score: number,
  detail: string,
  imageSeed?: string,
): FixtureArticle {
  return {
    url,
    title,
    snippet: detail,
    publishedDate,
    score,
    content: body(title, detail),
    // A logo first, so the deterministic filter must skip it.
    images: imageSeed ? ['https://cdn.example/site-logo.png', fixtureImage(imageSeed)] : [],
  };
}

export const DAY1 = {
  gele: article(
    'https://lagos-business.example/arts/alexis-galleries-gele/',
    'Alexis Galleries pairs two contemporary art masters in Gele, joint exhibition',
    'Mon, 12 Oct 2026 03:00:00 GMT',
    0.91,
    'The Lagos gallery stages a joint exhibition on the gele head-tie as adornment and authorship',
    'gele',
  ),
  geleSyndicated: article(
    'https://nigeria-arts.example/news/alexis-galleries-pairs-two-contemporary-art-masters-in-gele?utm_source=feed',
    'Alexis Galleries pairs two contemporary art masters in Gele joint exhibition - Nigeria Arts',
    'Mon, 12 Oct 2026 09:00:00 GMT',
    0.8,
    'A syndicated report of the Lagos joint exhibition on the gele',
  ),
  geleTracking: article(
    'https://www.lagos-business.example/arts/alexis-galleries-gele/?utm_source=twitter',
    'Alexis Galleries pairs two contemporary art masters in Gele, joint exhibition',
    'Mon, 12 Oct 2026 03:00:00 GMT',
    0.5,
    'Same article reached through a tracking link',
  ),
  listicle: article(
    'https://ng-daily.example/arts/10-art-exhibitions-this-october',
    '10 art exhibitions this October',
    'Fri, 09 Oct 2026 13:51:56 GMT',
    0.9,
    'A list of ten openings with one line each',
  ),
  whisky: article(
    'https://lifestyle.example/the-macallan-celebration-of-african-creativity',
    'Inside a whisky brand’s celebration of African creativity',
    'Wed, 07 Oct 2026 10:26:53 GMT',
    0.77,
    'Sponsored event copy for a whisky brand with craft displays',
  ),
  punk: article(
    'https://african-biz.example/nigerian-youth-punk-wake-up-2',
    'Nigerian youth channel the spirit of punk at Wake Up! 2',
    'Mon, 12 Oct 2026 03:00:00 GMT',
    0.7,
    'A youth punk event in Lagos with a small audience',
    'punk',
  ),
  sale: article(
    'https://art-market.example/artwork/bedtime-2026',
    'Bedtime (2026) by a Lagos painter - For Sale',
    'Wed, 14 Oct 2026 03:00:00 GMT',
    0.53,
    'A single painting listed for sale',
  ),
  zeitz: article(
    'https://arts.example.org/zeitz-retrospective-kwame-asante',
    'Zeitz MOCAA opens first major retrospective of Ghanaian sculptor Kwame Asante',
    'Tue, 13 Oct 2026 08:00:00 GMT',
    0.95,
    'A retrospective of a sculptor working with reclaimed bottle caps opens in Cape Town',
    'zeitz',
  ),
  rights: article(
    'https://archive.example.org/unseen-lagos-nightlife-photographs',
    'Unseen archive photographs of 1970s Lagos nightlife surface online',
    'Wed, 14 Oct 2026 11:00:00 GMT',
    0.85,
    'Photographs of uncertain provenance circulate on a blog',
  ),
};

export const DAY2 = {
  zeitzCrowds: article(
    'https://arts.example.org/zeitz-retrospective-draws-crowds',
    'Zeitz MOCAA retrospective of Kwame Asante draws crowds in Cape Town',
    'Fri, 16 Oct 2026 08:00:00 GMT',
    0.8,
    'Visitors attend the Kwame Asante retrospective; no new information',
  ),
  auction: article(
    'https://market.example.org/asante-bottle-cap-work-auction-record',
    'Kwame Asante bottle-cap work sets auction record after Zeitz retrospective',
    'Sat, 17 Oct 2026 08:00:00 GMT',
    0.92,
    'A bottle-cap sculpture by Kwame Asante sells for a record price at auction',
    'auction',
  ),
};

/** A fake search client: every query returns the current day's hits; extracts serve fixture text. */
export function createFakeSearch(initialHits: FixtureArticle[]) {
  let hits = initialHits;
  const pages = new Map<string, string>(initialHits.map((h) => [h.url, h.content]));
  const pageImages = new Map<string, string[]>(initialHits.map((h) => [h.url, h.images]));
  const calls = { search: 0, extract: 0, extractedUrls: [] as string[] };

  const client: SearchClient = {
    search: () => {
      calls.search += 1;
      return Promise.resolve(hits.map(({ content: _content, images: _images, ...hit }) => hit));
    },
    extract: (urls) => {
      calls.extract += 1;
      calls.extractedUrls.push(...urls);
      const found: ExtractedPage[] = [];
      const failed: Array<{ url: string; error: string }> = [];
      for (const url of urls) {
        const content = pages.get(url);
        if (content) found.push({ url, title: null, content, images: pageImages.get(url) ?? [] });
        else failed.push({ url, error: 'not in fixture' });
      }
      return Promise.resolve({ pages: found, failed });
    },
  };

  return {
    client,
    calls,
    setHits(next: FixtureArticle[]) {
      hits = next;
      for (const h of next) {
        if (!pages.has(h.url)) pages.set(h.url, h.content);
        if (!pageImages.has(h.url)) pageImages.set(h.url, h.images);
      }
    },
    setPage(url: string, content: string) {
      pages.set(url, content);
    },
  };
}

type Scores = Record<ScoringDimension, number>;

/** The text an evaluation prompt shows for one source label (A1, A2…). */
export function promptSourceText(prompt: string, ref: string): string {
  const sources = prompt.split('SOURCES:\n')[1]?.split('\n\nTRIAGE SIGNALS')[0] ?? '';
  const block = sources.split('\n---\n').find((b) => b.startsWith(`${ref} |`)) ?? '';
  return block
    .split('\n')
    .slice(1)
    .filter((line) => !line.startsWith('[snippet only'))
    .join('\n');
}

/**
 * A key claim that quotes the first full sentence of a source's text word for word, so it passes
 * the deterministic checks. Fixture only: real claims come from the model and are checked the
 * same way.
 */
export function fixtureKeyClaims(prompt: string, ref = 'A1'): EvaluationOutput['keyClaims'] {
  const text = stripMarkdown(promptSourceText(prompt, ref));
  const sentence = /[^.!?\n]{20,}?[.!?](?=\s|$)/.exec(text)?.[0]?.trim();
  return sentence ? [{ statement: sentence, type: 'fact', sources: [ref], quote: sentence }] : [];
}

/** Builds a schema-valid evaluation with the given dimension scores. */
export function fixtureEvaluation(
  scores: Scores,
  overrides: Partial<EvaluationOutput> = {},
): EvaluationOutput {
  return {
    headline: 'Fixture headline',
    summary: 'A neutral fixture summary of the development.',
    whatHappened: 'Something happened on a stated date, per A1.',
    keyClaims: [],
    editorialTest: {
      canAnswer: true,
      answer:
        'This matters to Omenai’s audience because it shows how a specific institution and artist are reshaping who gets a retrospective, and on whose terms, in an African museum.',
      supportedBy: [1],
    },
    whyItMatters: 'Specific significance. Clear editorial fit.',
    angle: 'Who decides which careers become histories?',
    whyNow: 'The exhibition opens this week.',
    primaryPillar: 'art_creative_expression',
    subcategories: ['galleries_museums_fairs'],
    crossCuttingTags: ['cultural_institutions'],
    geography: [
      { country: 'South Africa', city: 'Cape Town', region: 'southern_africa', confidence: 'high' },
    ],
    culturalConnections: [],
    entities: ['Zeitz MOCAA'],
    noveltyStatus: 'new',
    timeliness: 'this_week',
    formatPotential: [{ format: 'feature', rationale: 'Room for context.' }],
    verificationNeeds: ['Confirm dates with the museum.'],
    peopleToApproach: [],
    visualOpportunities: ['Installation views (rights unconfirmed).'],
    sourceQuality: [{ ref: 'A1', quality: 'reputable_secondary' }],
    scores: Object.fromEntries(
      SCORING_DIMENSION_IDS.map((d) => [
        d,
        { score: scores[d], rationale: `Fixture rationale for ${d}.` },
      ]),
    ) as EvaluationOutput['scores'],
    confidence: 'high',
    exclusions: [],
    dismissedSignals: [],
    pressRelease: { leadOnly: false, reason: 'Fixture: reported beyond the announcement.' },
    criticalIssues: [],
    needsEscalation: false,
    escalationReason: null,
    ...overrides,
  };
}

/** Uniform scores with optional per-dimension changes. */
export function scores(base: number, changes: Partial<Scores> = {}): Scores {
  return {
    ...(Object.fromEntries(SCORING_DIMENSION_IDS.map((d) => [d, base])) as Scores),
    ...changes,
  };
}
