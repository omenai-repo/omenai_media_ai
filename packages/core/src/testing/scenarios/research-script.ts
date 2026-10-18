/**
 * DEVELOPMENT FIXTURES ONLY. Scripted research, focused-answer and chat answers for the workspace,
 * built from each prompt (the story's own headline, focus and numbered sources), so different
 * stories and questions get different, plausible responses. Nothing here is real reporting, and
 * the fake search results live on reserved `.example` domains.
 */
import type { StoryDoc } from '../../db/models/story.js';
import { sameQuestion } from '../../research/follow-up.js';
import type { SearchClient, SearchHit } from '../../search/types.js';

interface PromptSource {
  label: string;
  headline: string;
  /** The first plain sentence of the stored text: present word for word in the source. */
  line: string;
}

function field(prompt: string, name: string): string {
  return new RegExp(`^${name}: (.*)$`, 'm').exec(prompt)?.[1]?.trim() ?? '';
}

export function promptSources(prompt: string): PromptSource[] {
  const list = (prompt.split('SOURCES:\n')[1] ?? '')
    .split('\n\nCONVERSATION SO FAR:')[0]!
    .split('\n\nQUESTION:')[0]!;
  if (!list.trim()) return [];
  return list.split('\n---\n').map((block) => {
    const [header = '', ...rest] = block.split('\n');
    const [label = '', , , headline = ''] = header.split(' | ');
    const line =
      rest
        .find((l) => l.trim() && !/^[#![]/.test(l.trim()))
        ?.trim()
        .replace(/\s+/g, ' ') ?? '';
    return { label: label.trim(), headline: headline.trim(), line };
  });
}

/** A short excerpt of a source's first sentence (always found in its stored text). */
const quote = (source: PromptSource, chars = 80) => source.line.slice(0, chars).trim();

/** A source's first sentence, without the fixture marker, as a claim. */
const sentence = (source: PromptSource) => `${source.line.split(' (')[0]!.replace(/\.$/, '')}.`;

/** A stable number per story, so each one gets its own shape of brief. */
function variant(text: string, count: number): number {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % count;
}

type ScriptedClaim = { type: string; text: string; sources: string[]; excerpt: string };
const fact = (text: string, source: PromptSource, chars = 80): ScriptedClaim => ({
  type: 'fact',
  text,
  sources: [source.label],
  excerpt: quote(source, chars),
});
const analysis = (text: string): ScriptedClaim => ({
  type: 'analysis',
  text,
  sources: [],
  excerpt: '',
});
const openQuestion = (text: string, source?: PromptSource): ScriptedClaim => ({
  type: 'open_question',
  text,
  sources: source ? [source.label] : [],
  excerpt: '',
});
/** Marks scripted text as invented wherever an editor might read it. */
const MARKER = ' (Invented fixture content.)';

/**
 * A brief in the concise format. Three shapes by story: a short one (everything checks out, no
 * background), and two fuller ones, one with a quote that can't be found in its source.
 */
export function scriptedResearchBrief(prompt: string) {
  const headline = field(prompt, 'HEADLINE');
  // The demonstration story gets the complex brief: every kind of caveat, people, background.
  if (/Lagos Biennale/.test(headline)) return biennaleBrief(prompt);
  const sources = promptSources(prompt);
  const own = sources.filter(
    (s) => !s.headline.startsWith('Background:') && !s.headline.includes(': a closer look'),
  );
  const found = sources.filter((s) => !own.includes(s));
  const first = sources[0]!;
  const second = sources[1] ?? first;
  const shape = variant(headline, 3);

  const overview = [fact(`${sentence(first).replace(/\.$/, '')}.${MARKER}`, first)];
  const whyItMatters = [
    analysis(
      shape === 2
        ? 'It shows a local institution setting its own terms for how this history is told, which is the kind of story Omenai’s readers come to us for.'
        : 'It is a concrete, current example of the cultural shift Omenai covers, not a trend piece.',
    ),
  ];
  const findings =
    second !== first
      ? [fact('A second report confirms the main details.', second, 60)]
      : ([] as ScriptedClaim[]);
  if (shape === 1)
    findings.push({
      type: 'attributed',
      text: 'The organisers say attendance has exceeded their expectations.',
      sources: [first.label],
      // Deliberately not in the stored text: shows the "couldn't be found" warning.
      excerpt: 'attendance has exceeded every expectation so far',
    });
  const toConfirm = [
    openQuestion('It isn’t yet clear who the key people are, or whether they will speak to us.'),
    ...(shape !== 0
      ? [openQuestion('The dates in the reports may not be current.', first)]
      : ([] as ScriptedClaim[])),
  ];
  // The short shape stops here; the fuller ones keep background for "More detail".
  const background = shape === 0 ? [] : found.slice(0, 2).map((s) => fact(`${s.headline}.`, s, 70));
  return {
    overview,
    whyItMatters,
    findings,
    toConfirm,
    background,
    peopleToApproach: [],
    verificationChecklist: [
      'Confirm the key dates and names with the organisers.',
      ...(shape !== 2 ? ['Ask for images whose rights can be cleared.'] : []),
    ],
  };
}

const OFF_TOPIC =
  /linux|server|password|recipe|weather|football|stock market|javascript|python|excel|holiday|horoscope/i;
const LEAD =
  /who (owns|funded|else)|collector|history of|earlier|influence|similar|compare|related/i;
const EDITORIAL = /omenai|our (readers|audience)|focus on|angle|suit|fit for|worth covering/i;

/**
 * A focused follow-up (a lead): the answer to the editor's question, never a new brief. The
 * fixture sources never settle a lead, so it says so first and gives the closest source.
 */
export function scriptedFocusedAnswer(prompt: string) {
  const focus = field(prompt, 'FOCUS');
  const sources = promptSources(prompt);
  const found = sources.filter(
    (s) => s.headline.startsWith('Background:') || s.headline.includes(': a closer look'),
  );
  const lead = found[0] ?? sources[0]!;
  return {
    answer: [
      openQuestion(`The new sources don’t establish this directly.${MARKER}`),
      {
        type: 'attributed',
        text: `The closest is “${lead.headline}”, which covers related ground but not this question.`,
        sources: [lead.label],
        excerpt: quote(lead, 60),
      },
    ],
    evidence: 'insufficient',
    toConfirm: [openQuestion('A primary source would have to answer this directly.')],
    nextSteps: [`Ask the organisers: ${focus.slice(0, 150)}`],
  };
}

/** Follow-up briefs in a chat prompt: the question each researched, and its first found point. */
export function promptFollowUps(prompt: string): Array<{
  question: string;
  evidence: string;
  found: { text: string; label: string; quote: string } | null;
}> {
  return prompt.split(/\n(?=BRIEF \d{4}-\d{2}-\d{2})/).flatMap((block) => {
    const header =
      /^BRIEF \S+ \(follow-up question: (.*); its sources answered it: ([^)]*)\):/m.exec(block);
    if (!header) return [];
    const point =
      /^- \((?:fact|attributed), quote found\) (.*?) \[(S\d+)[^\]]*\] Quote: "(.*)"$/m.exec(block);
    return [
      {
        question: header[1]!,
        evidence: header[2]!,
        found: point ? { text: point[1]!, label: point[2]!, quote: point[3]! } : null,
      },
    ];
  });
}

