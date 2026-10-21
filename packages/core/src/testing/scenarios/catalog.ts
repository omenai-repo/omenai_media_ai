/**
 * DEVELOPMENT FIXTURES ONLY. A catalogue of invented editions, stories and source articles for
 * exercising the newsroom interface: long and short headlines, missing metadata, every image
 * case, related developments, failed sources, failed assessments and every editorial outcome.
 *
 * Everything here is fictional: the institutions, people and events are invented, the sources
 * live on reserved `.example` domains, and the photographs are placeholder images. None of it
 * may be presented as reporting.
 */
import type { SourceQuality } from '@repo/shared';

import type { EvaluationOutput } from '../../discovery/schemas.js';
import { fixtureEvaluation, scores } from '../discovery-fixtures.js';

/**
 * How a source page presents its preview image. `missing` (the page had none) and `rejected` (it
 * offered only unusable candidates, such as a logo or an insecure URL) both store no image;
 * `broken` stores a valid-looking URL whose request fails, so the display fallback is exercised.
 */
export type ImageCase =
  'landscape' | 'portrait' | 'landscape-no-alt' | 'broken' | 'rejected' | 'missing';

export interface ScenarioArticle {
  /** Unique slug; also seeds the placeholder image. */
  slug: string;
  host: string;
  title: string;
  /** One sentence the fixture body is built from. */
  detail: string;
  /** Days before the edition it was published; null when the page gives no date. */
  publishedDaysBefore: number | null;
  image: ImageCase;
  /** Alt text the page gives its image (landscape and portrait only). */
  alt?: string;
  quality: SourceQuality;
  /** The page can't be read during this edition (counts as a failed source). */
  unreadable?: boolean;
}

export interface ScenarioStory {
  key: string;
  /** First article leads; its title is the story headline. */
  articles: ScenarioArticle[];
  /** The scripted assessment, or `fails` for a technical failure. */
  evaluation: Partial<EvaluationOutput> | 'fails';
  /** A link to a story from an earlier edition. */
  relatesTo?: { key: string; relation: 'new_development' | 'same_development_no_new_info' };
}

export interface ScenarioEdition {
  key: string;
  /** Days before the seed date (0 = today in Chicago). */
  daysAgo: number;
  state: 'completed' | 'in_progress' | 'failed';
  /** Plain description, shown by the seed command. */
  description: string;
  stories: ScenarioStory[];
  /** Search queries that fail without stopping the run. */
  failingQueries?: number;
  /** An authorisation failure that stops the run in its first stage. */
  searchUnauthorised?: boolean;
  /** For an edition in progress: how many stories have been assessed so far. */
  assessedSoFar?: number;
}

const editorialTest = (answer: string) => ({ canAnswer: true, answer, supportedBy: [1] });

// ── Today: still being prepared ──────────────────────────────────────────────

const today: ScenarioEdition = {
  key: 'in-progress',
  daysAgo: 0,
  state: 'in_progress',
  description: 'Still running: 2 of 6 stories assessed; one assessment is retrying.',
  assessedSoFar: 2,
  stories: [
    [
      'harare-sculpture',
      'Harare sculpture park reopens after a two-year restoration',
      'harare-news.example',
    ],
    [
      'accra-schools',
      'Accra architects map the city’s modernist school buildings',
      'accra-design.example',
    ],
    [
      'tunis-cinema',
      'Tunis cinema club restores its 1960s projection booth',
      'maghreb-screen.example',
    ],
    [
      'mumbai-mill',
      'Former Mumbai textile mill becomes a performance venue',
      'mumbai-stage.example',
    ],
    [
      'cartagena-photo',
      'Cartagena street photographers publish a shared archive',
      'caribe-arts.example',
    ],
    ['addis-jazz', 'Addis Ababa label reissues a lost 1972 jazz session', 'horn-sound.example'],
  ].map(([slug, title, host]) => ({
    key: `today-${slug}`,
    articles: [
      {
        slug: slug!,
        host: host!,
        title: title!,
        detail: `${title} (fixture report).`,
        publishedDaysBefore: 1,
        image: 'landscape' as const,
        alt: `${title}, placeholder photograph`,
        quality: 'reputable_secondary' as const,
      },
    ],
    evaluation: {
      headline: title!,
      geography: [
        { country: 'Zimbabwe', city: 'Harare', region: 'southern_africa', confidence: 'medium' },
      ],
    },
  })),
};

