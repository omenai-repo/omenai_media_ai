import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getModels } from '../db/models.js';
import { getDraftsView } from '../drafts/queries.js';
import { requestDraft, runDraftGeneration } from '../drafts/service.js';
import { createFakeSearch, type FixtureArticle } from '../testing/discovery-fixtures.js';
import { createScriptedLlm, type ScriptHandler } from '../testing/fake-llm.js';
import { startTestDatabase, type TestDatabase } from '../testing/index.js';
import { promptSources } from '../testing/scenarios/research-script.js';
import { streamChatReply, type ChatEvent } from './chat.js';
import { getResearchView } from './queries.js';
import { postChatMessage, requestResearch, runResearch } from './service.js';

/**
 * The evidence-accuracy safeguards (ADR-039) on every surface that writes checked statements:
 * research briefs, chat replies, focused research and Content Studio drafts. Each scenario is a
 * different domain and kind of question, with invented subjects and fixture sources, and runs the
 * same failure patterns (an invented label or quote, a passage about something else, a detail its
 * quote doesn't give, sources that disagree, a related fact taken for the answer) and the same
 * passing cases through each surface. Scripted model answers prove that the shared checks are
 * applied, saved and reported the same way everywhere; they say nothing about how a real model
 * writes.
 */

interface Quoted {
  text: string;
  quote: string;
}
interface Passage {
  title: string;
  text: string;
}
interface Page extends Passage {
  url: string;
  snippet: string;
  statement: Quoted;
}

interface Scenario {
  domain: string;
  headline: string;
  entities: string[];
  primary: Passage;
  /** A second source that gives one detail differently. */
  second: Passage;
  /** Checked, and answers `answered`. */
  supported: Quoted;
  answered: string;
  /** Checked, but a different event or detail than `gap` asks for. */
  related: Quoted;
  /** An exact-detail question the saved research doesn't settle. */
  gap: string;
  /** A real passage from the primary source, about something else. */
  irrelevant: Quoted;
  /** A date or figure its quote doesn't give. */
  unsupported: Quoted;
  /** A quote no source contains. */
  fabricated: Quoted;
  /** `a` quotes the primary source, `b` the second, and they disagree. */
  conflict: { a: Quoted; b: Quoted; question: string };
  editorial: string;
  /** What focused research finds that settles `gap`. */
  answerPage: Page;
  /** What it finds that only comes close. */
  relatedPage: Page;
}