const BROAD = /in depth|in-depth|broader|wider look|dig deeper|investigate/i;

/** A chat answer as checked statements, with what the saved research means for the question. */
export function scriptedChatReply(prompt: string) {
  const question = field(prompt, 'QUESTION');
  const sources = promptSources(prompt);
  const first = sources[0]!;
  const second = sources[1] ?? first;
  const answer = (fields: {
    assessment: 'sufficient' | 'needs_research' | 'out_of_scope';
    scope?: 'about_story' | 'editorial' | 'related';
    statements: ScriptedClaim[];
    evidence: 'sufficient' | 'partial' | 'insufficient';
    researchQuestion?: string;
  }) => ({
    scope: 'about_story',
    researchQuestion: '',
    researchDepth: BROAD.test(question) ? 'broad' : 'focused',
    ...fields,
  });
  if (OFF_TOPIC.test(question))
    return answer({
      assessment: 'out_of_scope',
      statements: [analysis('That’s outside this workspace.')],
      evidence: 'insufficient',
    });
  // Research on this question already ran: answer from what it found, never ask again.
  const earlier = promptFollowUps(prompt).find((f) => sameQuestion(f.question, question));
  if (earlier)
    return answer({
      assessment: 'sufficient',
      statements: earlier.found
        ? [
            {
              type: 'fact',
              text: `${earlier.found.text}${MARKER}`,
              sources: [earlier.found.label],
              excerpt: earlier.found.quote,
            },
          ]
        : [
            openQuestion(
              `Omenai already looked into this, and its sources didn’t settle it.${MARKER}`,
            ),
          ],
      evidence: earlier.found ? 'sufficient' : 'insufficient',
    });
  if (EDITORIAL.test(question))
    return answer({
      assessment: 'sufficient',
      scope: 'editorial',
      statements: [
        analysis(
          `Yes, largely: it is a specific, current story about who shapes how this culture is shown, which sits squarely in Omenai’s territory.${MARKER}`,
        ),
        fact(`${sentence(first)}`, first, 200),
        analysis('The angle would be stronger with a named voice from the institution itself.'),
      ],
      evidence: 'partial',
    });
  if (/visitor|attendance|how many|figure/i.test(question))
    return answer({
      assessment: 'needs_research',
      statements: [
        openQuestion(`None of the saved sources gives a confirmed visitor figure.${MARKER}`),
        analysis(
          'One estimate circulates, but it isn’t in our stored copy of any source, so treat it as unconfirmed.',
        ),
      ],
      evidence: 'partial',
      researchQuestion: 'What visitor figures have the organisers published so far?',
    });
  if (LEAD.test(question))
    return answer({
      assessment: 'needs_research',
      scope: 'related',
      statements: [
        analysis(`The saved research doesn’t cover that.${MARKER}`),
        {
          type: 'attributed',
          text: `The closest is “${second.headline}”, which doesn’t answer it.`,
          sources: [second.label],
          excerpt: quote(second, 60),
        },
      ],
      evidence: 'insufficient',
      researchQuestion: question.slice(0, 180),
    });
  const said = sentence(first).replace(/\.$/, '');
  return answer({
    assessment: 'sufficient',
    statements: [
      fact(
        `The reporting says ${said.charAt(0).toLowerCase()}${said.slice(1)}.${MARKER}`,
        first,
        200,
      ),
      ...(second !== first
        ? [fact('A second report agrees, and I found nothing that contradicts it.', second, 50)]
        : []),
      // S19 isn't a source in this research: the checks drop this statement and say so.
      {
        type: 'fact',
        text: 'A sequel exhibition is rumoured.',
        sources: ['S19'],
        excerpt: 'a sequel',
      },
    ],
    evidence: 'sufficient',
  });
}