// ── Yesterday: a full edition (more qualified stories than places) ────────────

const biennale: ScenarioStory = {
  key: 'biennale',
  articles: [
    {
      slug: 'biennale-official',
      host: 'lagos-textile-biennale.example',
      title:
        'After ten years of planning, the first Lagos Biennale of Textile Art opens across eleven venues, from warehouses to the lagoon',
      detail:
        'The biennale opens with eleven venues, including former colonial-era warehouses and a floating gallery',
      publishedDaysBefore: 1,
      image: 'landscape',
      alt: 'Long indigo-dyed cloths hanging in a former warehouse',
      quality: 'primary',
    },
    {
      slug: 'biennale-review',
      host: 'arts-review.example',
      title: 'Lagos textile biennale opens with a floating gallery and eleven venues',
      detail: 'A review of the opening weekend of the textile biennale in Lagos',
      publishedDaysBefore: 1,
      image: 'portrait',
      alt: 'A weaver at a loom, photographed from above',
      quality: 'reputable_secondary',
    },
    {
      slug: 'biennale-guide',
      host: 'textile-quarterly.example',
      title: 'What to see first at the Lagos Biennale of Textile Art',
      detail: 'A specialist guide to the biennale venues and artists',
      publishedDaysBefore: 1,
      image: 'missing',
      quality: 'specialist',
    },
    {
      slug: 'biennale-social',
      host: 'social-posts.example',
      title: 'Photos: queues outside the floating gallery on the Lagos lagoon',
      detail: 'Social posts showing queues at the floating gallery',
      publishedDaysBefore: 0,
      image: 'broken',
      quality: 'unverified_social',
    },
  ],
  evaluation: {
    summary:
      'A new biennale devoted to textile art has opened in Lagos across eleven venues. Organisers describe it as the first of its kind in West Africa; the programme pairs established weavers with younger artists.',
    whatHappened:
      'The first Lagos Biennale of Textile Art opened this week across eleven venues, including warehouses and a floating gallery (A1, A2). A specialist guide lists the main commissions (A3).',
    editorialTest: editorialTest(
      'This matters to Omenai’s audience because it asks who counts as an artist when the medium is cloth, and puts West African weaving traditions at the centre of a contemporary art event rather than at its margins.',
    ),
    whyItMatters:
      'A major new platform for textile art, built in West Africa. It reframes craft traditions as contemporary practice.',
    angle: 'Can a biennale built on cloth change who is counted as an artist?',
    whyNow: 'Opening week; most venues close within six weeks.',
    primaryPillar: 'art_creative_expression',
    subcategories: ['galleries_museums_fairs', 'contemporary_art_practice'],
    crossCuttingTags: ['craft_materiality', 'cultural_institutions', 'global_cultural_exchange'],
    geography: [{ country: 'Nigeria', city: 'Lagos', region: 'west_africa', confidence: 'high' }],
    culturalConnections: [
      'Adire and aso-oke weaving traditions',
      'The rise of textile art in global biennials',
    ],
    entities: ['Lagos Biennale of Textile Art'],
    timeliness: 'this_week',
    formatPotential: [
      { format: 'feature', rationale: 'Room to connect the commissions to weaving histories.' },
      {
        format: 'short_video',
        rationale: 'The floating gallery and warehouse installations are visual.',
      },
      { format: 'interview', rationale: 'The artistic director is named in the official release.' },
    ],
    verificationNeeds: [
      'Confirm the “first in West Africa” claim with the organisers.',
      'Check the closing dates for each venue.',
    ],
    peopleToApproach: [
      { name: 'Funmilayo Adeyemi', role: 'Artistic director (fictional)', basis: 'Named in A1' },
      {
        name: 'Chidi Okwu',
        role: 'Master weaver and exhibiting artist (fictional)',
        basis: 'Quoted in A2',
      },
    ],
    visualOpportunities: [
      'Installation views in the warehouses (rights unconfirmed).',
      'The floating gallery at dusk (rights unconfirmed).',
    ],
    ...withScores(scores(5, { commercial_adjacency: 3, human_interest_access: 4 })),
  },
};