const SCENARIOS: Scenario[] = [
  {
    domain: 'music',
    headline: 'Lerato Dube’s Ember Season finds a global audience',
    entities: ['Lerato Dube', 'Ember Season'],
    primary: {
      title: 'Lerato Dube on the making of Ember Season',
      text: 'The singer Lerato Dube recorded her debut album, Ember Season, in Johannesburg in 2021. The album sold 120,000 copies in its first year. Dube called it “a love letter to the township”. Her autumn tour visits 14 cities. Tickets for the tour went on sale on Friday. (Fixture text.)',
    },
    second: {
      title: 'Ember Season tour dates announced',
      text: 'Lerato Dube’s autumn tour visits 11 cities, her label said. (Fixture text.)',
    },
    supported: {
      text: 'Ember Season sold 120,000 copies in its first year.',
      quote: 'The album sold 120,000 copies in its first year',
    },
    answered: 'How many copies did Ember Season sell in its first year?',
    related: {
      text: 'Lerato Dube recorded Ember Season in Johannesburg in 2021.',
      quote: 'recorded her debut album, Ember Season, in Johannesburg in 2021',
    },
    gap: 'When was Ember Season released?',
    irrelevant: {
      text: 'Ember Season was produced by an all-women team.',
      quote: 'Tickets for the tour went on sale on Friday',
    },
    unsupported: {
      text: 'Ember Season sold 150,000 copies in its first year.',
      quote: 'The album sold 120,000 copies in its first year',
    },
    fabricated: {
      text: 'Critics called Ember Season the debut of the decade.',
      quote: 'the debut of the decade',
    },
    conflict: {
      a: {
        text: 'Lerato Dube’s autumn tour visits 14 cities.',
        quote: 'Her autumn tour visits 14 cities',
      },
      b: {
        text: 'Lerato Dube’s autumn tour visits 11 cities.',
        quote: 'Lerato Dube’s autumn tour visits 11 cities',
      },
      question: 'How many cities does Lerato Dube’s autumn tour visit?',
    },
    editorial: 'Is Ember Season a good fit for our music coverage?',
    answerPage: {
      url: 'https://music-news.example/ember-season-release',
      title: 'Lerato Dube releases Ember Season',
      snippet: 'Lerato Dube releases her debut album Ember Season.',
      text: 'Lerato Dube released her debut album Ember Season on 9 June 2022, her label said. (Fixture text.)',
      statement: {
        text: 'Ember Season was released on 9 June 2022.',
        quote: 'Lerato Dube released her debut album Ember Season on 9 June 2022',
      },
    },
    relatedPage: {
      url: 'https://music-news.example/ember-season-studio',
      title: 'Inside the Ember Season sessions',
      snippet: 'Lerato Dube recorded Ember Season in Johannesburg.',
      text: 'Lerato Dube recorded Ember Season in Johannesburg in 2021 with a small band. (Fixture text.)',
      statement: {
        text: 'Lerato Dube recorded Ember Season in Johannesburg in 2021.',
        quote: 'Lerato Dube recorded Ember Season in Johannesburg in 2021',
      },
    },
  },
  {
    domain: 'architecture',
    headline: 'The Selwyn Library in Accra adds a reading garden',
    entities: ['Selwyn Library', 'Accra'],
    primary: {
      title: 'A new garden for the Selwyn Library',
      text: 'The Selwyn Library in Accra was completed in 2019. In 2023 the library was expanded with a reading garden. The building spans 4,200 square metres over three floors. The café is open daily from Monday. (Fixture text.)',
    },
    second: {
      title: 'Selwyn Library facts',
      text: 'The Selwyn Library spans 3,800 square metres over three floors, according to the city. (Fixture text.)',
    },
    supported: {
      text: 'The Selwyn Library in Accra was completed in 2019.',
      quote: 'The Selwyn Library in Accra was completed in 2019',
    },
    answered: 'When was the Selwyn Library completed?',
    related: {
      text: 'The Selwyn Library was expanded with a reading garden in 2023.',
      quote: 'In 2023 the library was expanded with a reading garden',
    },
    gap: 'Who designed the Selwyn Library?',
    irrelevant: {
      text: 'The Selwyn Library was designed by a Ghanaian practice.',
      quote: 'The café is open daily from Monday',
    },
    unsupported: {
      text: 'The Selwyn Library spans 5,000 square metres.',
      quote: 'The building spans 4,200 square metres over three floors',
    },
    fabricated: {
      text: 'The Selwyn Library has won a national design award.',
      quote: 'won the national design award',
    },
    conflict: {
      a: {
        text: 'The Selwyn Library spans 4,200 square metres over three floors.',
        quote: 'The building spans 4,200 square metres over three floors',
      },
      b: {
        text: 'The Selwyn Library spans 3,800 square metres over three floors.',
        quote: 'The Selwyn Library spans 3,800 square metres over three floors',
      },
      question: 'How big is the Selwyn Library?',
    },
    editorial: 'Would the library’s garden make a good photo essay for us?',
    answerPage: {
      url: 'https://architecture-news.example/selwyn-library-architects',
      title: 'The architects behind the Selwyn Library',
      snippet: 'Mensah Ofori Architects designed the Selwyn Library in Accra.',
      text: 'Mensah Ofori Architects designed the Selwyn Library in Accra, the practice confirmed. (Fixture text.)',
      statement: {
        text: 'The Selwyn Library was designed by Mensah Ofori Architects.',
        quote: 'Mensah Ofori Architects designed the Selwyn Library in Accra',
      },
    },
    relatedPage: {
      url: 'https://architecture-news.example/selwyn-garden',
      title: 'Selwyn Library garden opens',
      snippet: 'The Selwyn Library in Accra opens its reading garden.',
      text: 'The Selwyn Library in Accra opened its reading garden in 2023. (Fixture text.)',
      statement: {
        text: 'The Selwyn Library opened its reading garden in 2023.',
        quote: 'The Selwyn Library in Accra opened its reading garden in 2023',
      },
    },
  },
  {
    domain: 'heritage',
    headline: 'Rijkstad Museum returns carved panels to Benin',
    entities: ['Rijkstad Museum', 'Benin'],
    primary: {
      title: 'Carved panels go home',
      text: 'The Rijkstad Museum agreed in 2022 to return 37 carved panels to Benin. The panels had been taken from the palace at Abomey in 1892. The museum’s shop reopens after refurbishment next week. (Fixture text.)',
    },
    second: {
      title: 'Abomey panels: a history',
      text: 'The panels were taken from the palace at Abomey in 1894, according to colonial records. (Fixture text.)',
    },
    supported: {
      text: 'The Rijkstad Museum agreed in 2022 to return 37 carved panels to Benin.',
      quote: 'The Rijkstad Museum agreed in 2022 to return 37 carved panels to Benin',
    },
    answered: 'When did the Rijkstad Museum agree to return the panels?',
    related: {
      text: 'The panels were taken from the palace at Abomey in 1892.',
      quote: 'The panels had been taken from the palace at Abomey in 1892',
    },
    gap: 'When were the carved panels returned to Benin?',
    irrelevant: {
      text: 'The Rijkstad Museum apologised for the taking of the panels.',
      quote: 'The museum’s shop reopens after refurbishment next week',
    },
    unsupported: {
      text: 'The Rijkstad Museum agreed in 2021 to return 37 carved panels to Benin.',
      quote: 'The Rijkstad Museum agreed in 2022 to return 37 carved panels to Benin',
    },
    fabricated: {
      text: 'The panels will tour Benin’s regional museums.',
      quote: 'a tour of regional museums',
    },
    conflict: {
      a: {
        text: 'The panels were taken from the palace at Abomey in 1892.',
        quote: 'The panels had been taken from the palace at Abomey in 1892',
      },
      b: {
        text: 'The panels were taken from the palace at Abomey in 1894.',
        quote: 'The panels were taken from the palace at Abomey in 1894',
      },
      question: 'When were the panels taken from Abomey?',
    },
    editorial: 'Should this restitution lead our heritage newsletter?',
    answerPage: {
      url: 'https://heritage-news.example/panels-returned',
      title: 'Benin welcomes the Abomey panels home',
      snippet: 'The Rijkstad Museum returned the carved panels to Benin.',
      text: 'The Rijkstad Museum returned the 37 carved panels to Benin in March 2024, at a ceremony in Abomey. (Fixture text.)',
      statement: {
        text: 'The Rijkstad Museum returned the carved panels to Benin in March 2024.',
        quote: 'The Rijkstad Museum returned the 37 carved panels to Benin in March 2024',
      },
    },
    relatedPage: {
      url: 'https://heritage-news.example/panels-history',
      title: 'How the Abomey panels left Benin',
      snippet: 'The Rijkstad Museum panels were taken from Abomey.',
      text: 'The panels now at the Rijkstad Museum were taken from the palace at Abomey in 1892. (Fixture text.)',
      statement: {
        text: 'The panels were taken from the palace at Abomey in 1892.',
        quote: 'were taken from the palace at Abomey in 1892',
      },
    },
  },
  {
    domain: 'market',
    headline: 'Ama Sefa tapestry leads Corran’s London sale',
    entities: ['Ama Sefa', 'Corran’s'],
    primary: {
      title: 'Ama Sefa’s tapestry at Corran’s',
      text: 'A bottle-cap tapestry by Ama Sefa went under the hammer at Corran’s London sale on 12 October 2025, with an estimate of £600,000–£800,000. The previous auction record for the artist was £410,000, set in 2022. The viewing rooms open at 10am on weekdays. (Fixture text.)',
    },
    second: {
      title: 'Sefa’s market so far',
      text: 'The previous auction record for Ama Sefa was £450,000, set in 2022, according to a price database. (Fixture text.)',
    },
    supported: {
      text: 'Ama Sefa’s tapestry went under the hammer at Corran’s London sale on 12 October 2025.',
      quote:
        'A bottle-cap tapestry by Ama Sefa went under the hammer at Corran’s London sale on 12 October 2025',
    },
    answered: 'When was Ama Sefa’s tapestry auctioned at Corran’s?',
    related: {
      text: 'Ama Sefa’s tapestry was estimated at £600,000 to £800,000.',
      quote: 'with an estimate of £600,000–£800,000',
    },
    gap: 'What was the hammer price of Ama Sefa’s tapestry?',
    irrelevant: {
      text: 'Ama Sefa’s tapestry was bought by a museum in Lagos.',
      quote: 'The viewing rooms open at 10am on weekdays',
    },
    unsupported: {
      text: 'Ama Sefa’s tapestry was estimated at £700,000 to £900,000.',
      quote: 'with an estimate of £600,000–£800,000',
    },
    fabricated: {
      text: 'Bidding for the tapestry lasted twenty minutes.',
      quote: 'bidding lasted twenty minutes',
    },
    conflict: {
      a: {
        text: 'Ama Sefa’s previous auction record was £410,000, set in 2022.',
        quote: 'The previous auction record for the artist was £410,000, set in 2022',
      },
      b: {
        text: 'Ama Sefa’s previous auction record was £450,000, set in 2022.',
        quote: 'The previous auction record for Ama Sefa was £450,000, set in 2022',
      },
      question: 'What was Ama Sefa’s previous auction record?',
    },
    editorial: 'Is this sale a sign of a wider market story we should cover?',
    answerPage: {
      url: 'https://market-news.example/sefa-record',
      title: 'Ama Sefa tapestry sells for £1.2 million',
      snippet: 'Ama Sefa’s tapestry sold for £1.2 million at Corran’s.',
      text: 'Ama Sefa’s bottle-cap tapestry sold for £1.2 million at Corran’s on 12 October 2025, a record for the artist. (Fixture text.)',
      statement: {
        text: 'Ama Sefa’s tapestry sold for £1.2 million at Corran’s.',
        quote: 'Ama Sefa’s bottle-cap tapestry sold for £1.2 million at Corran’s',
      },
    },
    relatedPage: {
      url: 'https://market-news.example/sefa-estimate',
      title: 'Ama Sefa tapestry to lead Corran’s sale',
      snippet: 'Ama Sefa’s tapestry is estimated at £600,000 to £800,000.',
      text: 'Ama Sefa’s tapestry is estimated at £600,000 to £800,000 ahead of Corran’s sale. (Fixture text.)',
      statement: {
        text: 'Ama Sefa’s tapestry was estimated at £600,000 to £800,000.',
        quote: 'Ama Sefa’s tapestry is estimated at £600,000 to £800,000',
      },
    },
  },
];

