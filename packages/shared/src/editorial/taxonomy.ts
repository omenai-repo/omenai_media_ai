/**
 * Omenai's controlled editorial vocabulary, encoded from the CEO playbook
 * (docs/Omenai_Global_Culture_Taxonomy_AI_Newsroom_Playbook.pdf, v1.0, Oct 2026).
 * Sections are cited inline. New tags are added here through review, never invented by a model.
 */

const defineVocabulary = <const T extends Record<string, string>>(labels: T) => ({
  ids: Object.keys(labels) as Array<keyof T & string>,
  labels,
});

// §4 Core Editorial Taxonomy: one primary pillar per candidate, each with subcategories.
export const PILLARS = {
  art_creative_expression: {
    label: 'Art & Creative Expression',
    subcategories: {
      contemporary_art_practice: 'Contemporary art, artists and creative practices',
      painting_sculpture_photography:
        'Painting, sculpture, photography, installation and public art',
      collecting_patronage: 'Art collecting, collectors, patrons and private collections',
      galleries_museums_fairs: 'Galleries, museums, foundations, biennials, fairs and exhibitions',
      studios_residencies: 'Artist studios, workshops, residencies and creative spaces',
      art_history_archives: 'Art history, archives, rediscovered artists and overlooked movements',
      craft_material_culture:
        'Craft, ceramics, textiles and material culture in contemporary context',
      digital_new_media: 'Digital art, new media and creative technology',
      art_markets_provenance: 'Art markets, patronage, philanthropy, provenance and restitution',
    },
  },
  fashion_design_objects: {
    label: 'Fashion, Design & Objects',
    subcategories: {
      fashion_designers_labels:
        'Fashion houses, designers, independent labels and creative directors',
      fashion_history_production: 'Fashion history, archives, craft and production',
      jewelry_collectible_objects: 'Jewelry, watches, accessories and collectible objects',
      furniture_industrial_design: 'Furniture, collectible design, product and industrial design',
      architecture_interiors_graphic: 'Architecture, interiors, graphic design and typography',
      craftsmanship_materials: 'Craftsmanship, ateliers, materials and manufacturing',
      design_weeks_shows: 'Design weeks, fashion shows and major creative platforms',
      iconic_objects: 'Iconic objects and design classics with cultural histories',
      material_innovation: 'Material innovation and sustainability when there is a concrete story',
    },
  },
  film_music_performance: {
    label: 'Film, Music & Performance',
    subcategories: {
      cinema_filmmakers: 'Cinema, independent film, documentaries and filmmakers',
      film_festivals: 'Film festivals, premieres and international cinema',
      music_scenes: 'Music, musicians, producers, albums, genres and scenes',
      music_video_sound: 'Music videos, visual albums and sound as cultural expression',
      theater_dance_performance: 'Theater, dance, performance art and live culture',
      tv_streaming_animation: 'Television, streaming, animation and experimental media',
      entertainment_creative_work: 'Creative work behind entertainment and its cultural impact',
      celebrity_cultural_story:
        'Celebrity coverage only when it reveals a meaningful cultural or creative story',
    },
  },
  places_architecture_living: {
    label: 'Places, Architecture & Ways of Living',
    subcategories: {
      architecture_urban_transformation:
        'Architecture, landmark buildings and urban transformation',
      homes_studios_collections: 'Private homes, studios, collections and personal environments',
      hospitality_destinations: 'Hotels, hospitality and culturally significant destinations',
      food_culture: 'Restaurants, food culture, influential chefs and culinary heritage',
      cities_public_spaces_landscapes:
        'Cities, neighborhoods, public spaces, landscapes and gardens',
      cultural_travel: 'Travel through art, design, architecture, history and local culture',
      domestic_rituals: 'Domestic rituals, entertaining and how people inhabit spaces',
      creative_districts_infrastructure:
        'Creative districts, cultural infrastructure and places reshaping a city',
      real_estate_cultural:
        'Real estate only when architecture, design, history or cultural life is central',
    },
  },
  people_influence_institutions: {
    label: 'People, Influence & Cultural Institutions',
    subcategories: {
      creators: 'Artists, designers, architects, filmmakers, musicians and writers',
      collectors_curators_gallerists:
        'Collectors, patrons, curators, gallerists and cultural conveners',
      founders_institution_builders: 'Founders, creative entrepreneurs and institution builders',
      tastemakers_thinkers: 'Creative directors, publishers, tastemakers and cultural thinkers',
      profiles_interviews: 'Profiles, interviews, oral histories and career retrospectives',
      creative_families_legacies: 'Creative families, legacies and dynasties',
      people_behind_institutions:
        'People behind museums, foundations, studios, festivals and cultural spaces',
      practice_and_environments:
        'Personal collections, working environments and the ideas behind a practice',
    },
  },
  ideas_history_cultural_change: {
    label: 'Ideas, History & Cultural Change',
    subcategories: {
      heritage_memory_preservation: 'Cultural history, heritage, memory and preservation',
      intellectual_movements:
        'Intellectual movements, creative philosophies and schools of thought',
      identity_diaspora_exchange: 'Identity, belonging, diaspora and cultural exchange',
      colonial_histories: 'Colonial histories and documented influence on contemporary culture',
      restitution_stewardship:
        'Restitution, ownership, provenance and stewardship of cultural objects',
      globalization_networks:
        'Globalization, cross-cultural influence and changing creative networks',
      technology_ai_creativity:
        'Technology and AI’s concrete effects on creativity and cultural work',
      luxury_taste_status: 'Changing ideas of luxury, taste, status and aspiration',
      subcultures_youth: 'Subcultures, countercultures and youth movements',
      creative_economics_power: 'Creative-industry economics, patronage and institutional power',
      cultural_debates: 'Cultural debates where stakes and evidence can be explained',
    },
  },
} as const;

