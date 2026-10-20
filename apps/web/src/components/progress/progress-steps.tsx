'use client';

import { Check, Loader2, Minus } from 'lucide-react';

import { cn } from '@/lib/utils';

import type { StepView } from './steps';

const STATE_TEXT = {
  done: '(done)',
  now: '(in progress)',
  next: '(to do)',
  skipped: '(skipped)',
} as const;

/**
 * Work in progress as a short list of its real steps: what's done (with what it found), what's
 * under way, and what's still to come. A note under the current step says when something passing
 * is happening (the AI service was busy) or when a step is running unusually long.
 *
 * For screen readers, only the current step and its notes are announced as they change; the list
 * itself is read on demand.
 */
export function ProgressSteps({
  steps,
  notes = [],
  className,
}: {
  steps: StepView[];
  /** Plain sentences shown under the list: a passing notice, a slow-step note. */
  notes?: Array<string | null | undefined>;
  className?: string;
}) {
  const current = steps.find((s) => s.state === 'now');
  const shownNotes = notes.filter((note): note is string => Boolean(note));
  return (
    <div className={className}>
      <p className="sr-only" role="status" aria-live="polite">
        {[current?.label, ...shownNotes].filter(Boolean).join('. ')}
      </p>
      <ol className="grid gap-2.5" aria-label="Progress">
        {steps.map((step) => (
          <li
            key={step.id}
            className={cn(
              'flex items-start gap-3 text-[0.9375rem] leading-snug',
              step.state === 'now' && 'text-ink',
              step.state === 'done' && 'text-ink/80',
              (step.state === 'next' || step.state === 'skipped') && 'text-graphite',
            )}
          >
            <span aria-hidden className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
              {step.state === 'done' ? (
                <Check className="size-4 text-moss" />
              ) : step.state === 'now' ? (
                <Loader2 className="size-4 animate-spin text-ink" />
              ) : step.state === 'skipped' ? (
                <Minus className="size-3.5 text-stone" />
              ) : (
                <span className="size-1 rounded-full bg-stone" />
              )}
            </span>
            <span className={cn(step.state === 'now' && 'font-medium')}>
              {step.label}
              <span className="sr-only"> {STATE_TEXT[step.state]}</span>
            </span>
          </li>
        ))}
      </ol>
      {shownNotes.length ? (
        <div className="mt-3 space-y-1.5 pl-7">
          {shownNotes.map((note) => (
            <p key={note} className="meta">
              {note}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