const yesterday: ScenarioEdition = {
  key: 'full-edition',
  daysAgo: 1,
  state: 'completed',
  description:
    'A full edition: 10 stories met the standard, the strongest 8 are recommended; one repeat, one below the bar, one needing checks.',
  stories: [
    biennale,
    {
      key: 'archive-on-show',
      relatesTo: { key: 'nairobi-archive', relation: 'new_development' },
      articles: [
        {
          slug: 'archive-on-show',
          host: 'nairobi-culture.example',
          title: 'Nairobi’s digitised studio portraits go on show for the first time',
          detail:
            'The digitised portrait archive from a Nairobi studio is exhibited for the first time',
          publishedDaysBefore: 2,
          image: 'missing',
          quality: 'reputable_secondary',
        },
      ],
      evaluation: {
        summary:
          'Portraits from a 1960s Nairobi studio, digitised earlier this month, are now on public display for the first time.',
        whyItMatters:
          'The archive moves from storage to the public. It is a rare look at how Nairobi residents chose to be seen after independence.',
        angle: 'Who decides how a city remembers its own faces?',
        primaryPillar: 'ideas_history_cultural_change',
        subcategories: ['heritage_memory_preservation'],
        crossCuttingTags: ['heritage_rediscovery'],
        geography: [
          { country: 'Kenya', city: 'Nairobi', region: 'east_africa', confidence: 'high' },
        ],
        ...withScores(scores(4, { cultural_significance: 5, distinctive_angle: 5 })),
      },
    },
    {
      key: 'kinshasa-chef',
      articles: [
        {
          slug: 'kinshasa-chef',
          host: 'congo-table.example',
          title: 'Kinshasa chef’s tasting menu traces the Congo River from source to sea',
          detail: 'A Kinshasa chef builds a tasting menu around ingredients from along the river',
          publishedDaysBefore: 1,
          image: 'broken',
          quality: 'reputable_secondary',
        },
        {
          slug: 'kinshasa-chef-interview',
          host: 'food-letters.example',
          title: 'Ten courses, one river: an interview with a Kinshasa chef',
          detail: 'An interview about the river-themed menu',
          publishedDaysBefore: 1,
          image: 'missing',
          quality: 'specialist',
        },
      ],
      evaluation: {
        entities: ['Mireille Nsimba', 'Maison Fleuve'],
        summary: 'A chef in Kinshasa has launched a ten-course menu that follows the Congo River.',
        whyItMatters:
          'Food as cultural geography, told from Central Africa. A strong visual and personal story.',
        angle: 'What does a river taste like?',
        timeliness: 'urgent',
        primaryPillar: 'places_architecture_living',
        subcategories: ['food_culture'],
        crossCuttingTags: ['heritage_rediscovery'],
        geography: [
          { country: 'DR Congo', city: 'Kinshasa', region: 'central_africa', confidence: 'high' },
        ],
        ...withScores(scores(4, { cultural_significance: 5 })),
      },
    },
    {
      key: 'kora',
      articles: [
        {
          slug: 'kora',
          host: 'gambia-sound.example',
          title: 'Kora, rewired',
          detail: 'A kora player releases an electronic album',
          publishedDaysBefore: 2,
          image: 'portrait',
          alt: 'A musician holding a kora against a plain wall',
          quality: 'reputable_secondary',
        },
      ],
      evaluation: {
        summary: 'A Gambian kora player’s first electronic album.',
        whatHappened: 'An album was released (A1).',
        whyItMatters: 'Tradition, remade.',
        angle: 'Old strings, new circuits.',
        whyNow: 'Out this week.',
        primaryPillar: 'film_music_performance',
        subcategories: ['music_scenes'],
        crossCuttingTags: ['emerging_talent'],
        geography: [
          { country: 'The Gambia', city: 'Banjul', region: 'west_africa', confidence: 'high' },
        ],
        formatPotential: [{ format: 'briefing', rationale: 'A short item.' }],
        verificationNeeds: [],
        visualOpportunities: [],
        ...withScores(scores(4)),
      },
    },
    {
      key: 'dhaka-jute',
      articles: [
        {
          slug: 'dhaka-jute',
          host: 'design-south.example',
          title: 'Dhaka studio turns jute into collectible furniture',
          detail: 'A Dhaka design studio makes furniture from jute fibre',
          publishedDaysBefore: 2,
          image: 'landscape-no-alt',
          quality: 'specialist',
        },
      ],
      evaluation: {
        primaryPillar: 'fashion_design_objects',
        subcategories: ['furniture_industrial_design', 'craftsmanship_materials'],
        crossCuttingTags: ['craft_materiality'],
        geography: [
          { country: 'Bangladesh', city: 'Dhaka', region: 'south_asia', confidence: 'high' },
        ],
        angle: 'Can a humble fibre become a design classic?',
        ...withScores(scores(4, { visual_potential: 3 })),
      },
    },
    {
      key: 'salvador-library',
      articles: [
        {
          slug: 'salvador-library',
          host: 'bahia-letters.example',
          title:
            'Founder of Salvador’s Afro-Brazilian design library steps back after thirty years',
          detail: 'The founder of a design library in Salvador announces she is stepping back',
          publishedDaysBefore: 2,
          image: 'rejected',
          quality: 'reputable_secondary',
        },
      ],
      evaluation: {
        primaryPillar: 'people_influence_institutions',
        subcategories: ['founders_institution_builders'],
        crossCuttingTags: ['cultural_institutions', 'global_cultural_exchange'],
        geography: [{ country: 'Brazil', city: 'Salvador', region: 'brazil', confidence: 'high' }],
        angle: 'What happens to an institution when its founder leaves?',
        peopleToApproach: [
          { name: 'Marta dos Santos', role: 'Founder (fictional)', basis: 'Named in A1' },
        ],
        ...withScores(scores(4, { originality: 3 })),
      },
    },
    {
      key: 'zanzibar-doors',
      articles: [
        {
          slug: 'zanzibar-doors',
          host: 'swahili-coast.example',
          title: 'Restoring the carved doors of Zanzibar’s Stone Town',
          detail: 'Craftspeople restore carved wooden doors in Stone Town',
          publishedDaysBefore: 3,
          image: 'missing',
          quality: 'reputable_secondary',
        },
        {
          slug: 'zanzibar-doors-blog',
          host: 'travel-notes.example',
          title: 'A walk past the carved doors of Stone Town',
          detail: 'A travel blog post about the carved doors',
          publishedDaysBefore: null,
          image: 'missing',
          quality: 'unknown',
        },
      ],
      evaluation: {
        // Deliberately sparse: optional fields the assessment left empty. The angle is required to
        // qualify (ADR-041), so it is short rather than missing.
        whyNow: '',
        angle: 'Who keeps the doors?',
        primaryPillar: 'places_architecture_living',
        subcategories: ['heritage_memory_preservation'],
        crossCuttingTags: [],
        geography: [
          { country: 'Tanzania', city: null, region: 'east_africa', confidence: 'medium' },
        ],
        culturalConnections: [],
        formatPotential: [],
        verificationNeeds: [],
        peopleToApproach: [],
        visualOpportunities: [],
        ...withScores(scores(4, { distinctive_angle: 3 })),
      },
    },
    {
      key: 'beirut-gallery',
      articles: [
        {
          slug: 'beirut-gallery',
          host: 'levant-arts.example',
          title: 'Beirut gallery reopens with a show about rebuilding',
          detail: 'A Beirut gallery reopens with an exhibition on reconstruction',
          publishedDaysBefore: 2,
          image: 'landscape',
          alt: 'Visitors in a white gallery space with large photographs',
          quality: 'reputable_secondary',
        },
      ],
      evaluation: {
        primaryPillar: 'art_creative_expression',
        subcategories: ['galleries_museums_fairs'],
        crossCuttingTags: ['contemporary_debates'],
        geography: [
          { country: 'Lebanon', city: 'Beirut', region: 'middle_east', confidence: 'high' },
        ],
        ...withScores(scores(4, { cultural_significance: 3 })),
      },
    },
    {
      key: 'oaxaca-weavers',
      articles: [
        {
          slug: 'oaxaca-weavers',
          host: 'latam-craft.example',
          title: 'Oaxaca weaving cooperative opens its first shop in the city',
          detail: 'A weaving cooperative opens a shop in Oaxaca',
          publishedDaysBefore: 2,
          image: 'landscape',
          alt: 'Folded woven blankets on wooden shelves',
          quality: 'reputable_secondary',
        },
      ],
      evaluation: {
        primaryPillar: 'fashion_design_objects',
        subcategories: ['craftsmanship_materials'],
        crossCuttingTags: ['craft_materiality'],
        geography: [
          {
            country: 'Mexico',
            city: 'Oaxaca',
            region: 'latin_america_caribbean',
            confidence: 'high',
          },
        ],
        ...withScores(scores(4, { cultural_significance: 3, originality: 3 })),
      },
    },
    {
      key: 'karachi-hoardings',
      articles: [
        {
          slug: 'karachi-hoardings',
          host: 'karachi-review.example',
          title: 'Photobook collects Karachi’s hand-painted cinema hoardings',
          detail: 'A photobook documents hand-painted cinema billboards',
          publishedDaysBefore: 3,
          image: 'missing',
          quality: 'specialist',
        },
      ],
      evaluation: {
        primaryPillar: 'film_music_performance',
        subcategories: ['cinema_filmmakers'],
        crossCuttingTags: ['heritage_rediscovery'],
        geography: [
          { country: 'Pakistan', city: 'Karachi', region: 'south_asia', confidence: 'high' },
        ],
        ...withScores(scores(4, { cultural_significance: 3, distinctive_angle: 3 })),
      },
    },
    {
      key: 'archive-repeat',
      relatesTo: { key: 'nairobi-archive', relation: 'same_development_no_new_info' },
      articles: [
        {
          slug: 'archive-repeat',
          host: 'east-africa-wire.example',
          title: 'Museum says digitisation of Nairobi studio archive continues',
          detail: 'A short update repeating the earlier digitisation news',
          publishedDaysBefore: 2,
          image: 'missing',
          quality: 'reputable_secondary',
        },
      ],
      evaluation: { primaryPillar: 'ideas_history_cultural_change', ...withScores(scores(3)) },
    },
    {
      key: 'accra-market',
      articles: [
        {
          slug: 'accra-market',
          host: 'accra-style.example',
          title: 'Pop-up fashion market returns to Accra for the holidays',
          detail: 'A seasonal fashion market returns',
          publishedDaysBefore: 1,
          image: 'landscape',
          alt: 'Clothing rails under a canopy',
          quality: 'reputable_secondary',
        },
      ],
      evaluation: {
        primaryPillar: 'fashion_design_objects',
        subcategories: ['design_weeks_shows'],
        geography: [{ country: 'Ghana', city: 'Accra', region: 'west_africa', confidence: 'high' }],
        ...withScores(scores(3)),
      },
    },
    {
      key: 'benin-bronze-claim',
      articles: [
        {
          slug: 'benin-bronze-claim',
          host: 'art-market-gossip.example',
          title: 'Dealer claims a lost Benin bronze has surfaced in a private sale',
          detail: 'An unnamed dealer claims a lost bronze is for sale privately',
          publishedDaysBefore: 1,
          image: 'missing',
          quality: 'unknown',
        },
      ],
      evaluation: {
        primaryPillar: 'art_creative_expression',
        subcategories: ['art_markets_provenance'],
        crossCuttingTags: ['contemporary_debates'],
        geography: [
          { country: 'Nigeria', city: 'Benin City', region: 'west_africa', confidence: 'low' },
        ],
        verificationNeeds: [
          'Is the object the one described in museum records, or a later cast?',
          'Who is the dealer, and who is the current owner?',
          'Is there an export licence or provenance record?',
          'Has the Benin royal court or the national commission commented?',
        ],
        criticalIssues: [
          {
            kind: 'accuracy',
            severity: 'hold',
            evidence: 'The central claim rests on one unnamed dealer.',
          },
          { kind: 'source', severity: 'hold', evidence: 'A single gossip-column source.' },
        ],
        confidence: 'low',
        ...withScores(scores(4, { cultural_significance: 5 })),
      },
    },
  ],
};

