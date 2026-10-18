import type { BriefClaimDto, ResearchBriefDto } from '@repo/core';
import { describe, expect, it } from 'vitest';

import { digestBrief, leadWordCount, moreDetailHint } from './brief-digest';

const claim = (
  type: BriefClaimDto['type'],
  text: string,
  citationStatus: BriefClaimDto['citationStatus'] = type === 'fact' || type === 'attributed'
    ? 'verified'
    : 'uncited',
  sourceLabels = citationStatus === 'uncited' ? [] : ['S1'],
): BriefClaimDto => ({
  type,
  text,
  sourceLabels,
  excerpt: citationStatus === 'uncited' ? null : 'a passage from the source',
  citationStatus,
});

function brief(
  sections: ResearchBriefDto['sections'],
  extra: Partial<ResearchBriefDto> = {},
): ResearchBriefDto {
  return {
    id: 'b1',
    createdAt: '2026-10-15T09:00:00.000Z',
    evidence: null,
    depth: 'standard',
    requestKind: 'auto',
    requestedBy: null,
    focus: null,
    fromMessageId: null,
    overview: '',
    sections,
    sources: [
      { label: 'S1', sourceId: 'a' },
      { label: 'S2', sourceId: 'b' },
      { label: 'S3', sourceId: 'c' },
    ],
    peopleToApproach: [],
    verificationChecklist: [],
    droppedClaims: 0,
    discardedResults: 0,
    searchFailures: 0,
    counts: { verified: 0, unconfirmed: 0, uncited: 0 },
    evidenceCheck: null,
    ...extra,
  };
}

const total = (d: ReturnType<typeof digestBrief>) =>
  d.overview.length +
  d.findings.length +
  d.whyItMatters.length +
  d.toConfirm.length +
  d.background.length;

