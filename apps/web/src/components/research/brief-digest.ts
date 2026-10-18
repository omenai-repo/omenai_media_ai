import type { BriefClaimDto, ResearchBriefDto, ResearchViewDto } from '@repo/core';

import { needsChecking } from './citation';

/**
 * How a research brief is presented: a short reply first (overview, findings, why it matters,
 * what's still to confirm), deeper material on request, and the evidence checks summarised in
 * plain words. Presentation only: every claim keeps its stored citation status, and nothing the
 * checks flagged is dropped or reworded here.
 */
export interface BriefDigest {
  overview: BriefClaimDto[];
  /** A brief written before sections had kinds has its overview as plain text instead. */
  legacyOverview: string | null;
  findings: BriefClaimDto[];
  whyItMatters: BriefClaimDto[];
  /** Includes open questions filed elsewhere, so uncertainty is never read as settled prose. */
  toConfirm: BriefClaimDto[];
  /** Opened on request, with people to approach and next steps. */
  background: BriefClaimDto[];
  hasMore: boolean;
  evidence: EvidenceSummary;
}

export interface EvidenceSummary {
  /** `check` when something the editor can see needs checking before use. */
  tone: 'clear' | 'check';
  /** One or two sentences for the line under the reply. */
  text: string;
  verified: number;
  /** Claims whose quoted passage wasn't found in their source (or that quoted nothing). */
  unchecked: BriefClaimDto[];
  /** How many of those sit in the background, behind "More detail". */
  uncheckedInBackground: number;
  /** Claims left out because they cited no source we have. */
  leftOut: number;
  /** Search results set aside as not about this story. */
  setAside: number;
  /** Analysis and open questions that quote nothing (by design, not a failure). */
  unquoted: number;
}

type Part = 'overview' | 'findings' | 'why' | 'confirm' | 'background';

/** Where a section goes; briefs from before the concise format are placed by their title. */
function partOf(section: ResearchBriefDto['sections'][number]): Part {
  switch (section.kind) {
    // A focused follow-up's answer reads first, like an overview.
    case 'answer':
    case 'overview':
      return 'overview';
    case 'why_it_matters':
      return 'why';
    case 'findings':
      return 'findings';
    case 'to_confirm':
      return 'confirm';
    case 'background':
      return 'background';
    default:
      if (/why it matters/i.test(section.title)) return 'why';
      if (/unresolved|open question|to confirm/i.test(section.title)) return 'confirm';
      if (/background|context|people|institution/i.test(section.title)) return 'background';
      return 'findings';
  }
}

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
const number = (n: number) => WORDS[n] ?? String(n);
const points = (n: number) => `${number(n)} ${n === 1 ? 'point' : 'points'}`;

