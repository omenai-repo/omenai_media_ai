'use client';

import type {
  BriefClaimDto,
  ChatClaimDto,
  ChatMessageDto,
  EvidenceCheck,
  ResearchBriefDto,
  ResearchSourceDto,
  ResearchTaskDto,
} from '@repo/core';
import { Check, CircleCheck, Loader2, Search, Sparkles, TriangleAlert } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';

import { formatDate, formatTime } from '@/components/editorial/format';
import { Disclosure } from '@/components/editorial/primitives';
import { ProgressSteps } from '@/components/progress/progress-steps';
import {
  chatSteps,
  failureText,
  NOTICE_TEXT,
  researchSteps,
  slowText,
  waitingText,
  type RecordedProgress,
} from '@/components/progress/steps';
import { useElapsed } from '@/components/progress/use-elapsed';
import { useRevealedText } from '@/components/progress/use-revealed-text';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { digestBrief, moreDetailHint } from './brief-digest';
import { Citation, sourceNote } from './citation';

type Sources = Record<string, ResearchSourceDto>;

/**
 * Why the checks lowered an answer's own "the evidence is sufficient" (ADR-039), said after how
 * fully the sources answer the question.
 */
const EVIDENCE_CHECK_TEXT: Record<EvidenceCheck, string> = {
  no_checked_facts: 'None of the answer’s points could be matched to a quote in the sources.',
  asked_detail_unchecked: 'No quote I found confirms the exact date, figure or name asked about.',
  conflicting: 'The sources give different dates or figures for it.',
};
const evidenceCheckText = (check: EvidenceCheck | null) =>
  check ? ` ${EVIDENCE_CHECK_TEXT[check]}` : '';

/** Reading text for every assistant turn: one size, so briefs and answers feel like one voice. */
const PROSE = 'font-serif text-[1.125rem] leading-[1.75] text-ink';

/** The assistant's mark: an ink monogram in the masthead face, never an avatar of a person. */
function AssistantByline({ at, label }: { at: string; label?: string }) {
  return (
    <p className="mb-3 flex items-center gap-2.5">
      <span
        aria-hidden
        className="masthead flex size-7 items-center justify-center rounded-full bg-ink text-sm leading-none text-ivory"
      >
        O
      </span>
      <span className="text-[0.84375rem] font-semibold text-ink">Omenai</span>
      <span className="meta">
        {label ? `${label} · ` : ''}
        {formatTime(at)}
      </span>
    </p>
  );
}

/** A centred line for things Omenai or an editor set in motion (not something anyone typed). */
export function RequestLine({ children, at }: { children: ReactNode; at?: string | null }) {
  return (
    <div className="flex items-center gap-4 py-1" role="note">
      <span aria-hidden className="h-px flex-1 bg-hairline" />
      <p className="max-w-[64ch] text-center text-[0.78125rem] leading-relaxed text-slate">
        {children}
        {at ? <span className="ml-1 whitespace-nowrap">· {formatTime(at)}</span> : null}
      </p>
      <span aria-hidden className="h-px flex-1 bg-hairline" />
    </div>
  );
}

export function briefRequestText(
  brief: Pick<ResearchBriefDto, 'requestKind' | 'requestedBy' | 'focus'>,
): string {
  if (brief.requestKind === 'auto')
    return 'Omenai started researching this story when the workspace opened';
  if (brief.requestKind === 'lead')
    return `${brief.requestedBy ?? 'An editor'} asked Omenai to look into: ${brief.focus ?? 'a lead'}`;
  return `Research requested by ${brief.requestedBy ?? 'an editor'}`;
}

/**
 * How a claim's kind is explained to assistive technology and on hover. Visually, the writing
 * carries it ("the organisers say…", "it isn't yet clear…"), not a label.
 */
const CLAIM_HINT: Partial<Record<BriefClaimDto['type'], string>> = {
  attributed: 'Attributed to a source',
  analysis: 'Omenai’s analysis',
  open_question: 'Still open',
};