// ── Two days ago: completed, but some sources failed ─────────────────────────

const twoDaysAgo: ScenarioEdition = {
  key: 'sources-failed',
  daysAgo: 2,
  state: 'completed',
  description:
    'Completed, but a search and two article reads failed, and one assessment failed after retries.',
  failingQueries: 1,
  stories: [
    {
      key: 'casablanca-market',
      articles: [
        {
          slug: 'casablanca-market',
          host: 'maghreb-architecture.example',
          title: 'Casablanca’s modernist market hall saved from demolition',
          detail: 'A modernist market hall in Casablanca is protected from demolition',
          publishedDaysBefore: 2,
          image: 'landscape',
          alt: 'A concrete shell roof over market stalls',
          quality: 'reputable_secondary',
        },
      ],
      evaluation: {
        entities: ['Souk Lahjar Hall', 'Darb Heritage Trust'],
        primaryPillar: 'places_architecture_living',
        subcategories: ['heritage_memory_preservation'],
        crossCuttingTags: ['heritage_rediscovery'],
        geography: [
          { country: 'Morocco', city: 'Casablanca', region: 'north_africa', confidence: 'high' },
        ],
        ...withScores(scores(4, { cultural_significance: 5 })),
      },
    },
    {
      key: 'abeokuta-adire',
      articles: [
        {
          slug: 'abeokuta-adire',
          host: 'nigeria-craft.example',
          title: 'Abeokuta’s adire workshops train a new generation of indigo dyers',
          detail: 'Indigo dye workshops in Abeokuta take on young apprentices',
          publishedDaysBefore: 3,
          image: 'portrait',
          alt: 'Hands dipping cloth into an indigo vat',
          quality: 'reputable_secondary',
        },
        {
          slug: 'abeokuta-adire-feature',
          host: 'slow-fashion.example',
          title: 'Inside the indigo yards of Abeokuta',
          detail: 'A feature on the dye yards',
          publishedDaysBefore: 3,
          image: 'landscape',
          quality: 'specialist',
          unreadable: true,
        },
      ],
      evaluation: {
        primaryPillar: 'fashion_design_objects',
        subcategories: ['craftsmanship_materials', 'fashion_history_production'],
        crossCuttingTags: ['craft_materiality', 'emerging_talent'],
        geography: [
          { country: 'Nigeria', city: 'Abeokuta', region: 'west_africa', confidence: 'high' },
        ],
        ...withScores(scores(4)),
      },
    },
    {
      key: 'dakar-documentary',
      articles: [
        {
          slug: 'dakar-documentary',
          host: 'sahel-cinema.example',
          title: 'Dakar collective premieres a restored 1970s documentary on fishing communities',
          detail: 'A film collective restores and screens a documentary',
          publishedDaysBefore: 2,
          image: 'landscape',
          quality: 'reputable_secondary',
          unreadable: true,
        },
      ],
      evaluation: {
        entities: ['Ciné-Sahel Collective'],
        primaryPillar: 'film_music_performance',
        subcategories: ['cinema_filmmakers', 'film_festivals'],
        crossCuttingTags: ['heritage_rediscovery'],
        geography: [
          { country: 'Senegal', city: 'Dakar', region: 'west_africa', confidence: 'high' },
        ],
        ...withScores(scores(4, { distinctive_angle: 3 })),
      },
    },
    {
      key: 'sao-paulo-funk',
      articles: [
        {
          slug: 'sao-paulo-funk',
          host: 'brasil-som.example',
          title: 'São Paulo producers build a public archive of baile funk recordings',
          detail: 'Producers assemble an archive of baile funk recordings',
          publishedDaysBefore: 2,
          image: 'landscape',
          alt: 'A mixing desk lit by coloured lights',
          quality: 'reputable_secondary',
        },
      ],
      evaluation: 'fails',
    },
  ],
};

