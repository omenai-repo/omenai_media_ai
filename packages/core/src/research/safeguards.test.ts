import { describe, expect, it } from 'vitest';

import {
  checkClaim,
  checkClaims,
  flagConflicts,
  type CheckedClaim,
  type CitableSource,
  type CitationStatus,
  type ClaimType,
} from './citations.js';
import { detailAsked, judgeEvidence, type Evidence, type EvidenceCheck } from './evidence.js';
import { eventsNamed, withDigits } from './terms.js';

/**
 * The evidence-accuracy safeguards (ADR-039) as general invariants. Each table exercises one
 * invariant across Omenai's domains, with invented subjects and sources, and holds cases that must
 * pass beside cases that must fail. The checks are lexical: these tests pin down what they catch
 * and what they let through (see the "known limits" cases), never that a statement passing them
 * is true.
 */

/** Invented source passages, one per domain: fixture text, not real reporting. */
const PASSAGES = {
  art: 'The Kuramo Art Centre opened “Salt and Memory”, a survey of the painter Adaeze Obi, on 14 March 2025. The exhibition brings together 64 works made between 1998 and 2024 and runs until 30 June 2025. The centre announced the survey in January 2025. Obi said the show was “a conversation with my mother’s archive”.',
  architecture:
    'The **Selwyn Library** in Accra, designed by Mensah Ofori Architects, was completed in 2019. The building spans 4,200 square metres over three floors. In 2023 the library was expanded with a reading garden.',
  design:
    'Halden Design Week announced its 2026 programme on 2 February; the festival opens on 18 September. The organisers expect 40,000 visitors, up from 32,000 in 2025. Tickets are available online from Tuesday.',
  fashion:
    'The label Studio Nwosu was founded in 2016 by the Nigerian designer Chidi Nwosu. It presented its autumn collection at Lagos Fashion Week in October 2024. Nwosu was named creative director of the Paris house Maison Verlaine in January 2025.',
  music:
    'The singer Lerato Dube recorded her debut album, Ember Season, in Johannesburg in 2021; it was released on 9 June 2022. The album sold 120,000 copies in its first year. Dube called it “a love letter to the township”.',
  film: 'The documentary Rivers of Indigo, directed by Kofi Amankwah, premiered at the Sahel Film Days in Ouagadougou in February 2024. It was nominated for the festival’s top prize but lost to a Senegalese drama.',
  literature:
    'Wanjiru Kamau’s third novel, The Salt Road, was published by Ndovu Press in 2023. It was shortlisted for the Kilimanjaro Prize in 2023 and won it in 2024. Kamau said she wrote much of it “in the waiting rooms of my father’s hospital”.',
  performance:
    'The Kora Dance Collective staged its first performance at the Ruwa Theatre in 1987. Its current production tours 12 cities across West Africa, ending in Dakar in November.',
  heritage:
    'The Rijkstad Museum returned 37 carved panels to the National Museum of Benin in March 2024. The panels had been taken from the palace at Abomey in 1892. The National Museum of Benin plans to display them in a new gallery from 2026.',
  market:
    'A bottle-cap tapestry by Ama Sefa sold for £1.2 million at Corran’s London sale on 12 October 2025, above its estimate of £600,000–£800,000. The previous auction record for the artist was £410,000, set in 2022.',
  photography:
    'The Ife Photography Trust acquired Tunde Lawal’s archive of 9,000 negatives in 2023. Lawal first exhibited the series at the Bienal de São Tomé in 2019. A selection of 80 prints goes on view in Ibadan on 3 May 2025.',
  food: 'Chef Amara Diallo opened her restaurant Teranga Table in Brooklyn in 2019. It received a star from the City Table Guide in 2024. Diallo said the menu follows “my grandmother’s Saturday cooking”.',
} as const;
type Domain = keyof typeof PASSAGES;

interface StatementCase {
  domain: Domain;
  why: string;
  type?: ClaimType;
  text: string;
  quote: string;
  labels?: string[];
  /** Further sources beside S1 (the domain's passage). */
  extra?: Record<string, string>;
  expected: CitationStatus | `dropped: ${'unknown_source' | 'no_source'}`;
}

function citable(domain: Domain, extra: Record<string, string> = {}) {
  return new Map<string, CitableSource>(
    Object.entries({ S1: PASSAGES[domain], ...extra }).map(([label, text], i) => [
      label,
      { label, id: `source-${i}`, text },
    ]),
  );
}

function statusOf(c: StatementCase): string {
  const result = checkClaim(
    { type: c.type ?? 'fact', text: c.text, sources: c.labels ?? ['S1'], excerpt: c.quote },
    citable(c.domain, c.extra),
  );
  return 'claim' in result ? result.claim.citationStatus : `dropped: ${result.dropped.reason}`;
}

const label = (c: { domain: string; why: string }) => `${c.domain}: ${c.why}`;