let db: TestDatabase;

beforeAll(async () => {
  db = await startTestDatabase();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
});

const now = () => new Date();
const ANALYSIS = 'It shows how the story is still developing.';

/** A story with its two sources, as discovery would have stored them. */
async function createStory(s: Scenario): Promise<string> {
  const { Story, SourceArticle } = await getModels();
  const story = await Story.create({
    headline: s.headline,
    entities: s.entities,
    firstSeenRunKey: 'safeguards-test',
    lastCandidateRunKey: 'safeguards-test',
  });
  const articles = await SourceArticle.create(
    [s.primary, s.second].map((passage, i) => {
      const url = `https://${s.domain}-desk.example/source-${i + 1}`;
      return {
        canonicalUrl: url,
        url,
        host: `${s.domain}-desk.example`,
        publisher: `The ${s.domain} desk`,
        originalHeadline: passage.title,
        publishedAt: new Date(`2026-10-1${i + 1}T08:00:00Z`),
        retrievedAt: now(),
        origin: 'discovery' as const,
        snippet: passage.title,
        content: passage.text,
        extractionStatus: 'extracted' as const,
        storyIds: [story._id],
      };
    }),
  );
  await Story.updateOne(
    { _id: story._id },
    { $set: { sourceArticleIds: articles.map((article) => article._id) } },
  );
  return String(story._id);
}

