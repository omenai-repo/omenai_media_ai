import { CULTURE_WORDS as GENERIC } from './terms.js';

/**
 * A lightweight, deterministic check that a search result is about this story before anything is
 * read or stored. It is lexical by design (no model call), so it has known limits: it can miss
 * coverage that spells or transliterates names differently or names no one, and it can admit a
 * coincidental match on the same names. Everything it admits still goes through citation checks.
 */

/** Words that start a headline without being names. */
const SENTENCE_STARTERS = new Set(
  'a an the after before how why what when where who inside in on at for from with as this these new'.split(
    ' ',
  ),
);

export interface StoryAnchors {
  /** Multi-word names, e.g. "kwame asante", "lagos biennale". */
  phrases: string[];
  /** Distinctive single words, and each city as one unit, e.g. "asante", "cape town". */
  words: string[];
}

export function normalizeText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[’']s\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const distinctive = (word: string) => word.length >= 3 && !GENERIC.has(word) && !/^\d+$/.test(word);

/** Runs of capitalised words in a headline ("Lagos Biennale", "Zeitz MOCAA"). */
function properNounRuns(headline: string): string[][] {
  const tokens = headline.split(/\s+/).map((t) => t.replace(/[^\p{L}\p{N}’'-]/gu, ''));
  const runs: string[][] = [];
  let run: string[] = [];
  tokens.forEach((token, i) => {
    const capitalised = /^\p{Lu}/u.test(token);
    const starter = i === 0 && SENTENCE_STARTERS.has(token.toLowerCase());
    if (capitalised && !starter) run.push(token);
    else {
      if (run.length) runs.push(run);
      run = [];
    }
  });
  if (run.length) runs.push(run);
  return runs;
}

export function storyAnchors(story: {
  headline: string;
  entities?: readonly string[] | null;
  geography?: ReadonlyArray<{ city?: string | null }> | null;
  focus?: string | null;
}): StoryAnchors {
  const phrases = new Set<string>();
  const words = new Set<string>();
  // A city counts once, however many words it has: a city alone never makes a result relevant.
  const cities = new Set(
    (story.geography ?? [])
      .map((place) => normalizeText(place.city ?? ''))
      .filter((city) => city.length >= 3),
  );
  for (const city of cities) words.add(city);
  const addName = (name: string) => {
    const normalized = normalizeText(name);
    if (cities.has(normalized)) return;
    const parts = normalized.split(' ').filter(Boolean);
    const meaningful = parts.filter((part) => distinctive(part) && !cities.has(part));
    const hasCity = [...cities].some((city) => ` ${normalized} `.includes(` ${city} `));
    // "Lagos Biennale" names something; "Textile Art" (generic words only) does not.
    if (parts.length >= 2 && (meaningful.length > 0 || hasCity)) phrases.add(parts.join(' '));
    for (const word of meaningful) words.add(word);
  };
  for (const entity of story.entities ?? []) addName(entity);
  for (const text of [story.headline, story.focus ?? '']) {
    for (const run of properNounRuns(text)) addName(run.join(' '));
  }
  return { phrases: [...phrases], words: [...words] };
}

/** Relevant when the text contains a whole anchor phrase, or two distinct anchor words. */
export function isRelevantToStory(text: string, anchors: StoryAnchors): boolean {
  const normalized = ` ${normalizeText(text)} `;
  if (anchors.phrases.some((phrase) => normalized.includes(` ${phrase} `))) return true;
  return anchors.words.filter((word) => normalized.includes(` ${word} `)).length >= 2;
}