describe('a statement may cite only sources in the research', () => {
  const cases: StatementCase[] = [
    {
      domain: 'film',
      why: 'a label outside the research is removed',
      text: 'Rivers of Indigo premiered at the Sahel Film Days.',
      quote: 'premiered at the Sahel Film Days',
      labels: ['S4'],
      expected: 'dropped: unknown_source',
    },
    {
      domain: 'literature',
      why: 'an attributed statement with no source is removed',
      type: 'attributed',
      text: 'Kamau says the novel took a decade.',
      quote: '',
      labels: [],
      expected: 'dropped: no_source',
    },
    {
      domain: 'performance',
      why: 'a fact with no source is removed',
      text: 'The collective was founded in 1987.',
      quote: '',
      labels: [],
      expected: 'dropped: no_source',
    },
    {
      domain: 'design',
      why: 'analysis needs no source, and is never shown as checked',
      type: 'analysis',
      text: 'This suggests the festival is outgrowing its venues.',
      quote: '',
      labels: [],
      expected: 'uncited',
    },
    {
      domain: 'music',
      why: 'an open question needs no source',
      type: 'open_question',
      text: 'It isn’t clear who produced the album.',
      quote: '',
      labels: [],
      expected: 'uncited',
    },
    {
      domain: 'food',
      why: 'a label written loosely still names its source',
      text: 'Teranga Table opened in Brooklyn in 2019.',
      quote: 'opened her restaurant Teranga Table in Brooklyn in 2019',
      labels: ['[s1]'],
      expected: 'verified',
    },
  ];
  it.each(cases.map((c) => [label(c), c] as const))('%s', (_, c) => {
    expect(statusOf(c)).toBe(c.expected);
  });
});

describe('a quote must appear word for word in the source it cites', () => {
  const cases: StatementCase[] = [
    {
      domain: 'art',
      why: 'a quote with a word changed',
      text: 'The survey brings together 64 works.',
      quote: 'brings together 64 paintings',
      expected: 'excerpt_not_located',
    },
    {
      domain: 'market',
      why: 'a quote with its figure changed',
      text: 'The tapestry sold for £1.4 million.',
      quote: 'sold for £1.4 million at Corran’s London sale',
      expected: 'excerpt_not_located',
    },
    {
      domain: 'literature',
      why: 'an invented quotation',
      type: 'attributed',
      text: 'Kamau called the novel a hymn to her father.',
      quote: 'a hymn to my father',
      expected: 'excerpt_not_located',
    },
    {
      domain: 'film',
      why: 'a real passage, from another source than the one cited',
      text: 'Rivers of Indigo premiered in Ouagadougou in February 2024.',
      quote: 'premiered at the Sahel Film Days in Ouagadougou in February 2024',
      labels: ['S2'],
      extra: { S2: PASSAGES.performance },
      expected: 'excerpt_not_located',
    },
    {
      domain: 'architecture',
      why: 'Markdown emphasis in the stored page is not part of the words',
      text: 'The Selwyn Library in Accra was designed by Mensah Ofori Architects.',
      quote: 'The Selwyn Library in Accra, designed by Mensah Ofori Architects',
      expected: 'verified',
    },
    {
      domain: 'music',
      why: 'straight quotation marks against curly ones',
      type: 'attributed',
      text: 'Dube called Ember Season "a love letter to the township".',
      quote: 'Dube called it "a love letter to the township"',
      expected: 'verified',
    },
    {
      domain: 'market',
      why: 'a hyphen for an en dash',
      text: 'The tapestry’s estimate was £600,000 to £800,000.',
      quote: 'above its estimate of £600,000-£800,000',
      expected: 'verified',
    },
  ];
  it.each(cases.map((c) => [label(c), c] as const))('%s', (_, c) => {
    expect(statusOf(c)).toBe(c.expected);
  });
});

describe('every date, figure and quoted word a statement gives must be in its quote', () => {
  const cases: StatementCase[] = [
    {
      domain: 'architecture',
      why: 'a year the quote doesn’t give',
      text: 'The Selwyn Library was completed in 2021.',
      quote: 'The Selwyn Library in Accra, designed by Mensah Ofori Architects',
      expected: 'detail_not_in_excerpt',
    },
    {
      domain: 'design',
      why: 'a figure the quote doesn’t give',
      text: 'The organisers expect 45,000 visitors.',
      quote: 'The organisers expect 40,000 visitors',
      expected: 'detail_not_in_excerpt',
    },
    {
      domain: 'art',
      why: 'a month the quote doesn’t give',
      text: 'The Obi survey opened in April 2025.',
      quote: 'a survey of the painter Adaeze Obi, on 14 March 2025',
      expected: 'detail_not_in_excerpt',
    },
    {
      domain: 'fashion',
      why: 'a day the quote doesn’t give, though its year contains the digit',
      text: 'Nwosu was named creative director on 2 January 2025.',
      quote: 'named creative director of the Paris house Maison Verlaine in January 2025',
      expected: 'detail_not_in_excerpt',
    },
    {
      domain: 'music',
      why: 'a relative date the quote doesn’t give',
      text: 'Ember Season was released this week.',
      quote: 'it was released on 9 June 2022',
      expected: 'detail_not_in_excerpt',
    },
    {
      domain: 'literature',
      why: 'words put in someone’s mouth that the quote doesn’t contain',
      type: 'attributed',
      text: 'Kamau said she wrote the novel "at her kitchen table".',
      quote: 'Kamau said she wrote much of it',
      expected: 'detail_not_in_excerpt',
    },
    {
      domain: 'music',
      why: 'day, month and year all quoted',
      text: 'Ember Season was released on 9 June 2022.',
      quote: 'it was released on 9 June 2022',
      expected: 'verified',
    },
    {
      domain: 'music',
      why: 'a figure written without its thousands separator',
      text: 'The album sold 120000 copies in its first year.',
      quote: 'The album sold 120,000 copies in its first year',
      expected: 'verified',
    },
    {
      domain: 'performance',
      why: 'a month quoted',
      text: 'The tour ends in Dakar in November.',
      quote: 'ending in Dakar in November',
      expected: 'verified',
    },
    {
      domain: 'photography',
      why: 'a place written without its accents',
      text: 'Lawal showed the series at the Sao Tome biennial in 2019.',
      quote: 'first exhibited the series at the Bienal de São Tomé in 2019',
      expected: 'verified',
    },
    {
      domain: 'food',
      why: 'quoted words, a weekday among them, that the quote contains',
      type: 'attributed',
      text: 'Diallo says the menu follows "my grandmother’s Saturday cooking".',
      quote: 'Diallo said the menu follows “my grandmother’s Saturday cooking”',
      expected: 'verified',
    },
  ];
  it.each(cases.map((c) => [label(c), c] as const))('%s', (_, c) => {
    expect(statusOf(c)).toBe(c.expected);
  });
});