/** The label a prompt gives a source, found by its headline: the model can only cite labels. */
function labelOf(prompt: string, title: string): string {
  const source = promptSources(prompt).find((p) => p.headline === title);
  if (!source) throw new Error(`No source "${title}" in the prompt`);
  return source.label;
}
const fact = (prompt: string, title: string, q: Quoted) => ({
  type: 'fact',
  text: q.text,
  sources: [labelOf(prompt, title)],
  excerpt: q.quote,
});
const OUTSIDE = {
  type: 'fact',
  text: 'A point that cites a source outside the research.',
  sources: ['S9'],
  excerpt: 'nothing',
};

/** A brief written with every failure pattern beside a statement its quote backs. */
const briefFor =
  (s: Scenario): ScriptHandler =>
  (prompt) => ({
    overview: [fact(prompt, s.primary.title, s.supported)],
    whyItMatters: [{ type: 'analysis', text: ANALYSIS, sources: [], excerpt: '' }],
    findings: [
      fact(prompt, s.primary.title, s.irrelevant),
      fact(prompt, s.primary.title, s.unsupported),
      fact(prompt, s.primary.title, s.conflict.a),
      fact(prompt, s.primary.title, s.fabricated),
      OUTSIDE,
    ],
    toConfirm: [fact(prompt, s.second.title, s.conflict.b)],
    background: [],
    peopleToApproach: [],
    verificationChecklist: ['Confirm the disputed detail with the organisation.'],
  });

