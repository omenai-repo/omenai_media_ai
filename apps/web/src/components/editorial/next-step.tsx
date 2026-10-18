import type { DraftStatusDto, ResearchStatusDto } from '@repo/core';
import { ArrowRight, Check, Loader2, PenLine, RotateCcw } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type StepState = 'done' | 'current' | 'upcoming';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function researchNote(status: ResearchStatusDto): string | null {
  switch (status.state) {
    case 'running':
      return 'In progress';
    case 'failed':
      return 'The last attempt didn’t finish';
    case 'ready':
      return [
        plural(status.briefs, 'briefing', 'briefings'),
        status.questions ? plural(status.questions, 'question', 'questions') : null,
      ]
        .filter(Boolean)
        .join(' · ');
    default:
      return null;
  }
}

function draftNote(drafts: DraftStatusDto): string {
  if (drafts.writing) return 'Writing a draft';
  return [
    plural(drafts.formats, 'format', 'formats'),
    plural(drafts.versions, 'version', 'versions'),
  ].join(' · ');
}

/**
 * Where the story is in the editorial flow: review, research, create, refine. A guide, not a
 * gate: every step stays reachable once the one before it has something to work from.
 */
export function WorkflowSteps({
  storyId,
  research,
  drafts,
}: {
  storyId: string;
  research: ResearchStatusDto;
  drafts: DraftStatusDto;
}) {
  const researched = research.state === 'ready';
  const researching = research.state === 'running' || research.state === 'failed';
  const drafted = drafts.versions > 0 || drafts.writing;
  const studio = `/stories/${storyId}/studio`;
  const steps: Array<{ label: string; state: StepState; note: string | null; href?: string }> = [
    {
      label: 'Review the story',
      state: researched || researching ? 'done' : 'current',
      note: researched || researching ? null : 'You’re here',
    },
    {
      label: 'Research',
      state: researched ? 'done' : researching ? 'current' : 'upcoming',
      note: researchNote(research),
      href: `/stories/${storyId}/research`,
    },
    {
      label: 'Create content',
      state: drafted ? 'done' : researched ? 'current' : 'upcoming',
      note: drafted ? draftNote(drafts) : researched ? 'Ready when you are' : 'After research',
      href: researched || drafted ? studio : undefined,
    },
    {
      label: 'Refine and review',
      state: drafts.versions > 0 ? 'current' : 'upcoming',
      note: drafts.versions > 0 ? 'Edit, compare versions, copy' : null,
      href: drafts.versions > 0 ? studio : undefined,
    },
  ];
  return (
    <ol aria-label="Where this story is" className="grid gap-0">
      {steps.map((step, i) => (
        <li key={step.label} className="relative flex gap-3 pb-4 last:pb-0">
          {i < steps.length - 1 ? (
            <span
              aria-hidden
              className={cn(
                'absolute top-6 bottom-0 left-[0.6875rem] w-px',
                step.state === 'done' ? 'bg-moss/40' : 'bg-hairline',
              )}
            />
          ) : null}
          <span
            aria-hidden
            className={cn(
              'relative z-10 mt-0.5 flex size-[1.375rem] shrink-0 items-center justify-center rounded-full border',
              step.state === 'done' && 'border-moss/50 bg-moss-wash text-moss',
              step.state === 'current' && 'border-ochre bg-ivory',
              step.state === 'upcoming' && 'border-hairline bg-ivory',
            )}
          >
            {step.state === 'done' ? <Check className="size-3" /> : null}
            {step.state === 'current' ? <span className="size-2 rounded-full bg-ochre" /> : null}
          </span>
          <div className="min-w-0 leading-snug">
            <p
              className={cn(
                'text-[0.9375rem]',
                step.state === 'upcoming' ? 'text-graphite' : 'font-medium text-ink',
              )}
            >
              {step.href && step.state !== 'upcoming' ? (
                <Link href={step.href} className="headline-link rounded-sm">
                  {step.label}
                </Link>
              ) : (
                step.label
              )}
              <span className="sr-only">
                {step.state === 'done' ? ' (done)' : step.state === 'current' ? ' (current)' : ''}
              </span>
            </p>
            {step.note ? <p className="meta mt-0.5">{step.note}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * The one action that moves the story forward from where it is now: research until there is a
 * briefing, then the studio. Research stays one click away as a secondary link.
 */
export function NextAction({
  storyId,
  research,
  drafts,
}: {
  storyId: string;
  research: ResearchStatusDto;
  drafts: DraftStatusDto;
}) {
  const researchHref = `/stories/${storyId}/research`;
  const studioHref = `/stories/${storyId}/studio`;
  const toStudio = research.state === 'ready' || drafts.versions > 0;
  const action = toStudio
    ? drafts.writing
      ? {
          href: studioHref,
          label: 'Follow the draft',
          icon: <Loader2 aria-hidden className="animate-spin" />,
          help: 'A draft is being written in the background. It appears in the studio when it’s ready.',
        }
      : drafts.versions > 0
        ? {
            href: studioHref,
            label: 'Continue drafting',
            icon: <ArrowRight aria-hidden />,
            help: `${draftNote(drafts)}. Every version is kept; nothing is published from here.`,
          }
        : {
            href: studioHref,
            label: 'Create content',
            icon: <PenLine aria-hidden />,
            help: 'Write a briefing item, an article or a social post from the research. You edit it, and every version is kept.',
          }
    : {
        href: researchHref,
        ...{
          none: {
            label: 'Research this story',
            icon: <ArrowRight aria-hidden />,
            help: 'Omenai reads the sources, looks for more coverage and briefs you in a few minutes. Then ask it anything about the story.',
          },
          running: {
            label: 'Follow the research',
            icon: <Loader2 aria-hidden className="animate-spin" />,
            help: 'Research is running in the background. You can open it now or come back later.',
          },
          failed: {
            label: 'Open research to try again',
            icon: <RotateCcw aria-hidden />,
            help: 'The last attempt didn’t finish. Anything already found will be reused.',
          },
          ready: {
            label: 'Continue research',
            icon: <ArrowRight aria-hidden />,
            help: 'Pick up the conversation where it left off, or look into a new lead.',
          },
        }[research.state],
      };
  return (
    <div>
      <Button asChild size="lg" className="w-full justify-between">
        <Link href={action.href}>
          {action.label} {action.icon}
        </Link>
      </Button>
      <p className="meta mt-2.5">{action.help}</p>
      {toStudio ? (
        <Button asChild variant="quiet" className="mt-2 -ml-0.5">
          <Link href={researchHref}>
            {research.state === 'running' ? 'Follow the research' : 'Continue research'}
            <ArrowRight aria-hidden />
          </Link>
        </Button>
      ) : null}
    </div>
  );
}