describe('a found quote must be about the statement it is offered for', () => {
  const cases: StatementCase[] = [
    {
      domain: 'fashion',
      why: 'a real passage about something else, naming others',
      text: 'Chidi Nwosu leads the Paris house Maison Verlaine.',
      quote: 'It presented its autumn collection at Lagos Fashion Week',
      expected: 'excerpt_unrelated',
    },
    {
      domain: 'music',
      why: 'a real passage sharing a single word with the statement',
      text: 'The album sold strongly in its first year.',
      quote: 'recorded her debut album, Ember Season, in Johannesburg',
      expected: 'excerpt_unrelated',
    },
    {
      domain: 'heritage',
      why: 'the same act credited to a different institution',
      text: 'The Rijkstad Museum will display the panels in a new gallery.',
      quote: 'The National Museum of Benin plans to display them in a new gallery',
      expected: 'excerpt_unrelated',
    },
    {
      domain: 'design',
      why: 'a passage on a neighbouring topic',
      text: 'Halden Design Week sold out its opening night.',
      quote: 'Tickets are available online from Tuesday',
      expected: 'excerpt_unrelated',
    },
    {
      domain: 'art',
      why: 'a quote that refers to the show without naming the artist',
      text: 'Adaeze Obi’s survey brings together 64 works.',
      quote: 'The exhibition brings together 64 works made between 1998 and 2024',
      expected: 'verified',
    },
    {
      domain: 'fashion',
      why: 'a related form of a name ("Nigerian" for "Nigeria")',
      text: 'The label was founded in 2016 by a designer from Nigeria.',
      quote: 'founded in 2016 by the Nigerian designer Chidi Nwosu',
      expected: 'verified',
    },
    {
      domain: 'literature',
      why: 'a speaker’s own words, which don’t name the speaker',
      type: 'attributed',
      text: 'Kamau said she wrote much of the novel in hospital waiting rooms.',
      quote: 'in the waiting rooms of my father’s hospital',
      expected: 'verified',
    },
    {
      domain: 'performance',
      why: 'a paraphrase that keeps the key words',
      text: 'The Kora Dance Collective first performed at the Ruwa Theatre in 1987.',
      quote: 'staged its first performance at the Ruwa Theatre in 1987',
      expected: 'verified',
    },
    {
      domain: 'photography',
      why: 'a different verb for the same facts',
      text: 'The trust bought an archive of 9,000 negatives in 2023.',
      quote: 'acquired Tunde Lawal’s archive of 9,000 negatives in 2023',
      expected: 'verified',
    },
    // Known limit: a quote that names the right things and shares the statement's words can still
    // say something else. The editor sees the quote beside the statement to judge this.
    {
      domain: 'film',
      why: 'known limit: the right names and words, a different claim',
      text: 'Kofi Amankwah directed a Senegalese drama.',
      quote: 'It was nominated for the festival’s top prize but lost to a Senegalese drama',
      expected: 'verified',
    },
  ];
  it.each(cases.map((c) => [label(c), c] as const))('%s', (_, c) => {
    expect(statusOf(c)).toBe(c.expected);
  });
});

interface ConflictCase {
  domain: string;
  why: string;
  a: { text: string; quote: string; source: string };
  b: { text: string; quote: string; source: string };
  conflict: boolean;
}

/** Checks two statements, each citing its own source, together (as every surface does). */
function checkedPair(c: ConflictCase): CitationStatus[] {
  const sources = new Map<string, CitableSource>([
    ['S1', { label: 'S1', id: 'source-1', text: c.a.source }],
    ['S2', { label: 'S2', id: 'source-2', text: c.b.source }],
  ]);
  const { claims } = checkClaims(
    [
      { type: 'fact', text: c.a.text, sources: ['S1'], excerpt: c.a.quote },
      { type: 'fact', text: c.b.text, sources: ['S2'], excerpt: c.b.quote },
    ],
    sources,
  );
  return claims.map((claim) => claim.citationStatus);
}