function ClaimCitations({
  claim,
  brief,
  sources,
}: {
  claim: BriefClaimDto;
  brief: ResearchBriefDto;
  sources: Sources;
}) {
  const idFor = (label: string) => brief.sources.find((s) => s.label === label)?.sourceId;
  return claim.sourceLabels.map((label, i) => (
    <Citation
      key={label}
      label={label}
      source={sources[idFor(label) ?? '']}
      // The excerpt, and so the check, belongs to the first cited source.
      excerpt={i === 0 ? claim.excerpt : null}
      status={i === 0 ? claim.citationStatus : 'uncited'}
      also={i > 0}
    />
  ));
}

/** One claim as a sentence in running prose, with its sources after it. */
function ClaimText({
  claim,
  brief,
  sources,
}: {
  claim: BriefClaimDto;
  brief: ResearchBriefDto;
  sources: Sources;
}) {
  const hint = CLAIM_HINT[claim.type];
  return (
    <>
      <span title={claim.type === 'attributed' ? undefined : hint}>
        {hint ? <span className="sr-only">({hint}) </span> : null}
        {claim.text}
      </span>
      <ClaimCitations claim={claim} brief={brief} sources={sources} />{' '}
    </>
  );
}

function Prose({
  claims,
  brief,
  sources,
  lead,
  className,
}: {
  claims: BriefClaimDto[];
  brief: ResearchBriefDto;
  sources: Sources;
  /** A run-in heading, e.g. "Why it matters". */
  lead?: string;
  className?: string;
}) {
  return (
    <p className={cn(PROSE, className)}>
      {lead ? (
        <strong className="mr-1.5 font-sans text-sm font-semibold text-ink">{lead}.</strong>
      ) : null}
      {claims.map((claim, i) => (
        <ClaimText key={i} claim={claim} brief={brief} sources={sources} />
      ))}
    </p>
  );
}