// ── Three days ago: a small edition ─────────────────────────────────────────

const threeDaysAgo: ScenarioEdition = {
  key: 'small-edition',
  daysAgo: 3,
  state: 'completed',
  description: 'A small edition: one story met the standard; the bar was not lowered.',
  stories: [
    {
      key: 'nairobi-archive',
      articles: [
        {
          slug: 'nairobi-archive',
          host: 'nairobi-culture.example',
          title: 'Nairobi photo studio’s 1960s portrait archive to be digitised',
          detail: 'A museum will digitise thousands of studio portraits from the 1960s',
          publishedDaysBefore: 1,
          image: 'landscape',
          alt: 'A black-and-white studio portrait of a couple',
          quality: 'primary',
        },
      ],
      evaluation: {
        primaryPillar: 'ideas_history_cultural_change',
        subcategories: ['heritage_memory_preservation', 'art_history_archives'],
        crossCuttingTags: ['heritage_rediscovery', 'cultural_institutions'],
        geography: [
          { country: 'Kenya', city: 'Nairobi', region: 'east_africa', confidence: 'high' },
        ],
        angle: 'Who decides how a city remembers its own faces?',
        ...withScores(scores(4, { cultural_significance: 5 })),
      },
    },
    {
      key: 'lagos-nightlife-photos',
      articles: [
        {
          slug: 'lagos-nightlife-photos',
          host: 'archive-blog.example',
          title: 'Unattributed photographs of 1970s Lagos nightlife circulate online',
          detail: 'Photographs of unknown origin are shared on a blog',
          publishedDaysBefore: null,
          image: 'missing',
          quality: 'unknown',
        },
      ],
      evaluation: {
        primaryPillar: 'ideas_history_cultural_change',
        subcategories: ['art_history_archives'],
        geography: [
          { country: 'Nigeria', city: 'Lagos', region: 'west_africa', confidence: 'medium' },
        ],
        criticalIssues: [
          {
            kind: 'rights',
            severity: 'hold',
            evidence: 'No photographer or rights holder is identified.',
          },
        ],
        ...withScores(scores(4)),
      },
    },
    {
      key: 'joburg-jazz-podcast',
      articles: [
        {
          slug: 'joburg-jazz-podcast',
          host: 'jozi-audio.example',
          title: 'Johannesburg podcast revisits the city’s lost jazz clubs',
          detail: 'A podcast series about former jazz venues',
          publishedDaysBefore: 1,
          image: 'landscape',
          alt: 'A microphone in an empty club',
          quality: 'reputable_secondary',
        },
      ],
      evaluation: {
        primaryPillar: 'film_music_performance',
        subcategories: ['music_scenes'],
        geography: [
          {
            country: 'South Africa',
            city: 'Johannesburg',
            region: 'southern_africa',
            confidence: 'high',
          },
        ],
        ...withScores(scores(3)),
      },
    },
    {
      key: 'marrakech-viral',
      articles: [
        {
          slug: 'marrakech-viral',
          host: 'celebrity-daily.example',
          title: 'Pop star’s surprise stay at a Marrakech riad goes viral',
          detail: 'A celebrity visit attracts social media attention',
          publishedDaysBefore: 1,
          image: 'landscape',
          quality: 'unverified_social',
        },
      ],
      evaluation: {
        primaryPillar: 'people_influence_institutions',
        subcategories: ['creators'],
        geography: [
          { country: 'Morocco', city: 'Marrakech', region: 'north_africa', confidence: 'high' },
        ],
        exclusions: [
          {
            id: 'celebrity_gossip_or_virality',
            evidence: 'A viral celebrity visit with no cultural question.',
            exception: null,
            supportedBy: [],
          },
        ],
        ...withScores(scores(3)),
      },
    },
  ],
};