describe('statements whose quotes give different dates or figures for one thing are unsettled', () => {
  const cases: ConflictCase[] = [
    {
      domain: 'literature',
      why: 'two years for one win',
      a: {
        text: 'The Salt Road won the Kilimanjaro Prize in 2024.',
        quote: 'and won it in 2024',
        source: PASSAGES.literature,
      },
      b: {
        text: 'The Salt Road won the Kilimanjaro Prize in 2023.',
        quote: 'The Salt Road won the Kilimanjaro Prize in 2023',
        source: 'The Salt Road won the Kilimanjaro Prize in 2023, the jury said.',
      },
      conflict: true,
    },
    {
      domain: 'design',
      why: 'two attendance figures for one year',
      a: {
        text: 'Halden Design Week drew 32,000 visitors in 2025.',
        quote: 'up from 32,000 in 2025',
        source: PASSAGES.design,
      },
      b: {
        text: 'Halden Design Week drew 38,000 visitors in 2025.',
        quote: 'Halden Design Week drew 38,000 visitors in 2025',
        source: 'Halden Design Week drew 38,000 visitors in 2025, the city said.',
      },
      conflict: true,
    },
    {
      domain: 'art',
      why: 'two closing dates in one year',
      a: {
        text: 'Salt and Memory runs until 30 June 2025.',
        quote: 'runs until 30 June 2025',
        source: PASSAGES.art,
      },
      b: {
        text: 'Salt and Memory runs until 28 July 2025.',
        quote: 'Salt and Memory runs until 28 July 2025',
        source: 'Salt and Memory runs until 28 July 2025, the centre confirmed.',
      },
      conflict: true,
    },
    {
      domain: 'market',
      why: 'two prices for one sale',
      a: {
        text: 'Ama Sefa’s tapestry sold for £1.2 million at Corran’s.',
        quote: 'A bottle-cap tapestry by Ama Sefa sold for £1.2 million at Corran’s London sale',
        source: PASSAGES.market,
      },
      b: {
        text: 'Ama Sefa’s tapestry sold for £1.4 million at Corran’s.',
        quote: 'Ama Sefa’s tapestry sold for £1.4 million at Corran’s',
        source: 'Ama Sefa’s tapestry sold for £1.4 million at Corran’s, according to the house.',
      },
      conflict: true,
    },
    {
      domain: 'art',
      why: 'an opening and a closing are different events',
      a: {
        text: 'Salt and Memory opened on 14 March 2025.',
        quote: 'on 14 March 2025',
        source: PASSAGES.art,
      },
      b: {
        text: 'Salt and Memory runs until 30 June 2025.',
        quote: 'runs until 30 June 2025',
        source: PASSAGES.art,
      },
      conflict: false,
    },
    {
      domain: 'design',
      why: 'figures for different years are a series',
      a: {
        text: 'Halden Design Week drew 32,000 visitors in 2025.',
        quote: 'up from 32,000 in 2025',
        source: PASSAGES.design,
      },
      b: {
        text: 'Halden Design Week expects 40,000 visitors in 2026.',
        quote: 'Halden Design Week expects 40,000 visitors in 2026',
        source: 'Halden Design Week expects 40,000 visitors in 2026.',
      },
      conflict: false,
    },
    {
      domain: 'music',
      why: 'the same date given more and less precisely',
      a: {
        text: 'Ember Season was released on 9 June 2022.',
        quote: 'it was released on 9 June 2022',
        source: PASSAGES.music,
      },
      b: {
        text: 'Ember Season was released in June 2022.',
        quote: 'Ember Season was released in June 2022',
        source: 'Ember Season was released in June 2022.',
      },
      conflict: false,
    },
    {
      domain: 'heritage',
      why: 'a taking and a return are different events',
      a: {
        text: 'The panels were taken from the palace at Abomey in 1892.',
        quote: 'The panels had been taken from the palace at Abomey in 1892',
        source: PASSAGES.heritage,
      },
      b: {
        text: 'The Rijkstad Museum returned the carved panels in March 2024.',
        quote:
          'The Rijkstad Museum returned 37 carved panels to the National Museum of Benin in March 2024',
        source: PASSAGES.heritage,
      },
      conflict: false,
    },
    {
      domain: 'literature',
      why: 'a year its own quote doesn’t back takes no part',
      a: {
        text: 'The Salt Road won the Kilimanjaro Prize in 2024.',
        quote: 'and won it in 2024',
        source: PASSAGES.literature,
      },
      b: {
        text: 'The Salt Road won the Kilimanjaro Prize in 2022.',
        quote: 'and won it in 2024',
        source: PASSAGES.literature,
      },
      conflict: false,
    },
  ];
  it.each(cases.map((c) => [label(c), c] as const))('%s', (_, c) => {
    const statuses = checkedPair(c);
    if (c.conflict) expect(statuses).toEqual(['conflicting', 'conflicting']);
    else expect(statuses).not.toContain('conflicting');
  });

  it('flags a third source that disagrees with statements already flagged, across parts', () => {
    const won = (year: number): CheckedClaim => ({
      type: 'fact',
      text: `The Salt Road won the Kilimanjaro Prize in ${year}.`,
      sourceLabels: ['S1'],
      sourceArticleIds: ['source-1'],
      excerpt: null,
      citationStatus: 'verified',
    });
    const answer = [won(2024), won(2023)];
    flagConflicts(answer);
    const toConfirm = [won(2022)];
    flagConflicts([...answer, ...toConfirm]);
    expect([...answer, ...toConfirm].map((c) => c.citationStatus)).toEqual([
      'conflicting',
      'conflicting',
      'conflicting',
    ]);
  });
});

