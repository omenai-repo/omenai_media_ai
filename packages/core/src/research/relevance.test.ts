import { describe, expect, it } from 'vitest';

import { isRelevantToStory, storyAnchors } from './relevance.js';

const biennale = storyAnchors({
  headline:
    'After ten years of planning, the first Lagos Biennale of Textile Art opens across eleven venues',
  entities: ['Lagos Biennale of Textile Art', 'Funmilayo Adeyemi'],
  geography: [{ city: 'Lagos' }],
});

describe('story relevance of search results (lexical, deliberately not generic)', () => {
  it('builds anchors from names and cities, never from generic culture words or countries', () => {
    expect(biennale.phrases).toEqual(
      expect.arrayContaining([
        'lagos biennale of textile art',
        'funmilayo adeyemi',
        'lagos biennale',
      ]),
    );
    expect(biennale.words).toEqual(expect.arrayContaining(['lagos', 'funmilayo', 'adeyemi']));
    expect(biennale.words).not.toEqual(expect.arrayContaining(['art']));
    expect(biennale.words).not.toContain('textile');
    expect(biennale.words).not.toContain('biennale');
  });

  it('admits clearly relevant results', () => {
    expect(isRelevantToStory('Queues at the Lagos Biennale’s floating gallery', biennale)).toBe(
      true,
    );
    expect(isRelevantToStory('Funmilayo Adeyemi on curating with cloth', biennale)).toBe(true);
    // Two distinct names, without a full phrase.
    expect(isRelevantToStory('Adeyemi brings weavers to Lagos', biennale)).toBe(true);
  });

  it('rejects near misses that share only a city or generic vocabulary', () => {
    expect(isRelevantToStory('Lagos traffic: new bus lanes open this week', biennale)).toBe(false);
    expect(isRelevantToStory('Textile art fair opens in Berlin', biennale)).toBe(false);
    expect(
      isRelevantToStory('Ten art exhibitions and biennales to see this autumn', biennale),
    ).toBe(false);
    expect(isRelevantToStory('How to configure a Linux server', biennale)).toBe(false);
    // A two-word city still counts once.
    const capeTown = storyAnchors({
      headline: 'Zeitz MOCAA opens a retrospective of Kwame Asante',
      entities: ['Zeitz MOCAA', 'Kwame Asante'],
      geography: [{ city: 'Cape Town' }],
    });
    expect(isRelevantToStory('Cape Town opens new bus lanes this week', capeTown)).toBe(false);
    expect(isRelevantToStory('Asante works go on show in Cape Town', capeTown)).toBe(true);
  });

  it('lets an approved lead add its own names', () => {
    const lead = storyAnchors({
      headline: 'Kora, rewired',
      entities: [],
      geography: [{ city: 'Banjul' }],
      focus: 'What has Fatou Jallow said about electronic kora music?',
    });
    expect(isRelevantToStory('Fatou Jallow interview: tradition and electronics', lead)).toBe(true);
    // A single shared word is not enough.
    expect(isRelevantToStory('Kora workshop for beginners', lead)).toBe(false);
  });
});