export function digestBrief(brief: ResearchBriefDto): BriefDigest {
  const parts: Record<Part, BriefClaimDto[]> = {
    overview: [],
    findings: [],
    why: [],
    confirm: [],
    background: [],
  };
  for (const section of brief.sections) {
    const part = partOf(section);
    // An answer keeps its own "the sources don't establish this" first, where it was written.
    const keepInPlace = part === 'background' || section.kind === 'answer';
    for (const claim of section.claims)
      parts[claim.type === 'open_question' && !keepInPlace ? 'confirm' : part].push(claim);
  }

  const all = brief.sections.flatMap((s) => s.claims);
  const unchecked = all.filter((c) => needsChecking(c.citationStatus));
  const uncheckedInBackground = parts.background.filter((c) =>
    needsChecking(c.citationStatus),
  ).length;
  const verified = all.filter((c) => c.citationStatus === 'verified').length;
  const leftOut = brief.droppedClaims;

  const sentences = [
    `Drawn from ${number(brief.sources.length).toLowerCase()} ${brief.sources.length === 1 ? 'source' : 'sources'}.`,
  ];
  if (unchecked.length) {
    const one = unchecked.length === 1;
    const where = !uncheckedInBackground
      ? ''
      : uncheckedInBackground === unchecked.length
        ? `, under More detail`
        : ` (${number(uncheckedInBackground).toLowerCase()} under More detail)`;
    sentences.push(
      'Some details still need to be confirmed.',
      `${points(unchecked.length)} couldn’t be checked against ${one ? 'its source' : 'their sources'} and ${one ? 'is' : 'are'} marked for checking${where}.`,
    );
    const conflicting = unchecked.filter((c) => c.citationStatus === 'conflicting').length;
    if (conflicting)
      sentences.push(
        `The sources give different dates or figures in ${points(conflicting).toLowerCase()}.`,
      );
  } else if (verified) {
    sentences.push('Every quoted passage was found in its source.');
  } else {
    sentences.push('Nothing here quotes a source directly yet, so treat it as a starting point.');
  }
  if (leftOut)
    sentences.push(
      `${points(leftOut)} with no traceable source ${leftOut === 1 ? 'was' : 'were'} left out.`,
    );

  return {
    overview: parts.overview,
    // Only briefs from before sections had kinds keep their overview as plain text.
    legacyOverview: brief.sections.some((s) => s.kind !== null) ? null : brief.overview,
    findings: parts.findings,
    whyItMatters: parts.why,
    toConfirm: parts.confirm,
    background: parts.background,
    hasMore: Boolean(
      parts.background.length ||
      brief.peopleToApproach.length ||
      brief.verificationChecklist.length,
    ),
    evidence: {
      tone: unchecked.length ? 'check' : 'clear',
      text: sentences.join(' '),
      verified,
      unchecked,
      uncheckedInBackground,
      leftOut,
      setAside: brief.discardedResults,
      unquoted: all.filter((c) => c.citationStatus === 'uncited').length,
    },
  };
}

/** "Background, one person to approach and three next steps": what "More detail" holds. */
export function moreDetailHint(brief: ResearchBriefDto, digest: BriefDigest): string {
  const items = [
    digest.background.length ? 'background' : null,
    brief.peopleToApproach.length
      ? `${number(brief.peopleToApproach.length).toLowerCase()} ${brief.peopleToApproach.length === 1 ? 'person' : 'people'} to approach`
      : null,
    brief.verificationChecklist.length
      ? `${number(brief.verificationChecklist.length).toLowerCase()} next ${brief.verificationChecklist.length === 1 ? 'step' : 'steps'}`
      : null,
  ].filter((s): s is string => Boolean(s));
  const text =
    items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : (items[0] ?? '');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Words in what the editor reads first; used to keep fixtures honest about length. */
export function leadWordCount(digest: BriefDigest): number {
  return [...digest.overview, ...digest.findings, ...digest.whyItMatters, ...digest.toConfirm]
    .map((c) => c.text)
    .concat(digest.legacyOverview ?? '')
    .join(' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

/**
 * For the Sources panel: how the passages quoted from each source checked out, across every
 * brief and answer in the conversation. A claim's check belongs to its first cited source.
 */
export function sourceChecks(
  view: Pick<ResearchViewDto, 'briefs' | 'messages'>,
): Record<string, { found: number; notFound: number }> {
  const checks: Record<string, { found: number; notFound: number }> = {};
  const add = (sourceId: string | undefined, status: BriefClaimDto['citationStatus']) => {
    if (!sourceId || status === 'uncited') return;
    const entry = (checks[sourceId] ??= { found: 0, notFound: 0 });
    if (status === 'verified') entry.found += 1;
    else entry.notFound += 1;
  };
  for (const brief of view.briefs)
    for (const claim of brief.sections.flatMap((s) => s.claims)) {
      const first = claim.sourceLabels[0];
      add(brief.sources.find((s) => s.label === first)?.sourceId, claim.citationStatus);
    }
  for (const message of view.messages) {
    for (const citation of message.citations) add(citation.sourceId, citation.citationStatus);
    for (const claim of message.claims ?? []) add(claim.sourceIds[0], claim.citationStatus);
  }
  return checks;
}