export type PillarId = keyof typeof PILLARS;
export const PILLAR_IDS = Object.keys(PILLARS) as PillarId[];
export type SubcategoryId = {
  [P in PillarId]: keyof (typeof PILLARS)[P]['subcategories'];
}[PillarId];
export const SUBCATEGORY_IDS = PILLAR_IDS.flatMap(
  (pillar) => Object.keys(PILLARS[pillar].subcategories) as SubcategoryId[],
);

export function pillarOfSubcategory(subcategory: SubcategoryId): PillarId {
  const pillar = PILLAR_IDS.find((id) => subcategory in PILLARS[id].subcategories);
  if (!pillar) throw new RangeError(`Unknown subcategory: ${subcategory}`);
  return pillar;
}

// §4 Cross-cutting tags.
export const CROSS_CUTTING_TAGS = defineVocabulary({
  luxury_connoisseurship: 'Luxury & Connoisseurship',
  emerging_talent: 'Emerging Talent',
  cultural_institutions: 'Cultural Institutions',
  cultural_commerce: 'Cultural Commerce',
  heritage_rediscovery: 'Heritage & Rediscovery',
  global_cultural_exchange: 'Global Cultural Exchange',
  contemporary_debates: 'Contemporary Debates',
  cultural_milestones: 'Cultural Milestones',
  craft_materiality: 'Craft & Materiality',
  collections_patronage: 'Collections & Patronage',
  creative_technology: 'Creative Technology',
});
export type CrossCuttingTag = (typeof CROSS_CUTTING_TAGS.ids)[number];

/**
 * §3 Geographic Strategy. Tiers weight discovery and break ties; they are never quotas, and a
 * stronger story from any region outranks a weaker one elsewhere.
 */
export const GEOGRAPHY_TIERS = {
  1: 'Africa',
  2: 'Brazil & Global South',
  3: 'UK & Europe',
  4: 'North America',
  5: 'Wider global opportunities',
} as const;
export type GeographyTier = keyof typeof GEOGRAPHY_TIERS;

export const REGIONS = {
  west_africa: { label: 'West Africa', tier: 1 },
  east_africa: { label: 'East Africa', tier: 1 },
  north_africa: { label: 'North Africa', tier: 1 },
  central_africa: { label: 'Central Africa', tier: 1 },
  southern_africa: { label: 'Southern Africa', tier: 1 },
  brazil: { label: 'Brazil', tier: 2 },
  latin_america_caribbean: { label: 'Latin America & the Caribbean', tier: 2 },
  south_asia: { label: 'South Asia', tier: 2 },
  southeast_asia: { label: 'Southeast Asia', tier: 2 },
  // The playbook places "parts of the Middle East" in Tier 2 and lists Dubai under Tier 5.
  middle_east: { label: 'Middle East (excluding Gulf states)', tier: 2 },
  gulf_states: { label: 'Gulf states', tier: 5 },
  uk: { label: 'United Kingdom', tier: 3 },
  europe: { label: 'Europe', tier: 3 },
  north_america: { label: 'North America', tier: 4 },
  east_asia: { label: 'East Asia', tier: 5 },
  oceania: { label: 'Oceania', tier: 5 },
  global: { label: 'Global / multiple regions', tier: 5 },
} as const satisfies Record<string, { label: string; tier: GeographyTier }>;
export type RegionId = keyof typeof REGIONS;
export const REGION_IDS = Object.keys(REGIONS) as RegionId[];