/** A chat answer in the schema's key order. */
const answer = (fields: Record<string, unknown>) => ({
  assessment: 'sufficient',
  scope: 'about_story',
  statements: [],
  evidence: 'sufficient',
  researchQuestion: '',
  researchDepth: 'focused',
  ...fields,
});

/** The story with its saved research, and a scripted model for what follows. */
async function researched(
  s: Scenario,
  script: Partial<Record<'chat' | 'focused' | 'draft', ScriptHandler>>,
) {
  const storyId = await createStory(s);
  const model = createScriptedLlm({ research: briefFor(s), ...script });
  const { taskKey } = await requestResearch({ storyId, userId: 'editor-1', depth: 'standard' });
  await runResearch({
    taskKey,
    deps: { llm: model.llm, search: createFakeSearch([]).client, now },
  });
  async function ask(content: string) {
    const { taskKey: chatKey } = await postChatMessage({ storyId, userId: 'editor-1', content });
    const events: ChatEvent[] = [];
    const result = await streamChatReply({
      taskKey: chatKey,
      deps: { llm: model.llm, now },
      onEvent: (event) => events.push(event),
    });
    const { ChatMessage } = await getModels();
    const reply = (await ChatMessage.findById(result.messageId).lean())!;
    return { ...result, events, reply };
  }
  return { storyId, model, ask };
}

const pageHit = (page: Page): FixtureArticle => ({
  url: page.url,
  title: page.title,
  snippet: page.snippet,
  publishedDate: 'Thu, 15 Oct 2026 08:00:00 GMT',
  score: 0.9,
  content: page.text,
  images: [],
});

const statuses = (claims: ReadonlyArray<{ text: string; citationStatus: string }>) =>
  Object.fromEntries(claims.map((c) => [c.text, c.citationStatus]));