describe('which questions ask for an exact detail', () => {
  const cases: Array<[question: string, detail: 'date' | 'figure' | 'name' | null]> = [
    ['When did Salt and Memory open?', 'date'],
    ['Do we know when Studio Nwosu was founded?', 'date'],
    ['In what year was the Selwyn Library completed?', 'date'],
    ['What are the dates of Halden Design Week?', 'date'],
    ['Can you tell me when the Kora Dance Collective first performed?', 'date'],
    ['How many copies did Ember Season sell?', 'figure'],
    ['What was the hammer price of the tapestry?', 'figure'],
    ['What is the museum’s annual budget?', 'figure'],
    ['Who designed the Selwyn Library?', 'name'],
    ['Where will the Lawal prints go on view?', 'name'],
    ['Do you know who directed Rivers of Indigo?', 'name'],
    ['What is the name of the gallery that represents Ama Sefa?', 'name'],
    ['Is it a story for us when the market is down?', null],
    ['What does the record price say about the market for her work?', null],
    ['Why does this matter to our readers?', null],
    ['Should we commission a profile of the chef?', null],
  ];
  it.each(cases)('%s → %s', (question, detail) => {
    expect(detailAsked(question)).toBe(detail);
  });
});

interface JudgeCase {
  domain: string;
  why: string;
  /** Null for a judgement question. */
  question: string | null;
  evidence: Evidence;
  claims: CheckedClaim[];
  expected: { evidence: Evidence; check: EvidenceCheck | null };
}

const said = (
  text: string,
  citationStatus: CitationStatus = 'verified',
  type: ClaimType = 'fact',
): CheckedClaim => ({
  type,
  text,
  sourceLabels: type === 'fact' || type === 'attributed' ? ['S1'] : [],
  sourceArticleIds: type === 'fact' || type === 'attributed' ? ['source-1'] : [],
  excerpt: null,
  citationStatus,
});
const LOWERED = { evidence: 'partial', check: 'asked_detail_unchecked' } as const;
const NOTHING_CHECKED = { evidence: 'partial', check: 'no_checked_facts' } as const;
const STANDS = { evidence: 'sufficient', check: null } as const;