describe('research brief presentation', () => {
  it('shows a short, fully checked brief whole, with nothing hidden', () => {
    const short = brief([
      {
        kind: 'overview',
        title: 'Overview',
        claims: [claim('fact', 'A market hall in Casablanca reopens after restoration.')],
      },
      {
        kind: 'findings',
        title: 'What we found',
        claims: [claim('attributed', 'The heritage trust says the work took four years.')],
      },
      {
        kind: 'why_it_matters',
        title: 'Why it matters',
        claims: [claim('analysis', 'It is a living example of heritage put back to daily use.')],
      },
    ]);
    const digest = digestBrief(short);
    expect(digest.hasMore).toBe(false);
    expect(digest.legacyOverview).toBeNull();
    expect(digest.evidence).toMatchObject({ tone: 'clear', verified: 2, unquoted: 1 });
    expect(digest.evidence.text).toBe(
      'Drawn from three sources. Every quoted passage was found in its source.',
    );
    expect(leadWordCount(digest)).toBeLessThan(250);
  });

  it('keeps every caveat of a complex brief visible or named, never softened', () => {
    const unmatchedLead = claim(
      'attributed',
      'The organisers say they expect 200,000 visitors.',
      'excerpt_not_located',
    );
    const unmatchedBackground = claim(
      'attributed',
      'The organisers say each venue will host talks.',
      'excerpt_not_located',
    );
    // Misfiled by the model: an open question among the findings.
    const misfiled = claim('open_question', 'It isn’t clear who funds the floating gallery.');
    const complex = brief(
      [
        {
          kind: 'overview',
          title: 'Overview',
          claims: [claim('fact', 'A textile biennale opened across eleven venues in Lagos.')],
        },
        {
          kind: 'why_it_matters',
          title: 'Why it matters',
          claims: [claim('analysis', 'It treats weaving as contemporary practice.')],
        },
        {
          kind: 'findings',
          title: 'What we found',
          claims: [claim('fact', 'A guide maps the venues.'), unmatchedLead, misfiled],
        },
        {
          kind: 'to_confirm',
          title: 'Still to confirm',
          claims: [claim('open_question', 'Is it really the first in West Africa?')],
        },
        {
          kind: 'background',
          title: 'Background',
          claims: [claim('fact', 'Critics have followed it closely.'), unmatchedBackground],
        },
      ],
      {
        droppedClaims: 1,
        discardedResults: 2,
        peopleToApproach: [{ name: 'A. Person', role: 'Director', why: 'Named', sourceLabels: [] }],
        verificationChecklist: ['Ask for the source of the claim.', 'Confirm the dates.'],
      },
    );
    const digest = digestBrief(complex);

    // Nothing is lost: every stored claim is placed somewhere, with its status untouched.
    expect(total(digest)).toBe(complex.sections.flatMap((s) => s.claims).length);
    expect(digest.findings).toContain(unmatchedLead);
    expect(unmatchedLead.citationStatus).toBe('excerpt_not_located');
    // Uncertainty is never read as settled prose.
    expect(digest.findings).not.toContain(misfiled);
    expect(digest.toConfirm).toEqual([
      misfiled,
      expect.objectContaining({ type: 'open_question' }),
    ]);
    // Caveats behind "More detail" are still counted and pointed to.
    expect(digest.evidence).toMatchObject({
      tone: 'check',
      uncheckedInBackground: 1,
      leftOut: 1,
      setAside: 2,
    });
    expect(digest.evidence.unchecked).toEqual([unmatchedLead, unmatchedBackground]);
    expect(digest.evidence.text).toBe(
      'Drawn from three sources. Some details still need to be confirmed. Two points couldn’t be checked against their sources and are marked for checking (one under More detail). One point with no traceable source was left out.',
    );
    expect(digest.hasMore).toBe(true);
    expect(moreDetailHint(complex, digest)).toBe(
      'Background, one person to approach and two next steps',
    );
  });

  it('never calls a brief that quotes nothing checked', () => {
    const digest = digestBrief(
      brief([
        {
          kind: 'why_it_matters',
          title: 'Why it matters',
          claims: [claim('analysis', 'It may matter.')],
        },
      ]),
    );
    expect(digest.evidence.text).toContain('Nothing here quotes a source directly yet');
  });

  it('still presents briefs written before the concise format', () => {
    const legacy = brief(
      [
        {
          kind: null,
          title: 'Key developments',
          claims: [claim('fact', 'It opened.'), claim('open_question', 'When does it close?')],
        },
        {
          kind: null,
          title: 'Background and context',
          claims: [claim('fact', 'It took a decade.')],
        },
        {
          kind: null,
          title: 'Unresolved questions',
          claims: [claim('open_question', 'Is it the first?')],
        },
      ],
      { overview: 'A biennale opens.' },
    );
    const digest = digestBrief(legacy);
    expect(digest.legacyOverview).toBe('A biennale opens.');
    expect(digest.findings.map((c) => c.text)).toEqual(['It opened.']);
    expect(digest.toConfirm.map((c) => c.text)).toEqual([
      'When does it close?',
      'Is it the first?',
    ]);
    expect(digest.background.map((c) => c.text)).toEqual(['It took a decade.']);
    expect(total(digest)).toBe(4);
  });
});

describe('a focused follow-up', () => {
  it('reads its answer first, keeping "the sources don’t establish this" in the answer', () => {
    const digest = digestBrief(
      brief(
        [
          {
            kind: 'answer',
            title: 'Answer',
            claims: [
              claim('open_question', 'The sources don’t establish when she took up the title.'),
              claim('attributed', 'One biography says she has been a curator there since 1996.'),
            ],
          },
          {
            kind: 'to_confirm',
            title: 'Still to confirm',
            claims: [claim('open_question', 'Ask the museum for the appointment date.')],
          },
        ],
        { focus: 'When was she appointed?', requestKind: 'lead', evidence: 'insufficient' },
      ),
    );
    expect(digest.overview.map((c) => c.text)).toEqual([
      'The sources don’t establish when she took up the title.',
      'One biography says she has been a curator there since 1996.',
    ]);
    expect(digest.toConfirm.map((c) => c.text)).toEqual([
      'Ask the museum for the appointment date.',
    ]);
    expect(digest.legacyOverview).toBeNull();
    expect(digest.whyItMatters).toEqual([]);
  });

  it('counts a quote that lacks the date or figure as needing a check, never as found', () => {
    const digest = digestBrief(
      brief([
        {
          kind: 'answer',
          title: 'Answer',
          claims: [claim('fact', 'She was appointed in 2003.', 'detail_not_in_excerpt')],
        },
      ]),
    );
    expect(digest.evidence.verified).toBe(0);
    expect(digest.evidence.unchecked).toHaveLength(1);
    expect(digest.evidence.tone).toBe('check');
  });
});