describe.each(SCENARIOS)('$domain', (s) => {
  it('research brief: each failure is flagged where it stands; a disputed detail is settled nowhere', async () => {
    const { storyId } = await researched(s, {});
    const brief = (await getResearchView(storyId)).briefs.at(-1)!;
    expect(statuses(brief.sections.flatMap((section) => section.claims))).toEqual({
      [s.supported.text]: 'verified',
      [ANALYSIS]: 'uncited',
      [s.irrelevant.text]: 'excerpt_unrelated',
      [s.unsupported.text]: 'detail_not_in_excerpt',
      [s.conflict.a.text]: 'conflicting',
      [s.fabricated.text]: 'excerpt_not_located',
      [s.conflict.b.text]: 'conflicting',
    });
    expect(brief.droppedClaims).toBe(1);
    expect(brief.counts).toEqual({ verified: 1, unconfirmed: 5, uncited: 1 });
  });

  it('chat: a checked answer to the question stands, with no research', async () => {
    const h = await researched(s, {
      chat: (prompt) => answer({ statements: [fact(prompt, s.primary.title, s.supported)] }),
    });
    const { reply, followUp } = await h.ask(s.answered);
    expect(statuses(reply.claims ?? [])).toEqual({ [s.supported.text]: 'verified' });
    expect(reply).toMatchObject({
      assessment: 'sufficient',
      evidence: 'sufficient',
      evidenceCheck: null,
    });
    expect(followUp).toBeNull();
  });

  it('chat: a related detail is not the answer; research starts, and nothing streams as checked', async () => {
    const h = await researched(s, {
      chat: (prompt) => answer({ statements: [fact(prompt, s.primary.title, s.related)] }),
    });
    const { reply, followUp, events } = await h.ask(s.gap);
    // The statement's own quote is fine: it is the answer to the question that isn't.
    expect(statuses(reply.claims ?? [])).toEqual({ [s.related.text]: 'verified' });
    expect(reply).toMatchObject({
      assessment: 'needs_research',
      evidence: 'partial',
      evidenceCheck: 'asked_detail_unchecked',
      suggestedFocus: s.gap,
      followUp: { status: 'started', question: s.gap },
    });
    expect(followUp?.taskKey).toBeTruthy();
    // Until the checks finish, the stream carries text only: no status, quote or claim.
    const types = events.map((e) => e.type);
    const checking = types.indexOf('checking');
    expect(types.indexOf('text')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('text')).toBeLessThan(checking);
    expect(checking).toBeLessThan(types.indexOf('done'));
    for (const event of events.slice(0, checking))
      expect(JSON.stringify(event)).not.toMatch(/citationStatus|verified|excerpt|claims/);
  });

  it('chat: a judgement question is answered with judgement, not held to the detail rule', async () => {
    const h = await researched(s, {
      chat: () =>
        answer({
          scope: 'editorial',
          statements: [{ type: 'analysis', text: ANALYSIS, sources: [], excerpt: '' }],
        }),
    });
    const { reply, followUp } = await h.ask(s.editorial);
    expect(reply).toMatchObject({
      assessment: 'sufficient',
      evidence: 'sufficient',
      evidenceCheck: null,
    });
    expect(followUp).toBeNull();
  });

  it('chat: sources that disagree settle nothing, so the question is researched', async () => {
    const h = await researched(s, {
      chat: (prompt) =>
        answer({
          statements: [
            fact(prompt, s.primary.title, s.conflict.a),
            fact(prompt, s.second.title, s.conflict.b),
          ],
        }),
    });
    const { reply, followUp } = await h.ask(s.conflict.question);
    expect(statuses(reply.claims ?? [])).toEqual({
      [s.conflict.a.text]: 'conflicting',
      [s.conflict.b.text]: 'conflicting',
    });
    expect(reply).toMatchObject({
      assessment: 'needs_research',
      evidence: 'partial',
      evidenceCheck: 'conflicting',
    });
    expect(followUp?.taskKey).toBeTruthy();
  });

  it('chat: invented labels are removed and invented or misplaced quotes stay unconfirmed', async () => {
    const h = await researched(s, {
      chat: (prompt) =>
        answer({
          statements: [
            OUTSIDE,
            fact(prompt, s.primary.title, s.fabricated),
            fact(prompt, s.primary.title, s.irrelevant),
            fact(prompt, s.primary.title, s.unsupported),
          ],
        }),
    });
    const { reply, followUp } = await h.ask(s.answered);
    expect(statuses(reply.claims ?? [])).toEqual({
      [s.fabricated.text]: 'excerpt_not_located',
      [s.irrelevant.text]: 'excerpt_unrelated',
      [s.unsupported.text]: 'detail_not_in_excerpt',
    });
    expect(reply.droppedClaims).toBe(1);
    // Nothing it says was checked: not a sufficient answer, whatever the model judged.
    expect(reply).toMatchObject({
      assessment: 'needs_research',
      evidence: 'partial',
      evidenceCheck: 'no_checked_facts',
    });
    expect(followUp?.taskKey).toBeTruthy();
  });

  it.each([
    ['a page that only comes close: the evidence is lowered and the reason kept', 'related'],
    ['the page that settles it: the evidence stands', 'answer'],
  ] as const)('focused research, %s', async (_, found) => {
    const page = found === 'answer' ? s.answerPage : s.relatedPage;
    const h = await researched(s, {
      chat: (prompt) => answer({ statements: [fact(prompt, s.primary.title, s.related)] }),
      focused: (prompt) => ({
        answer: [fact(prompt, page.title, page.statement)],
        evidence: 'sufficient',
        toConfirm: [],
        nextSteps: [],
      }),
    });
    const { followUp } = await h.ask(s.gap);
    await runResearch({
      taskKey: followUp!.taskKey,
      deps: { llm: h.model.llm, search: createFakeSearch([pageHit(page)]).client, now },
    });
    const { ResearchBrief } = await getModels();
    const brief = (await ResearchBrief.findOne({ taskId: followUp!.taskKey }).lean())!;
    expect(brief.focus).toBe(s.gap);
    expect(statuses(brief.sections.flatMap((section) => section.claims))).toEqual({
      [page.statement.text]: 'verified',
    });
    expect({ evidence: brief.evidence, check: brief.evidenceCheck }).toEqual(
      found === 'answer'
        ? { evidence: 'sufficient', check: null }
        : { evidence: 'partial', check: 'asked_detail_unchecked' },
    );
  });

  it('focused research: an answer its open points contradict settles nothing', async () => {
    const h = await researched(s, {
      chat: (prompt) => answer({ statements: [fact(prompt, s.primary.title, s.related)] }),
      focused: (prompt) => ({
        answer: [fact(prompt, s.primary.title, s.conflict.a)],
        evidence: 'sufficient',
        toConfirm: [fact(prompt, s.second.title, s.conflict.b)],
        nextSteps: ['Ask the organisation which figure is right.'],
      }),
    });
    const { followUp } = await h.ask(s.gap);
    await runResearch({
      taskKey: followUp!.taskKey,
      deps: { llm: h.model.llm, search: createFakeSearch([]).client, now },
    });
    const { ResearchBrief } = await getModels();
    const brief = (await ResearchBrief.findOne({ taskId: followUp!.taskKey }).lean())!;
    expect(statuses(brief.sections.flatMap((section) => section.claims))).toEqual({
      [s.conflict.a.text]: 'conflicting',
      [s.conflict.b.text]: 'conflicting',
    });
    expect({ evidence: brief.evidence, check: brief.evidenceCheck }).toEqual({
      evidence: 'partial',
      check: 'conflicting',
    });
  });

  it('draft: each statement is checked as research is, and the research it draws on carries its doubts', async () => {
    const h = await researched(s, {
      draft: (prompt) => ({
        title: 'A draft',
        body: 'A first paragraph of the draft.',
        claims: [
          fact(prompt, s.primary.title, s.supported),
          fact(prompt, s.primary.title, s.irrelevant),
          fact(prompt, s.primary.title, s.unsupported),
          fact(prompt, s.primary.title, s.conflict.a),
          fact(prompt, s.second.title, s.conflict.b),
          fact(prompt, s.primary.title, s.fabricated),
          OUTSIDE,
        ],
      }),
    });
    const { taskKey } = await requestDraft({
      storyId: h.storyId,
      userId: 'editor-1',
      format: 'newsletter_item',
    });
    await runDraftGeneration({ taskKey, deps: { llm: h.model.llm, now } });
    const [version] = (await getDraftsView(h.storyId)).formats.newsletter_item.versions;
    expect(statuses(version!.claims)).toEqual({
      [s.supported.text]: 'verified',
      [s.irrelevant.text]: 'excerpt_unrelated',
      [s.unsupported.text]: 'detail_not_in_excerpt',
      [s.conflict.a.text]: 'conflicting',
      [s.conflict.b.text]: 'conflicting',
      [s.fabricated.text]: 'excerpt_not_located',
    });
    expect(version!.droppedClaims).toBe(1);
    // The draft is written from the research as checked: only checked statements read as checked.
    const prompt = h.model.calls.find((c) => c.operation === 'draft')!.prompt;
    expect(prompt).toMatch(new RegExp(`\\[checked: S\\d+\\] ${literal(s.supported.text)}`));
    expect(prompt).toContain(
      `[unconfirmed: the quoted passage isn’t about this statement: S1] ${s.irrelevant.text}`.replace(
        ': S1]',
        `: ${labelOf(prompt, s.primary.title)}]`,
      ),
    );
    expect(prompt).toMatch(new RegExp(`\\[unsettled: [^\\]]+\\] ${literal(s.conflict.a.text)}`));
    expect(prompt).toMatch(new RegExp(`\\[unsettled: [^\\]]+\\] ${literal(s.conflict.b.text)}`));
  });
});

function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