describe('a "sufficient" judgement stands only on checked evidence for what was asked', () => {
  const cases: JudgeCase[] = [
    // A related detail is not the answer.
    {
      domain: 'art',
      why: 'an announcement date for an opening date',
      question: 'When did Salt and Memory open?',
      evidence: 'sufficient',
      claims: [said('The Kuramo Art Centre announced Salt and Memory in January 2025.')],
      expected: LOWERED,
    },
    {
      domain: 'music',
      why: 'a recording date for a release date',
      question: 'When was Ember Season released?',
      evidence: 'sufficient',
      claims: [said('Lerato Dube recorded Ember Season in Johannesburg in 2021.')],
      expected: LOWERED,
    },
    {
      domain: 'literature',
      why: 'a shortlisting for a win',
      question: 'When did The Salt Road win the Kilimanjaro Prize?',
      evidence: 'sufficient',
      claims: [said('The Salt Road was shortlisted for the Kilimanjaro Prize in 2023.')],
      expected: LOWERED,
    },
    {
      domain: 'fashion',
      why: 'a founding date for an appointment',
      question: 'When was Chidi Nwosu appointed creative director of Maison Verlaine?',
      evidence: 'sufficient',
      claims: [said('Chidi Nwosu founded Studio Nwosu in 2016.')],
      expected: LOWERED,
    },
    {
      domain: 'architecture',
      why: 'an expansion date for a completion date',
      question: 'When was the Selwyn Library completed?',
      evidence: 'sufficient',
      claims: [said('The Selwyn Library was expanded with a reading garden in 2023.')],
      expected: LOWERED,
    },
    {
      domain: 'heritage',
      why: 'a date of taking for a date of return',
      question: 'When were the carved panels returned to Benin?',
      evidence: 'sufficient',
      claims: [said('The carved panels were taken from the palace at Abomey in 1892.')],
      expected: LOWERED,
    },
    {
      domain: 'design',
      why: 'a count of something else',
      question: 'How many visitors does Halden Design Week expect?',
      evidence: 'sufficient',
      claims: [said('Halden Design Week will show 300 objects.')],
      expected: LOWERED,
    },
    {
      domain: 'market',
      why: 'an estimate for a hammer price',
      question: 'What was the hammer price of the tapestry?',
      evidence: 'sufficient',
      claims: [said('The tapestry was estimated at £600,000 to £800,000.')],
      expected: LOWERED,
    },
    {
      domain: 'architecture',
      why: 'a place for a designer',
      question: 'Who designed the Selwyn Library?',
      evidence: 'sufficient',
      claims: [said('The Selwyn Library in Accra was completed in 2019.')],
      expected: LOWERED,
    },
    {
      domain: 'photography',
      why: 'an acquirer for a venue',
      question: 'Where will the Lawal prints go on view?',
      evidence: 'sufficient',
      claims: [said('The Ife Photography Trust acquired Lawal’s archive in 2023.')],
      expected: LOWERED,
    },
    {
      domain: 'architecture',
      why: 'an event in a descriptive aside is not the one asked about',
      question: 'Who leads Ofori Studio, the practice behind the expanded Selwyn Library?',
      evidence: 'sufficient',
      claims: [said('The Selwyn Library was expanded in 2023.')],
      expected: LOWERED,
    },
    {
      domain: 'design',
      why: 'a name about another subject than the one asked about',
      question: 'Who leads Ofori Studio?',
      evidence: 'sufficient',
      claims: [said('The Kuramo Art Centre is led by Kemi Bello.')],
      expected: LOWERED,
    },
    // Missing information, unchecked facts and disagreement.
    {
      domain: 'music',
      why: 'an answer that only says what isn’t known',
      question: 'Who produced Ember Season?',
      evidence: 'sufficient',
      claims: [
        said('The research doesn’t say who produced the album.', 'uncited', 'open_question'),
      ],
      expected: NOTHING_CHECKED,
    },
    {
      domain: 'food',
      why: 'a fact whose quote wasn’t found',
      question: 'When did Teranga Table open?',
      evidence: 'sufficient',
      claims: [said('Teranga Table opened in Brooklyn in 2019.', 'excerpt_not_located')],
      expected: NOTHING_CHECKED,
    },
    {
      domain: 'performance',
      why: 'a fact whose quote is about something else',
      question: 'When did the Kora Dance Collective first perform?',
      evidence: 'sufficient',
      claims: [said('The Kora Dance Collective first performed in 1987.', 'excerpt_unrelated')],
      expected: NOTHING_CHECKED,
    },
    {
      domain: 'film',
      why: 'sources that disagree',
      question: 'When did Rivers of Indigo premiere?',
      evidence: 'sufficient',
      claims: [
        said('Rivers of Indigo premiered in February 2024.', 'conflicting'),
        said('Rivers of Indigo premiered in March 2024.', 'conflicting'),
      ],
      expected: { evidence: 'partial', check: 'conflicting' },
    },
    {
      domain: 'food',
      why: 'a judgement answer resting on an unchecked fact',
      question: null,
      evidence: 'sufficient',
      claims: [
        said('Teranga Table opened in Brooklyn in 2019.', 'excerpt_not_located'),
        said('It fits our coverage of diaspora food.', 'uncited', 'analysis'),
      ],
      expected: NOTHING_CHECKED,
    },
    // Checked evidence for what was asked: the judgement stands.
    {
      domain: 'art',
      why: 'an opening date for an opening',
      question: 'When did Salt and Memory open?',
      evidence: 'sufficient',
      claims: [said('The Kuramo Art Centre opened Salt and Memory on 14 March 2025.')],
      expected: STANDS,
    },
    {
      domain: 'music',
      why: 'a release date for a release',
      question: 'When was Ember Season released?',
      evidence: 'sufficient',
      claims: [said('Ember Season was released on 9 June 2022.')],
      expected: STANDS,
    },
    {
      domain: 'literature',
      why: 'a win for a win',
      question: 'When did The Salt Road win the Kilimanjaro Prize?',
      evidence: 'sufficient',
      claims: [said('The Salt Road won the Kilimanjaro Prize in 2024.')],
      expected: STANDS,
    },
    {
      domain: 'fashion',
      why: '"named" for "appointed"',
      question: 'When was Chidi Nwosu appointed creative director of Maison Verlaine?',
      evidence: 'sufficient',
      claims: [said('Chidi Nwosu was named creative director of Maison Verlaine in January 2025.')],
      expected: STANDS,
    },
    {
      domain: 'heritage',
      why: 'a return date for a return',
      question: 'When were the carved panels returned to Benin?',
      evidence: 'sufficient',
      claims: [
        said(
          'The Rijkstad Museum returned 37 carved panels to the National Museum of Benin in March 2024.',
        ),
      ],
      expected: STANDS,
    },
    {
      domain: 'market',
      why: 'a sale price for a hammer price',
      question: 'What was the hammer price of the tapestry?',
      evidence: 'sufficient',
      claims: [said('Ama Sefa’s tapestry sold for £1.2 million at Corran’s.')],
      expected: STANDS,
    },
    {
      domain: 'design',
      why: 'a count of the thing asked about',
      question: 'How many visitors does Halden Design Week expect?',
      evidence: 'sufficient',
      claims: [said('The organisers expect 40,000 visitors.')],
      expected: STANDS,
    },
    {
      domain: 'architecture',
      why: 'a designer for a designer',
      question: 'Who designed the Selwyn Library?',
      evidence: 'sufficient',
      claims: [said('The Selwyn Library was designed by Mensah Ofori Architects.')],
      expected: STANDS,
    },
    {
      domain: 'photography',
      why: 'a venue for a venue',
      question: 'Where will the Lawal prints go on view?',
      evidence: 'sufficient',
      claims: [said('A selection of 80 Lawal prints goes on view in Ibadan on 3 May 2025.')],
      expected: STANDS,
    },
    {
      domain: 'architecture',
      why: 'a leader for a leader, whatever the aside mentions',
      question: 'Who leads Ofori Studio, the practice behind the expanded Selwyn Library?',
      evidence: 'sufficient',
      claims: [said('Ofori Studio is led by Efua Mensah.')],
      expected: STANDS,
    },
    {
      domain: 'art',
      why: 'names for a question about the story itself',
      question: 'Who are the key people behind this?',
      evidence: 'sufficient',
      claims: [said('Salt and Memory, a survey of Adaeze Obi, is curated by Kemi Bello.')],
      expected: STANDS,
    },
    {
      domain: 'food',
      why: 'a relative date the source gives',
      question: 'When did Teranga Table open?',
      evidence: 'sufficient',
      claims: [said('Teranga Table opened this week.')],
      expected: STANDS,
    },
    {
      domain: 'food',
      why: 'a judgement question answered with judgement',
      question: null,
      evidence: 'sufficient',
      claims: [said('It fits our coverage of diaspora food.', 'uncited', 'analysis')],
      expected: STANDS,
    },
    {
      domain: 'market',
      why: 'a question that mentions a price without asking one',
      question: 'What does the record price say about the market for her work?',
      evidence: 'sufficient',
      claims: [said('It suggests collectors are paying for provenance.', 'uncited', 'analysis')],
      expected: STANDS,
    },
    // Known limit: an event word used as the object of another verb ("agreed to return") reads as
    // that event. The quote is shown beside the statement for the editor to judge.
    {
      domain: 'heritage',
      why: 'known limit: an agreement to return reads as a return',
      question: 'When were the carved panels returned to Benin?',
      evidence: 'sufficient',
      claims: [said('The Rijkstad Museum agreed in 2022 to return the carved panels to Benin.')],
      expected: STANDS,
    },
    // Never raised.
    {
      domain: 'music',
      why: '"partial" is never raised, however well checked',
      question: 'When was Ember Season released?',
      evidence: 'partial',
      claims: [said('Ember Season was released on 9 June 2022.')],
      expected: { evidence: 'partial', check: null },
    },
    {
      domain: 'film',
      why: '"insufficient" stays insufficient when sources disagree',
      question: 'When did Rivers of Indigo premiere?',
      evidence: 'insufficient',
      claims: [said('Rivers of Indigo premiered in February 2024.', 'conflicting')],
      expected: { evidence: 'insufficient', check: 'conflicting' },
    },
  ];
  it.each(cases.map((c) => [label(c), c] as const))('%s', (_, c) => {
    expect(judgeEvidence({ evidence: c.evidence, claims: c.claims, question: c.question })).toEqual(
      c.expected,
    );
  });
});