/**
 * Search results for research on a story: two relevant background pieces naming the story's
 * people or institutions, a near miss sharing only the city, and an unrelated generic list.
 */
export function researchResultsFor(story: Pick<StoryDoc, 'headline' | 'entities' | 'geography'>) {
  const name = story.entities?.[0] ?? story.headline.split(/\s+/).slice(0, 3).join(' ');
  const city = story.geography?.[0]?.city ?? story.geography?.[0]?.country ?? 'the city';
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const page = (url: string, title: string, sentence: string) => ({
    url,
    title,
    snippet: sentence,
    publishedDate: 'Mon, 05 Oct 2026 08:00:00 GMT',
    score: 0.8,
    content: `# ${title}\n\n${sentence}\n\n${sentence} (Development fixture text.)`,
  });
  return [
    page(
      `https://culture-archive.example/${slug}-closer-look`,
      `${name}: a closer look`,
      `Archive material shows how ${name} took shape over the past decade in ${city}.`,
    ),
    page(
      `https://arts-background.example/${slug}-background`,
      `Background: ${name} and its critics`,
      `Critics have followed ${name} closely, with mixed early reviews.`,
    ),
    page(
      `https://city-news.example/${slug}-traffic`,
      `${city} traffic: new bus lanes open`,
      `New bus lanes open across ${city} this week.`,
    ),
    page(
      `https://weekend-lists.example/${slug}-ten-shows`,
      'Ten exhibitions to see this autumn',
      'A list of ten exhibitions, one line each.',
    ),
  ];
}