/** The highest-priority (lowest-numbered) tier among a story's locations. */
export function bestTier(regions: readonly RegionId[]): GeographyTier {
  if (regions.length === 0) return 5;
  return Math.min(...regions.map((region) => REGIONS[region].tier)) as GeographyTier;
}

/** §5 What the AI should not recommend. A flagged exclusion fails the gate unless excepted. */
export const EXCLUSIONS = defineVocabulary({
  routine_announcement:
    'Routine announcement with no broader significance (standard opening, appointment, product drop, event listing)',
  press_release_repackaged: 'Press release repackaged as editorial',
  celebrity_gossip_or_virality:
    'Celebrity gossip, personal drama, unverified rumour or virality without a cultural question',
  generic_luxury_promotion:
    'Generic luxury lifestyle content, primarily promotional or status-driven',
  fame_only: 'Selected only because a famous person, brand or institution is involved',
  repeated_coverage: 'Repeated coverage without new information or a genuinely different angle',
  thin_listicle_seo: 'Thin listicle, SEO filler or trend piece without credible evidence',
  engagement_controversy: 'Controversy included only for engagement',
  geographic_tokenism: 'Weak story included only to balance geography',
  sponsor_relevance_only: 'Sponsor or commercial relevance is the only merit',
});
export type ExclusionId = (typeof EXCLUSIONS.ids)[number];

/** §8 Any critical source, accuracy, rights or ethics failure holds or rejects regardless of score. */
export const CRITICAL_ISSUE_KINDS = defineVocabulary({
  source: 'Sources unclear, unreliable or not establishable',
  accuracy: 'Key claims cannot be verified or conflict',
  rights: 'No legitimate path for image, footage or content rights',
  ethics: 'Ethical problem (privacy, harm, exploitation, misrepresentation)',
});
export type CriticalIssueKind = (typeof CRITICAL_ISSUE_KINDS.ids)[number];

// §9 Recommended data model: controlled vocabularies.
export const SOURCE_QUALITY = defineVocabulary({
  primary: 'Primary source',
  reputable_secondary: 'Reputable secondary',
  specialist: 'Specialist publication',
  unverified_social: 'Unverified / social',
  unknown: 'Unknown',
});
export type SourceQuality = (typeof SOURCE_QUALITY.ids)[number];

export const NOVELTY_STATUS = defineVocabulary({
  new: 'New',
  developing: 'Developing',
  evergreen: 'Evergreen',
  retrospective: 'Retrospective',
  duplicate_related: 'Duplicate / related',
});
export type NoveltyStatus = (typeof NOVELTY_STATUS.ids)[number];

export const FORMAT_POTENTIAL = defineVocabulary({
  briefing: 'Weekly Briefing item',
  feature: 'Feature / editorial',
  interview: 'Interview',
  guide: 'Guide / curated selection',
  short_video: 'Short-form video',
  flagship_film: 'Flagship film',
});
export type FormatPotential = (typeof FORMAT_POTENTIAL.ids)[number];

export const TIMELINESS = defineVocabulary({
  urgent: 'Urgent',
  this_week: 'This week',
  upcoming: 'Upcoming',
  evergreen: 'Evergreen',
});
export type Timeliness = (typeof TIMELINESS.ids)[number];

export const VERIFICATION_STATUS = defineVocabulary({
  unverified: 'Unverified',
  basic_facts_checked: 'Basic facts checked',
  primary_source_verified: 'Primary-source verified',
  editor_approved: 'Editor approved',
  rejected: 'Rejected',
});
export type VerificationStatus = (typeof VERIFICATION_STATUS.ids)[number];

export const RECOMMENDED_ACTIONS = defineVocabulary({
  reject: 'Reject',
  monitor: 'Monitor',
  research: 'Research',
  shortlist: 'Shortlist',
  pitch: 'Pitch',
  urgent_review: 'Urgent human review',
});
export type RecommendedAction = (typeof RECOMMENDED_ACTIONS.ids)[number];

export const CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];