// ── Four days ago: nothing met the standard ──────────────────────────────────

const fourDaysAgo: ScenarioEdition = {
  key: 'no-recommendations',
  daysAgo: 4,
  state: 'completed',
  description: 'No story met the standard, so the edition is empty.',
  stories: [
    {
      key: 'autumn-listicle',
      articles: [
        {
          slug: 'autumn-listicle',
          host: 'weekend-lists.example',
          title: 'Twelve exhibitions to see this autumn',
          detail: 'A list of twelve exhibitions with one line each',
          publishedDaysBefore: 1,
          image: 'landscape',
          quality: 'reputable_secondary',
        },
      ],
      evaluation: {
        exclusions: [
          {
            id: 'thin_listicle_seo',
            evidence: 'Twelve one-line entries.',
            exception: null,
            supportedBy: [],
          },
        ],
        ...withScores(scores(3)),
      },
    },
    {
      key: 'desert-gala',
      articles: [
        {
          slug: 'desert-gala',
          host: 'luxe-life.example',
          title: 'Inside a fashion house’s desert gala outside Marrakech',
          detail: 'Sponsored coverage of a brand gala',
          publishedDaysBefore: 1,
          image: 'landscape',
          quality: 'reputable_secondary',
        },
      ],
      evaluation: {
        primaryPillar: 'fashion_design_objects',
        subcategories: ['design_weeks_shows'],
        geography: [
          { country: 'Morocco', city: 'Marrakech', region: 'north_africa', confidence: 'high' },
        ],
        exclusions: [
          {
            id: 'generic_luxury_promotion',
            evidence: 'Brand-supplied gala coverage.',
            exception: null,
            supportedBy: [],
          },
        ],
        ...withScores(scores(4)),
      },
    },
    {
      key: 'kumasi-mural',
      articles: [
        {
          slug: 'kumasi-mural',
          host: 'ashanti-news.example',
          title: 'Market mural unveiled in Kumasi',
          detail: 'A mural is painted on a market wall',
          publishedDaysBefore: 1,
          image: 'missing',
          quality: 'reputable_secondary',
        },
      ],
      evaluation: {
        geography: [
          { country: 'Ghana', city: 'Kumasi', region: 'west_africa', confidence: 'high' },
        ],
        ...withScores(scores(3)),
      },
    },
  ],
};