/**
 * The three failure patterns the cross-story evaluation found on live output (2026-10-18), each
 * with the original case, a similar one, and a case that must still fail.
 */
describe('fixes from the cross-story evaluation', () => {
  const restoration =
    'Egypt on Sunday unveiled a restored version of "Tondo of the Two Brothers," a prized second-century painting from the famed Fayoum portraits. Specialists from Rome worked alongside conservators from the Egyptian Museum in Tahrir—where the collection is usually kept—for three weeks to restore the artwork, officials said at a press conference.';
  const check = (text: string, quote: string, source: string) => {
    const result = checkClaim(
      { type: 'fact', text, sources: ['S1'], excerpt: quote },
      new Map([['S1', { label: 'S1', id: 'source-1', text: source }]]),
    );
    return 'claim' in result ? result.claim.citationStatus : `dropped: ${result.dropped.reason}`;
  };
  const RESTORE_QUOTE =
    'Specialists from Rome worked alongside conservators from the Egyptian Museum in Tahrir—where the collection is usually kept—for three weeks to restore the artwork';

  describe('an event word inside a name is not the event asked about', () => {
    it.each([
      ['Art Auction East Africa', 'sale'],
      ['the Grand Reopening Festival', 'reopening'],
      ['the Kilimanjaro Prize Shortlist', 'nomination'],
    ])('"%s" names no %s', (name, kind) => {
      expect(eventsNamed(`When is ${name} this year?`).has(kind)).toBe(false);
    });
    it('keeps an event named in ordinary words, beside a name', () => {
      expect(
        eventsNamed('When did Art Auction East Africa sell the Msangi painting?').has('sale'),
      ).toBe(true);
      expect(eventsNamed('When was the Kilimanjaro Prize awarded?').has('award')).toBe(true);
    });
    it.each([
      {
        why: 'original (live M1): a checked date for a sale whose organiser is named "Art Auction…"',
        question:
          'When and where will this year’s Art Auction East Africa sale with Strauss & Co take place?',
        claim:
          'The live-virtual sale will take place on Wednesday, October 28, 2026, at 7pm EAT at Circle Art Gallery in Nairobi.',
        expected: STANDS,
      },
      {
        why: 'similar: a festival whose name says "Reopening"',
        question: 'When does the Grand Reopening Festival begin?',
        claim: 'The festival begins on 12 May 2026.',
        expected: STANDS,
      },
      {
        why: 'still fails: a sale date is not a founding date',
        question: 'When was Art Auction East Africa founded?',
        claim: 'Art Auction East Africa’s 2026 sale takes place on 28 October 2026.',
        expected: LOWERED,
      },
    ])('$why', ({ question, claim, expected }) => {
      expect(judgeEvidence({ evidence: 'sufficient', claims: [said(claim)], question })).toEqual(
        expected,
      );
    });
  });

  describe('numbers in words and in digits compare, but never stand in for the subject', () => {
    it('reads cardinal number words as digits, except "one" alone and words in a name', () => {
      expect(withDigits('It took three weeks and twenty-five days.')).toBe(
        'It took 3 weeks and 25 days.',
      );
      expect(withDigits('one of the Two Brothers. Three works came.')).toBe(
        'one of the Two Brothers. 3 works came.',
      );
    });
    it.each([
      {
        why: 'original (live H1): the quote calls the painting "the artwork", named just before',
        text: 'The restoration of the Tondo of the Two Brothers took three weeks.',
        quote: RESTORE_QUOTE,
        source: restoration,
        expected: 'verified',
      },
      {
        why: 'digits in the statement, words in the quote',
        text: 'The restoration of the Tondo of the Two Brothers took 3 weeks.',
        quote: RESTORE_QUOTE,
        source: restoration,
        expected: 'verified',
      },
      {
        why: 'words in the statement, digits in the quote',
        text: 'The restoration of the Tondo of the Two Brothers took three weeks.',
        quote: 'for 3 weeks to restore the artwork',
        source: restoration.replace('three weeks', '3 weeks'),
        expected: 'verified',
      },
      {
        why: 'a different number in words is now caught',
        text: 'The restoration of the Tondo of the Two Brothers took four weeks.',
        quote: RESTORE_QUOTE,
        source: restoration,
        expected: 'detail_not_in_excerpt',
      },
      {
        why: 'stays found: a quote naming no one that shares the statement’s substance (live)',
        text: 'Alisa LaGamma’s discussion at the Metropolitan Museum of Art intersects with ongoing debates over the politics of restitution.',
        quote:
          'This field is currently the subject of ongoing debate regarding the politics of restitution and the complex realities of repatriation',
        source:
          'Collections formed in the colonial era are being reconsidered. This field is currently the subject of ongoing debate regarding the politics of restitution and the complex realities of repatriation.',
        expected: 'verified',
      },
      {
        why: 'still fails: the same quantity in an unrelated passage',
        text: 'The restoration of the Tondo of the Two Brothers took three weeks.',
        quote: 'was assembled in three weeks by a local team',
        source: 'The giant Hoosier cabinet replica was assembled in three weeks by a local team.',
        expected: 'excerpt_unrelated',
      },
      {
        why: 'still fails: the same event and quantity for a different work named just before',
        text: 'The restoration of the Tondo of the Two Brothers took three weeks.',
        quote: 'Its restoration took three weeks',
        source:
          'Conservators also treated the mummy portrait of Artemidorus. Its restoration took three weeks.',
        expected: 'excerpt_unrelated',
      },
    ])('$why', ({ text, quote, source, expected }) => {
      expect(check(text, quote, source)).toBe(expected);
    });
    it('a duration in words answers "how long"', () => {
      expect(
        judgeEvidence({
          evidence: 'sufficient',
          claims: [said('The restoration of the Tondo of the Two Brothers took three weeks.')],
          question: 'How long did the restoration of the Tondo of the Two Brothers take?',
        }),
      ).toEqual(STANDS);
    });
  });

  describe('a "when" answer needs the year, unless the question or the date supplies it', () => {
    it.each([
      {
        why: 'original (live S1): "in the middle of July", no year',
        question:
          'When did Uthman Wahaab’s exhibition Alas, We Meet Again open at Windsor Gallery?',
        claim: 'Uthman Wahaab’s solo exhibition Alas, We Meet Again opened in the middle of July.',
        expected: LOWERED,
      },
      {
        why: 'original (live H2): "from November to May", no year',
        question: 'When will the Fayoum portraits be shown in Rome?',
        claim:
          'Egypt will lend a major part of the Fayoum portraits collection to an exhibition in Rome from November to May.',
        expected: LOWERED,
      },
      {
        why: 'a complete date',
        question: 'When did Uthman Wahaab’s exhibition open at Windsor Gallery?',
        claim: 'Uthman Wahaab’s exhibition opened at Windsor Gallery on 17 July 2026.',
        expected: STANDS,
      },
      {
        why: 'a month with its year is enough',
        question: 'When will the Fayoum portraits be shown in Rome?',
        claim: 'The Fayoum portraits will be shown in Rome from November 2026 to May 2027.',
        expected: STANDS,
      },
      {
        why: 'the question already gives the year',
        question: 'When in 2026 will the Fayoum portraits be shown in Rome?',
        claim: 'The Fayoum portraits will be shown in Rome from November.',
        expected: STANDS,
      },
      {
        why: 'the question asks only for the month',
        question: 'Which month does the Rome exhibition of the Fayoum portraits open?',
        claim: 'The Rome exhibition of the Fayoum portraits opens in November.',
        expected: STANDS,
      },
    ])('$why', ({ question, claim, expected }) => {
      expect(judgeEvidence({ evidence: 'sufficient', claims: [said(claim)], question })).toEqual(
        expected,
      );
    });

    it('a source that gives no year: the quote is found, the answer is still incomplete', () => {
      const source =
        'It is a heavily trafficked Friday in the middle of July, and the roads leading to Windsor Gallery are at a standstill. An hour later, a crowd of well-dressed guests makes its way into the gallery for the opening of Uthman Wahaab’s solo exhibition, Alas, We Meet Again.';
      const { claims } = checkClaims(
        [
          {
            type: 'fact',
            text: 'Uthman Wahaab’s solo exhibition Alas, We Meet Again opened in the middle of July.',
            sources: ['S1'],
            excerpt: source,
          },
        ],
        new Map([['S1', { label: 'S1', id: 'source-1', text: source }]]),
      );
      expect(claims.map((c) => c.citationStatus)).toEqual(['verified']);
      expect(
        judgeEvidence({
          evidence: 'sufficient',
          claims,
          question:
            'When did Uthman Wahaab’s exhibition Alas, We Meet Again open at Windsor Gallery?',
        }),
      ).toEqual(LOWERED);
    });
  });
});
