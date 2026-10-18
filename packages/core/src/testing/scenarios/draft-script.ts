/**
 * DEVELOPMENT FIXTURES ONLY. Scripted draft answers for the content studio, built from each
 * prompt (the story's headline, its checked research lines, the editor's instructions and the
 * numbered sources), so every story and format gets a different, plausible draft. The text is
 * invented and says so; it proves nothing about how a real model writes.
 */
import { promptSources } from './research-script.js';

const MARKER = '(Invented fixture content.)';

function field(prompt: string, name: string): string {
  return new RegExp(`^${name}: (.*)$`, 'm').exec(prompt)?.[1]?.trim() ?? '';
}

function block(prompt: string, heading: string): string {
  const start = prompt.indexOf(`${heading}`);
  if (start < 0) return '';
  const rest = prompt.slice(start).split('\n').slice(1).join('\n');
  return rest.split('\n\n')[0] ?? '';
}

/** "- [checked: S1] text" lines from the research block. */
function researchLines(prompt: string) {
  return block(prompt, 'RESEARCH (')
    .split('\n')
    .map((line) => /^- \[([^\]]+)\] (.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => ({ tag: m[1]!, text: m[2]!.replace(` ${MARKER}`, '').trim() }));
}

const FILLER = [
  'For Omenai’s readers, the interest lies less in the announcement than in who gets to shape how this history is told, and on whose terms.',
  'It is also a story about materials and places: the rooms, objects and working habits that make the work possible.',
  'What happens next will show whether this is a single moment or the start of something that lasts.',
  'The people closest to it describe a practice built over years rather than a sudden arrival.',
  'Seen from here, it connects to a wider pattern of institutions and makers setting their own terms.',
  'There is pleasure in it too, and ambition, which is easy to miss if the story is told only as a response to scarcity.',
];

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Joins sentences into paragraphs until the text reaches `target` words. */
function writeTo(target: number, lead: string[], perParagraph: number): string {
  const sentences = [...lead];
  for (let i = 0; words(sentences.join(' ')) < target; i += 1)
    sentences.push(FILLER[i % FILLER.length]!);
  const paragraphs: string[] = [];
  for (let i = 0; i < sentences.length; i += perParagraph)
    paragraphs.push(sentences.slice(i, i + perParagraph).join(' '));
  return paragraphs.join('\n\n');
}

export function scriptedDraft(prompt: string) {
  const format = field(prompt, 'FORMAT');
  const headline = field(prompt, 'HEADLINE');
  const sources = promptSources(prompt);
  const first = sources[0]!;
  const second = sources[1] ?? first;
  const research = researchLines(prompt);
  const checked = research.filter((r) => r.tag.startsWith('checked')).map((r) => r.text);
  const analysis = research.filter((r) => r.tag === 'analysis').map((r) => r.text);
  const instructions = /"""\n([\s\S]*?)\n"""/.exec(prompt)?.[1]?.trim() ?? '';
  const revising = prompt.includes('CURRENT DRAFT (version');
  const tooLong = prompt.includes('\nTOO LONG:');

  const lead = checked[0] ?? `${first.line.split(' (')[0]}.`;
  const note = instructions
    ? ` Written to the editor’s note: “${instructions.slice(0, 120).replace(/[.!?]+$/, '')}”. ${MARKER}`
    : ` ${MARKER}`;
  const claims = [
    {
      type: 'fact',
      text: lead,
      sources: [first.label],
      excerpt: first.line.slice(0, 80).trim(),
    },
    // Cites a real source, but the quoted passage isn't in it: shown as "not found".
    {
      type: 'attributed',
      text: 'Organisers describe it as the first of several such projects.',
      sources: [second.label],
      excerpt: 'the first of several such projects planned for the coming years',
    },
    {
      type: 'analysis',
      text: analysis[0] ?? 'It shows a local institution setting its own terms.',
      sources: [],
      excerpt: '',
    },
  ];

  if (format === 'X post') {
    const body =
      !tooLong && headline.length % 2 === 0
        ? // First answer over the limit, so the "shortened to fit" path can be seen.
          `${lead} ${analysis[0] ?? FILLER[0]!} ${FILLER[2]!}${note}`
        : `${lead.length > 150 ? `${lead.slice(0, 150).replace(/\s+\S*$/, '')}…` : lead} ${instructions ? 'Revised to the editor’s note. ' : ''}${MARKER}`;
    return { title: '', body, claims: claims.slice(0, 2) };
  }
  if (format === 'Instagram caption') {
    const body = `${writeTo(110, [`${lead}${note}`, ...analysis.slice(0, 1)], 3)}\n\n#Omenai #StoriesShapingCulture #fixture`;
    return { title: '', body, claims };
  }
  if (format === 'LinkedIn post') {
    return {
      title: '',
      body: writeTo(170, [`${lead}${note}`, ...analysis.slice(0, 2)], 2),
      claims,
    };
  }
  if (format === 'Editorial article') {
    return {
      title: headline,
      body: writeTo(
        revising && /short/i.test(instructions) ? 820 : 880,
        [`${lead}${note}`, ...checked.slice(1, 3), ...analysis],
        4,
      ),
      claims,
    };
  }
  // Weekly Briefing item.
  const target = revising && /short/i.test(instructions) ? 155 : 190;
  return {
    title: headline.length > 70 ? `${headline.slice(0, 68).replace(/\s+\S*$/, '')}…` : headline,
    body: writeTo(target, [`${lead}${note}`, ...checked.slice(1, 2), ...analysis.slice(0, 1)], 3),
    claims,
  };
}