function SourceList({ brief, sources }: { brief: ResearchBriefDto; sources: Sources }) {
  return (
    <ol className="space-y-3">
      {brief.sources.map((s) => {
        const source = sources[s.sourceId];
        return source ? (
          <li key={s.label} className="flex gap-3">
            <span className="w-6 shrink-0 text-sm font-semibold text-ink tabular-nums">
              {s.label}
            </span>
            <span className="min-w-0">
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-link font-serif text-ink"
              >
                {source.headline}
              </a>
              <span className="meta block">
                {source.publisher} ·{' '}
                {source.publishedAt ? formatDate(source.publishedAt) : 'Date not given'} ·{' '}
                {sourceNote(source)}
              </span>
            </span>
          </li>
        ) : null;
      })}
    </ol>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Omenai's research briefing as a reply: a few short paragraphs first (what's happening, what we
 * found, why it matters, what's still to confirm), then the deeper material and the evidence
 * checks on request. Every caveat stays visible or is named in the evidence line.
 */
export function BriefTurn({ brief, sources }: { brief: ResearchBriefDto; sources: Sources }) {
  const digest = digestBrief(brief);
  const { evidence } = digest;
  const titleId = `brief-${brief.id}-title`;
  const empty =
    !digest.legacyOverview &&
    !digest.overview.length &&
    !digest.findings.length &&
    !digest.whyItMatters.length;
  return (
    <article aria-labelledby={titleId}>
      <AssistantByline
        at={brief.createdAt}
        label={brief.focus ? 'Follow-up research' : 'Research briefing'}
      />
      <h2 id={titleId} className="sr-only">
        {brief.focus ? `Follow-up research: ${brief.focus}` : 'Research briefing'}
      </h2>

      <div className="space-y-4">
        {digest.legacyOverview ? <p className={PROSE}>{digest.legacyOverview}</p> : null}
        {digest.overview.length ? (
          <Prose claims={digest.overview} brief={brief} sources={sources} />
        ) : null}
        {digest.findings.length ? (
          <Prose claims={digest.findings} brief={brief} sources={sources} />
        ) : null}
        {digest.whyItMatters.length ? (
          <Prose
            claims={digest.whyItMatters}
            brief={brief}
            sources={sources}
            lead="Why it matters"
          />
        ) : null}
        {empty ? (
          <p className={PROSE}>
            Nothing I found passed our source checks well enough to report yet.
          </p>
        ) : null}
        {brief.evidence && brief.evidence !== 'sufficient' ? (
          <p className="meta">
            {brief.evidence === 'partial'
              ? 'The sources only partly answer this.'
              : 'The sources don’t answer this.'}
            {evidenceCheckText(brief.evidenceCheck)}
          </p>
        ) : null}
        {digest.toConfirm.length ? (
          <section
            aria-labelledby={`${titleId}-confirm`}
            className="rounded-xl bg-[#f5f4f0] px-4 py-3"
          >
            <h3 id={`${titleId}-confirm`} className="text-[0.9375rem] font-semibold text-ink">
              Still to confirm
            </h3>
            <ul className="mt-2 space-y-2">
              {digest.toConfirm.map((claim, i) => (
                <li key={i} className="flex gap-3">
                  <span
                    aria-hidden
                    className="mt-[0.6rem] size-2 shrink-0 rounded-full border-[1.5px] border-amber"
                  />
                  <span className={cn(PROSE, 'text-[1.0625rem]')}>
                    <ClaimText claim={claim} brief={brief} sources={sources} />
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <p className="mt-5 flex items-start gap-2 text-sm leading-relaxed text-graphite">
        {evidence.tone === 'clear' ? (
          <CircleCheck className="mt-0.5 size-4 shrink-0 text-moss" aria-hidden />
        ) : (
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber" aria-hidden />
        )}
        <span>{evidence.text}</span>
      </p>

      <div className="mt-3 border-b border-hairline text-[0.9375rem]">
        {digest.hasMore ? (
          <Disclosure summary="More detail" hint={moreDetailHint(brief, digest)}>
            <div className="space-y-6">
              {digest.background.length ? (
                <section>
                  <h3 className="mb-2 font-semibold text-ink">Background</h3>
                  <Prose
                    claims={digest.background}
                    brief={brief}
                    sources={sources}
                    className="text-[1.0625rem]"
                  />
                </section>
              ) : null}
              {brief.peopleToApproach.length ? (
                <section>
                  <h3 className="mb-2 font-semibold text-ink">People to approach</h3>
                  <ul className="grid gap-4 sm:grid-cols-2">
                    {brief.peopleToApproach.map((p) => (
                      <li key={`${p.name}-${p.role}`} className="border-l border-hairline pl-3">
                        <p className="font-medium text-ink">{p.name}</p>
                        {p.role ? <p className="text-sm text-graphite">{p.role}</p> : null}
                        {p.why ? <p className="meta mt-1">{p.why}</p> : null}
                      </li>
                    ))}
                  </ul>
                  <p className="meta mt-2">
                    Named in the sources. Access to anyone isn’t confirmed.
                  </p>
                </section>
              ) : null}
              {brief.verificationChecklist.length ? (
                <section>
                  <h3 className="mb-2 font-semibold text-ink">Suggested next steps</h3>
                  <ul className="space-y-2">
                    {brief.verificationChecklist.map((item) => (
                      <li key={item} className="flex gap-2.5 leading-relaxed text-ink">
                        <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-ink" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
          </Disclosure>
        ) : null}
        <Disclosure
          summary="Sources and evidence"
          hint={`${plural(brief.sources.length, 'source', 'sources')} · how each point was checked`}
        >
          <div className="space-y-6">
            <section>
              <h3 className="mb-2 font-semibold text-ink">How this was checked</h3>
              <ul className="space-y-2 text-ink">
                {evidence.verified ? (
                  <li className="flex gap-2.5">
                    <CircleCheck className="mt-1 size-4 shrink-0 text-moss" aria-hidden />
                    <span>
                      {plural(evidence.verified, 'point quotes', 'points quote')} a passage we
                      found, word for word, in its source.
                    </span>
                  </li>
                ) : null}
                {evidence.unchecked.length ? (
                  <li className="flex gap-2.5">
                    <TriangleAlert className="mt-1 size-4 shrink-0 text-amber" aria-hidden />
                    <span>
                      {evidence.unchecked.length === 1
                        ? 'This point couldn’t be checked against its source. Confirm it before relying on it:'
                        : 'These points couldn’t be checked against their sources. Confirm them before relying on them:'}
                      <ul className="mt-2 space-y-1.5">
                        {evidence.unchecked.map((claim, i) => (
                          <li key={i} className="font-serif text-[1.0625rem] leading-relaxed">
                            {claim.text}
                            <ClaimCitations claim={claim} brief={brief} sources={sources} />
                          </li>
                        ))}
                      </ul>
                    </span>
                  </li>
                ) : null}
                {evidence.unquoted ? (
                  <li className="flex gap-2.5 text-graphite">
                    <span
                      aria-hidden
                      className="mx-1.5 mt-2.5 size-1 shrink-0 rounded-full bg-stone"
                    />
                    <span>
                      {plural(evidence.unquoted, 'point is', 'points are')} Omenai’s own reading or
                      an open question, so {evidence.unquoted === 1 ? 'it quotes' : 'they quote'}{' '}
                      nothing.
                    </span>
                  </li>
                ) : null}
                {evidence.leftOut ? (
                  <li className="flex gap-2.5 text-graphite">
                    <span
                      aria-hidden
                      className="mx-1.5 mt-2.5 size-1 shrink-0 rounded-full bg-stone"
                    />
                    <span>
                      {plural(evidence.leftOut, 'point was', 'points were')} left out because{' '}
                      {evidence.leftOut === 1 ? 'it' : 'they'} cited a source this research doesn’t
                      have.
                    </span>
                  </li>
                ) : null}
                {evidence.setAside ? (
                  <li className="flex gap-2.5 text-graphite">
                    <span
                      aria-hidden
                      className="mx-1.5 mt-2.5 size-1 shrink-0 rounded-full bg-stone"
                    />
                    <span>
                      {plural(evidence.setAside, 'search result was', 'search results were')} set
                      aside as not about this story.
                    </span>
                  </li>
                ) : null}
              </ul>
            </section>
            <section>
              <h3 className="mb-2 font-semibold text-ink">Sources</h3>
              <SourceList brief={brief} sources={sources} />
            </section>
          </div>
        </Disclosure>
      </div>
    </article>
  );
}

/**
 * A reply as checked statements: each sentence followed by its own sources, so every quote sits
 * next to the claim it is offered for.
 */
function ClaimsAnswer({ claims, sources }: { claims: ChatClaimDto[]; sources: Sources }) {
  return claims.map((claim, i) => {
    const hint = CLAIM_HINT[claim.type];
    return (
      <span key={i}>
        <span title={claim.type === 'attributed' ? undefined : hint}>
          {hint ? <span className="sr-only">({hint}) </span> : null}
          {claim.text}
        </span>
        {claim.sourceLabels.map((label, j) => (
          <Citation
            key={label}
            label={label}
            source={sources[claim.sourceIds[j] ?? '']}
            // The excerpt, and so the check, belongs to the first cited source.
            excerpt={j === 0 ? claim.excerpt : null}
            status={j === 0 ? claim.citationStatus : 'uncited'}
            also={j > 0}
          />
        ))}{' '}
      </span>
    );
  });
}

/** Renders "[S2]" markers in an older answer as citation chips. */
function AnswerText({ message, sources }: { message: ChatMessageDto; sources: Sources }) {
  return (
    <>
      {message.content.split(/(\[S\d+\])/g).map((part, i) => {
        const label = /^\[(S\d+)\]$/.exec(part)?.[1];
        if (!label) return <span key={i}>{part}</span>;
        const citation = message.citations.find((c) => c.label === label);
        return (
          <Citation
            key={i}
            label={label}
            source={citation ? sources[citation.sourceId] : undefined}
            excerpt={citation?.excerpt ?? null}
            status={citation?.citationStatus ?? 'excerpt_not_located'}
          />
        );
      })}
    </>
  );
}

export function UserTurn({
  message,
  pending = false,
}: {
  message: Pick<ChatMessageDto, 'content' | 'author' | 'createdAt'>;
  pending?: boolean;
}) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[min(34rem,88%)]">
        <p className="meta mb-1 text-right">
          {message.author} · {pending ? 'Sending…' : formatTime(message.createdAt)}
        </p>
        <div
          className={cn(
            'rounded-[18px] rounded-br-md bg-[#f1f0ec] px-4.5 py-3 text-base leading-normal whitespace-pre-line text-ink',
            pending && 'opacity-70',
          )}
        >
          {message.content}
        </div>
      </div>
    </div>
  );
}

/**
 * The research a reply started on its own, as the workspace knows it: its findings once saved,
 * the task while it runs, or the attempt that stopped (ADR-038).
 */
export interface FollowUpState {
  brief: ResearchBriefDto | null;
  task: ResearchTaskDto | null;
  failure: ResearchTaskDto | null;
  serverNow: string;
  /** Something else holds the story, so research can't be started from here right now. */
  busy: boolean;
  /** Researches the reply's question (again). */
  onResearch: () => void;
}

export function AnswerTurn({
  message,
  sources,
  leadState,
  onResearchLead,
  followUp = null,
}: {
  message: ChatMessageDto;
  sources: Sources;
  /** `offer`: can be researched now; `done`: already followed up below; `busy`: wait. */
  leadState: 'offer' | 'done' | 'busy' | null;
  onResearchLead: () => void;
  followUp?: FollowUpState | null;
}) {
  if (message.scope === 'unrelated') {
    return (
      <div>
        <AssistantByline at={message.createdAt} />
        <div className="rounded-[14px] bg-bone px-4 py-3">
          <p className="text-[0.9375rem] leading-relaxed text-ink">{message.content}</p>
        </div>
      </div>
    );
  }
  return (
    <div>
      <AssistantByline at={message.createdAt} />
      <div>
        <p className={cn(PROSE, 'whitespace-pre-line')}>
          {message.claims ? (
            <ClaimsAnswer claims={message.claims} sources={sources} />
          ) : (
            <AnswerText message={message} sources={sources} />
          )}
        </p>
        {message.evidence && message.evidence !== 'sufficient' ? (
          <p className="meta mt-2">
            {message.evidence === 'partial'
              ? 'The research so far only partly answers this.'
              : 'The research so far doesn’t answer this.'}
            {evidenceCheckText(message.evidenceCheck)}
          </p>
        ) : null}
        {message.droppedLabels.length ? (
          <p className="meta mt-1">I removed a reference to a source outside this research.</p>
        ) : null}
        {message.droppedClaims ? (
          <p className="meta mt-1">
            I left out{' '}
            {message.droppedClaims === 1 ? 'a statement' : `${message.droppedClaims} statements`}{' '}
            that cited no source in this research.
          </p>
        ) : null}
        {message.followUp && followUp ? (
          <FollowUp question={message.followUp} state={followUp} sources={sources} />
        ) : message.suggestedFocus && leadState ? (
          <div className="surface mt-4 p-4">
            <p className="text-sm text-ink">
              <Search className="mr-1.5 inline size-3.5 text-ink" aria-hidden />
              Omenai can research this lead:{' '}
              <span className="font-serif italic">“{message.suggestedFocus}”</span>
            </p>
            {leadState === 'done' ? (
              <p className="meta mt-2 inline-flex items-center gap-1.5">
                <Check className="size-3.5 text-moss" aria-hidden /> Researched below
              </p>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                disabled={leadState === 'busy'}
                onClick={onResearchLead}
              >
                Research this lead
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The follow-up sits inside the reply it continues: one answer to one question. */
function FollowUpFrame({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section
      aria-label={label}
      className="mt-4 rise-in rounded-[14px] bg-[#f5f4f0] px-4.5 pt-3.5 pb-4"
    >
      {children}
    </section>
  );
}

const SKIPPED: Record<NonNullable<NonNullable<ChatMessageDto['followUp']>['reason']>, string> = {
  already_researched:
    'Omenai looked into this in the past week, and what it found is part of the saved research above.',
  busy: 'I couldn’t check further just now, because other research was running for this story.',
  usage_limit:
    'I couldn’t check further: today’s research limit has been reached. It frees up as earlier use ages out.',
  error: 'I couldn’t start checking further because of a technical problem.',
};

const SKIPPED_ACTION: Partial<
  Record<NonNullable<NonNullable<ChatMessageDto['followUp']>['reason']>, string>
> = {
  already_researched: 'Look again',
  busy: 'Check further',
  error: 'Try again',
};

/**
 * What the reply's own research is doing: checking further (with its real steps), what it found,
 * or why it didn't finish or didn't start, with what the editor can do next.
 */
function FollowUp({
  question,
  state,
  sources,
}: {
  question: NonNullable<ChatMessageDto['followUp']>;
  state: FollowUpState;
  sources: Sources;
}) {
  if (state.brief) return <FollowUpFindings brief={state.brief} sources={sources} />;
  if (state.task)
    return (
      <FollowUpProgress
        task={state.task}
        question={question.question}
        serverNow={state.serverNow}
      />
    );
  const action = (label: string) => (
    <Button
      variant="outline"
      size="sm"
      className="mt-3"
      disabled={state.busy}
      onClick={state.onResearch}
    >
      {label}
    </Button>
  );
  if (state.failure)
    return (
      <FollowUpFrame label="Checking further">
        <p className="text-[0.9375rem] text-ink" role="alert">
          I couldn’t finish checking further. {failureText(state.failure.lastError)} The answer
          above is saved.
        </p>
        {action('Try again')}
      </FollowUpFrame>
    );
  if (question.status === 'started')
    return (
      <FollowUpFrame label="Checking further">
        <p className="text-[0.9375rem] text-ink" role="status">
          I couldn’t confirm that in our saved research, so I’m checking further.
        </p>
      </FollowUpFrame>
    );
  const reason = question.reason ?? 'error';
  const label = SKIPPED_ACTION[reason];
  return (
    <FollowUpFrame label="Checking further">
      <p className="text-[0.9375rem] text-graphite">{SKIPPED[reason]}</p>
      {label ? action(label) : null}
    </FollowUpFrame>
  );
}

/** Research under way for the reply: the gap, the question, and the steps actually taken. */
function FollowUpProgress({
  task,
  question,
  serverNow,
}: {
  task: ResearchTaskDto;
  question: string;
  serverNow: string;
}) {
  const queued = task.status === 'queued';
  const waiting = waitingText(task, 'research');
  const elapsed = useElapsed(queued ? task.updatedAt : task.stepStartedAt, serverNow);
  const slow = slowText('research', queued ? 'waiting' : 'working', elapsed ?? 0);
  const steps = researchSteps(queued ? { step: null, steps: [] } : task, { lead: true });
  return (
    <FollowUpFrame label="Checking further">
      <p className="text-[0.9375rem] text-ink">
        I couldn’t confirm that in our saved research, so I’m checking further.
      </p>
      <p className="meta mt-1">Looking into: “{question}”</p>
      {waiting ? (
        <p className="mt-3 flex items-start gap-2.5 text-[0.9375rem] text-ink" role="status">
          <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-ink" aria-hidden />
          {waiting}
        </p>
      ) : null}
      <ProgressSteps
        className="mt-3"
        steps={steps}
        notes={[task.notice && !queued ? NOTICE_TEXT[task.notice] : null, slow]}
      />
    </FollowUpFrame>
  );
}

/**
 * What the research found, as the rest of the answer: its statements with their sources, how
 * fully the new sources answer the question, what's still open and how to settle it. Read from
 * the saved brief: no model call rewords it.
 */
function FollowUpFindings({ brief, sources }: { brief: ResearchBriefDto; sources: Sources }) {
  const answer = brief.sections.find((s) => s.kind === 'answer')?.claims ?? [];
  const toConfirm = brief.sections.find((s) => s.kind === 'to_confirm')?.claims ?? [];
  return (
    <FollowUpFrame label="What checking further found">
      <p className="meta mb-2">I checked further · {formatTime(brief.createdAt)}</p>
      {answer.length ? (
        <Prose claims={answer} brief={brief} sources={sources} />
      ) : (
        <p className={PROSE}>Nothing I found passed our source checks well enough to report.</p>
      )}
      {brief.evidence && brief.evidence !== 'sufficient' ? (
        <p className="meta mt-2">
          {brief.evidence === 'partial'
            ? 'The sources I found only partly answer this.'
            : 'The sources I found don’t answer this.'}
          {evidenceCheckText(brief.evidenceCheck)}
        </p>
      ) : null}
      {brief.searchFailures ? (
        <p className="meta mt-1">Some searches didn’t complete, so this may be missing sources.</p>
      ) : null}
      {toConfirm.length ? (
        <div className="mt-4">
          <p className="text-sm font-semibold text-ink">Still to confirm</p>
          <ul className="mt-1.5 space-y-1.5">
            {toConfirm.map((claim, i) => (
              <li key={i} className={cn(PROSE, 'text-[1.0625rem]')}>
                <ClaimText claim={claim} brief={brief} sources={sources} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {brief.verificationChecklist.length ? (
        <div className="mt-4">
          <p className="text-sm font-semibold text-ink">To settle it</p>
          <ul className="mt-1.5 space-y-1.5">
            {brief.verificationChecklist.map((item) => (
              <li key={item} className="flex gap-2.5 text-[0.9375rem] leading-relaxed text-ink">
                <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-ink" />
                {item}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="mt-3 border-b border-hairline text-[0.9375rem]">
        <Disclosure
          summary="Sources"
          hint={`${plural(brief.sources.length, 'source', 'sources')} · how each point was checked`}
        >
          <SourceList brief={brief} sources={sources} />
        </Disclosure>
      </div>
    </FollowUpFrame>
  );
}

/**
 * Research in progress, as Omenai's turn: the steps it has actually taken, the one under way and
 * those still to come, with what each found. Read from the task record, so a page opened partway
 * shows the same steps rather than starting again.
 */
export function ProgressTurn({
  task,
  headline,
  serverNow,
}: {
  task: ResearchTaskDto;
  headline: string;
  serverNow: string;
}) {
  const queued = task.status === 'queued';
  const waiting = waitingText(task, 'research');
  // Waiting is timed from when it was queued (or when the last attempt failed); work, from its step.
  const elapsed = useElapsed(queued ? task.updatedAt : task.stepStartedAt, serverNow);
  const slow = slowText('research', queued ? 'waiting' : 'working', elapsed ?? 0);
  const steps = researchSteps(queued ? { step: null, steps: [] } : task, {
    lead: Boolean(task.focus),
  });
  return (
    <div>
      <AssistantByline at={task.updatedAt ?? serverNow} />
      <div>
        <p className={PROSE}>
          {task.focus ? (
            <>I’m looking into your question: “{task.focus}”.</>
          ) : (
            <>
              I’m researching <span className="italic">“{headline}”</span>. This usually takes a
              minute or two.
            </>
          )}
        </p>
        {waiting ? (
          <p className="mt-4 flex items-start gap-3 text-[0.9375rem] text-ink" role="status">
            <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-ink" aria-hidden />
            {waiting}
          </p>
        ) : null}
        <ProgressSteps
          className="mt-4"
          steps={steps}
          notes={[task.notice && !queued ? NOTICE_TEXT[task.notice] : null, slow]}
        />
        <p className="meta mt-4">
          You can leave this page or close the browser. The research carries on, and it will be here
          when you come back.
        </p>
      </div>
    </div>
  );
}

/** The reply's steps worth showing: reading and composing, then any later step once reached. */
function shownChatSteps(progress: RecordedProgress) {
  return chatSteps(progress).filter((s, i) => i < 2 || s.state === 'done' || s.state === 'now');
}

/**
 * A reply before its text arrives: what Omenai is doing, step by step. In the page that asked,
 * it follows the stream; in a page opened partway, the task record (its text then arrives with the
 * saved reply, since the stream belongs to the page that asked).
 */
export function ChatProgressTurn({
  progress,
  at,
  notes = [],
  stopping = false,
}: {
  progress: RecordedProgress;
  at: string;
  notes?: Array<string | null | undefined>;
  stopping?: boolean;
}) {
  return (
    <div>
      <AssistantByline at={at} />
      {stopping ? (
        <p className="meta" role="status">
          Stopping the reply…
        </p>
      ) : (
        <ProgressSteps steps={shownChatSteps(progress)} notes={notes} />
      )}
    </div>
  );
}

/** A chat reply under way in another page or tab, read from its task record. */
export function RecordedChatTurn({
  task,
  serverNow,
}: {
  task: ResearchTaskDto;
  serverNow: string;
}) {
  const elapsed = useElapsed(task.stepStartedAt, serverNow);
  const writing = task.step === 'write' || task.step === 'check';
  return (
    <ChatProgressTurn
      progress={task}
      at={task.updatedAt ?? serverNow}
      notes={[
        task.notice ? NOTICE_TEXT[task.notice] : null,
        writing
          ? 'The answer will appear here when it’s finished.'
          : task.step === 'compose'
            ? slowText('chat', 'working', elapsed ?? 0)
            : null,
      ]}
    />
  );
}

/**
 * A reply arriving: its text revealed at a steady pace with a caret, then a short note while its
 * quotes are checked. `complete` once all the text is in; `onCaughtUp` once all of it is on
 * screen, when the checked reply can take its place. The preview is never kept on its own.
 */
export function StreamingAnswerTurn({
  text,
  startedAt,
  complete,
  stopping = false,
  onCaughtUp,
}: {
  text: string;
  startedAt: string;
  complete: boolean;
  stopping?: boolean;
  onCaughtUp?: () => void;
}) {
  const { shown, caughtUp } = useRevealedText(text, complete || stopping);
  useEffect(() => {
    if (complete && caughtUp) onCaughtUp?.();
  }, [complete, caughtUp, onCaughtUp]);
  const checking = complete && caughtUp;
  return (
    <div aria-busy="true" className="rise-in">
      <AssistantByline
        at={startedAt}
        label={stopping ? 'Stopping' : checking ? 'Checking' : 'Writing · not yet checked'}
      />
      <p className={cn(PROSE, 'whitespace-pre-line')}>
        {shown}
        {checking || stopping ? null : (
          <span
            aria-hidden
            // Solid while words arrive; a slow blink while it waits for more.
            className={cn('stream-caret', caughtUp && 'stream-caret-waiting')}
          />
        )}
      </p>
      <p className="meta mt-2" role="status" aria-live="polite">
        {stopping ? (
          'Stopping the reply…'
        ) : checking ? (
          'Checking each quote against its source…'
        ) : (
          <span className="sr-only">Omenai is writing a reply</span>
        )}
      </p>
    </div>
  );
}

/** The welcome before anything has been found: shown for the first moments of auto-start. */
export function WelcomeTurn({ headline }: { headline: string }) {
  return (
    <div>
      <AssistantByline at={new Date().toISOString()} />
      <div>
        <p className={PROSE}>
          <Sparkles className="mr-2 inline size-4 text-ink" aria-hidden />
          I’m your research assistant for <span className="italic">“{headline}”</span>. I’ll read
          its sources, look for more, and give you a briefing where every fact links to where it
          came from.
        </p>
      </div>
    </div>
  );
}