/** A fake search serving the given results; extraction returns their stored text. */
export function fixtureResearchSearch(
  results: ReturnType<typeof researchResultsFor>,
  onCall?: (kind: 'search' | 'extract') => Promise<void>,
): SearchClient {
  return {
    async search() {
      await onCall?.('search');
      return results.map(({ content: _content, ...hit }): SearchHit => hit);
    },
    async extract(urls) {
      await onCall?.('extract');
      const pages = results
        .filter((r) => urls.includes(r.url))
        .map((r) => ({ url: r.url, title: r.title, content: r.content, images: [] }));
      return { pages, failed: [] };
    },
  };
}

function biennaleBrief(prompt: string) {
  const sources = promptSources(prompt);
  // By headline, not position: sources are listed newest first, so the social post leads.
  const pick = (pattern: RegExp, fallback: number) =>
    sources.find((s) => pattern.test(s.headline)) ?? sources[fallback] ?? sources[0]!;
  const first = pick(/^After ten years/, 0);
  const second = pick(/opens with a floating gallery/, 1);
  const guide = pick(/^What to see first/, 2);
  const social = pick(/^Photos:/, sources.length - 1);
  const found = pick(/: a closer look/, 0);
  const critics = pick(/^Background:/, 0);
  return {
    overview: [
      fact(
        'The first Lagos Biennale of Textile Art has opened across eleven venues, from former colonial-era warehouses to a floating gallery on the lagoon.',
        first,
        90,
      ),
      fact(
        `Reviews of the opening weekend single out the floating gallery as its centrepiece.${MARKER}`,
        second,
        60,
      ),
    ],
    whyItMatters: [
      analysis(
        'For Omenai’s readers, it treats weaving as contemporary practice rather than heritage craft, which is exactly the shift we cover, and it puts Lagos at the centre of that conversation.',
      ),
    ],
    findings: [
      fact('A specialist guide already maps the venues and the main commissions.', guide, 60),
      {
        type: 'attributed',
        text: 'The organisers say they expect 200,000 visitors over six weeks.',
        sources: [second.label],
        // Not in the stored text: the "couldn't be matched" warning in the main reply.
        excerpt: 'expect 200,000 visitors over six weeks',
      },
      // Cites a source that isn't in the brief, so the checks leave it out.
      {
        type: 'fact',
        text: 'Tickets sold out on the first day.',
        sources: ['S12'],
        excerpt: 'tickets sold out',
      },
      fact('Archive material shows the project took shape over a decade of planning.', found, 80),
    ],
    toConfirm: [
      openQuestion(
        'It isn’t yet clear whether this really is the first textile biennale in West Africa, as the organisers claim.',
      ),
      openQuestion(
        'The social posts of queues at the floating gallery haven’t been dated or traced to this event.',
        social,
      ),
    ],
    background: [
      fact('Critics have followed the project closely, with mixed early reviews.', critics, 70),
      {
        type: 'attributed',
        text: 'The organisers say each venue will host its own programme of talks.',
        sources: [first.label],
        // Not in the stored text either: a caveat that sits behind "More detail".
        excerpt: 'a programme of talks at every venue',
      },
      analysis(
        'Pairing established weavers with younger artists could give us a generational angle.',
      ),
    ],
    peopleToApproach: [
      {
        name: 'Funmilayo Adeyemi',
        role: 'Artistic director (fictional)',
        why: 'Named as the organiser in the official announcement.',
        sources: [first.label],
      },
    ],
    verificationChecklist: [
      'Ask the organisers for the source of the “first in West Africa” claim.',
      'Ask how the 200,000 visitor forecast was reached.',
      'Clear rights for any installation photographs before use.',
    ],
  };
}