// ── Five days ago: the search failed ─────────────────────────────────────────

const fiveDaysAgo: ScenarioEdition = {
  key: 'failed-run',
  daysAgo: 5,
  state: 'failed',
  description: 'The search service refused the key, so the run stopped before finding anything.',
  searchUnauthorised: true,
  stories: [],
};

// ── On demand: what "Find today’s stories" finds against a fixtures database ────

/**
 * Served by the fixture executor when an owner starts a search by hand. Two stories meet the
 * standard and one doesn't. A second search the same day finds nothing new (every page has been
 * seen), which is also what the real pipeline would do.
 */
export const ON_DEMAND_EDITION: ScenarioEdition = {
  key: 'on-demand',
  daysAgo: 0,
  state: 'completed',
  description: 'A search started by hand: two stories recommended, one below the standard.',
  stories: [
    {
      key: 'lusaka-weavers',
      articles: [
        {
          slug: 'lusaka-weavers',
          host: 'zambezi-arts.example',
          title: 'Lusaka weavers revive a 1970s textile cooperative',
          detail: 'Weavers in Lusaka have reopened a textile cooperative that closed in 1979',
          publishedDaysBefore: 0,
          image: 'landscape',
          alt: 'Looms in a workshop, placeholder photograph',
          quality: 'reputable_secondary',
        },
      ],
      evaluation: {
        primaryPillar: 'fashion_design_objects',
        subcategories: ['craftsmanship_materials'],
        geography: [
          { country: 'Zambia', city: 'Lusaka', region: 'southern_africa', confidence: 'high' },
        ],
        ...withScores(scores(4)),
      },
    },
    {
      key: 'valparaiso-press',
      articles: [
        {
          slug: 'valparaiso-press',
          host: 'pacifico-cultura.example',
          title: 'Valparaíso printmakers open a shared press in a former port warehouse',
          detail: 'Printmakers in Valparaíso have opened a shared press in a former port warehouse',
          publishedDaysBefore: 1,
          image: 'missing',
          quality: 'reputable_secondary',
        },
      ],
      evaluation: {
        primaryPillar: 'art_creative_expression',
        subcategories: ['studios_residencies'],
        geography: [
          {
            country: 'Chile',
            city: 'Valparaíso',
            region: 'latin_america_caribbean',
            confidence: 'high',
          },
        ],
        ...withScores(scores(4)),
      },
    },
    {
      key: 'weekend-openings',
      articles: [
        {
          slug: 'weekend-openings',
          host: 'weekend-lists.example',
          title: 'Ten gallery openings to see this weekend',
          detail: 'A list of ten gallery openings with one line each',
          publishedDaysBefore: 0,
          image: 'landscape',
          quality: 'reputable_secondary',
        },
      ],
      evaluation: {
        exclusions: [
          {
            id: 'thin_listicle_seo',
            evidence: 'Ten one-line entries.',
            exception: null,
            supportedBy: [],
          },
        ],
        ...withScores(scores(3)),
      },
    },
  ],
};

/** Oldest first: later editions refer back to earlier stories. */
export const FULL_EDITIONS: readonly ScenarioEdition[] = [
  fiveDaysAgo,
  fourDaysAgo,
  threeDaysAgo,
  twoDaysAgo,
  yesterday,
  today,
];

function withScores(dimensionScores: ReturnType<typeof scores>): Pick<EvaluationOutput, 'scores'> {
  return { scores: fixtureEvaluation(dimensionScores).scores };
}
