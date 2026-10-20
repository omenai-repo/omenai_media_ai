'use client';

import type { DraftTaskDto } from '@repo/core';
import { DRAFT_FORMATS, type DraftFormat } from '@repo/shared';
import { Loader2 } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { ProgressSteps } from '@/components/progress/progress-steps';
import { draftSteps, NOTICE_TEXT, slowText, waitingText } from '@/components/progress/steps';
import { useElapsed } from '@/components/progress/use-elapsed';
import { useRevealedText } from '@/components/progress/use-revealed-text';
import { cn } from '@/lib/utils';

/**
 * A draft being written: its real steps, and the text as the model writes it. The text is a
 * preview, plainly marked as not yet checked or saved; the version that appears in the history
 * when it finishes is the checked, validated one.
 */
export function DraftProgress({
  task,
  format,
  version,
  serverNow,
  bounded,
}: {
  task: DraftTaskDto;
  format: DraftFormat;
  /** The version number it will be saved as. */
  version: number;
  serverNow: string;
  /** Keep the text in a scrolling box (the editor is below it). */
  bounded: boolean;
}) {
  const spec = DRAFT_FORMATS[format];
  const queued = task.status === 'queued';
  const waiting = waitingText(task, 'draft');
  const elapsed = useElapsed(queued ? task.updatedAt : task.stepStartedAt, serverNow);
  const slow = slowText('draft', queued ? 'waiting' : 'working', elapsed ?? 0);
  const steps = draftSteps(queued ? { step: null, steps: [] } : task, spec.limit.unit);
  return (
    <section
      aria-label={`${spec.label}, version ${version}, being written`}
      className="surface px-5 py-6 sm:px-7"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div>
          <p className="eyebrow">
            {spec.label} · version {version}
          </p>
          <h2 className="display-sm mt-1 flex items-center gap-2.5">
            <Loader2 className="size-5 animate-spin text-ink" aria-hidden />
            {queued ? 'Waiting to start' : 'Writing your draft'}
          </h2>
        </div>
        <span className="rounded-full border border-hairline bg-bone/60 px-2.5 py-1 text-xs text-graphite">
          In progress · not yet checked or saved
        </span>
      </div>
      {waiting ? (
        <p className="mt-4 text-[0.9375rem] text-ink" role="status">
          {waiting}
        </p>
      ) : null}
      <ProgressSteps
        className="mt-4"
        steps={steps}
        notes={[task.notice && !queued ? NOTICE_TEXT[task.notice] : null, slow]}
      />
      {task.preview && !queued ? (
        <DraftSoFar
          title={spec.hasTitle ? task.preview.title : ''}
          body={task.preview.body}
          complete={task.step !== 'write' && task.step !== 'shorten'}
          bounded={bounded}
        />
      ) : null}
      <p className="meta mt-4">
        You can keep working or leave this page. The new version appears in the history when it’s
        ready.
      </p>
    </section>
  );
}

/** The text so far, revealed at a steady pace as it arrives, with a caret while it's written. */
function DraftSoFar({
  title,
  body,
  complete,
  bounded,
}: {
  title: string;
  body: string;
  complete: boolean;
  bounded: boolean;
}) {
  const { shown, caughtUp } = useRevealedText(body, complete);
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  // In the scrolling box, keep the newest words in view unless the reader scrolled up.
  useEffect(() => {
    const el = box.current;
    const content = inner.current;
    if (!bounded || !el || !content) return;
    const observer = new ResizeObserver(() => {
      if (following.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [bounded]);

  return (
    <div className="mt-5">
      <p className="meta mb-2">The draft so far. It may still change.</p>
      <div
        ref={box}
        onScroll={() => {
          const el = box.current;
          if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className={cn(
          'rounded-md border border-dashed border-rule-strong bg-paper px-5 py-4',
          bounded && 'max-h-[22rem] overflow-y-auto',
        )}
      >
        <div ref={inner} aria-busy={!complete}>
          {title ? <p className="mb-3 font-display text-[1.5rem] leading-tight">{title}</p> : null}
          <p className="font-serif text-[1.0625rem] leading-[1.7] whitespace-pre-line text-ink/90">
            {shown}
            {complete && caughtUp ? null : (
              <span
                aria-hidden
                className={cn('stream-caret', caughtUp && 'stream-caret-waiting')}
              />
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
