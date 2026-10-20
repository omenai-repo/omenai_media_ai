'use client';

import type { RunSummaryDto } from '@repo/core';
import { CalendarDays, Check, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Select as SelectPrimitive } from 'radix-ui';
import { useOptimistic, useTransition } from 'react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

import { editionChoices, type EditionChoice } from './copy';

const control =
  'flex min-h-11 w-full max-w-[26rem] min-w-0 items-center gap-2.5 rounded-full border border-rule-strong bg-ivory py-1.5 pr-3 pl-3.5 text-left text-sm leading-tight';

/** The selected edition as the control shows it, in the list's words: its day, then its time. */
function Shown({ choice }: { choice: EditionChoice }) {
  return (
    <>
      <span className="font-semibold text-ink">{choice.day}</span>
      {choice.time ? <span className="text-graphite"> · {choice.time}</span> : null}
      {choice.byHand ? <span className="text-graphite"> · by hand</span> : null}
    </>
  );
}

/** One edition in the list: its day and tags, then its stories and time. */
function Choice({ choice }: { choice: EditionChoice }) {
  return (
    <SelectPrimitive.Item
      value={choice.runKey}
      textValue={choice.day}
      className="grid min-h-12 cursor-pointer grid-cols-[minmax(0,1fr)_1rem] items-center gap-3 rounded-[10px] px-2.5 py-2 outline-none select-none data-highlighted:bg-bone"
    >
      {/* The option's accessible name: the commas pause between the parts. */}
      <SelectPrimitive.ItemText className="block min-w-0">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm leading-snug font-semibold text-ink">{choice.day}</span>
          {choice.latest ? (
            <>
              <span className="sr-only">, </span>
              <Badge variant="ink" className="h-5 px-2">
                Latest
              </Badge>
            </>
          ) : null}
          {choice.byHand ? (
            <>
              <span className="sr-only">, </span>
              <Badge className="h-5 px-2">By hand</Badge>
            </>
          ) : null}
        </span>
        <span className="sr-only">, </span>
        <span className="mt-0.5 block text-[0.78125rem] leading-snug text-slate">
          {choice.detail}
        </span>
      </SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="flex size-4 items-center justify-center">
        <Check className="size-4 text-ink" strokeWidth={2.4} aria-hidden />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

const scrollButton = 'flex h-7 cursor-default items-center justify-center bg-paper text-graphite';
const groupLabel = 'eyebrow px-2.5 pt-1.5 pb-1';

/**
 * Chooses which edition the Newsroom shows. The control shows the selected edition's day and time;
 * it opens a list of recent editions, each in two short lines (its day, then how many stories it
 * holds and when it was ready). Radix's select keeps the keyboard, typeahead and screen-reader
 * behaviour of a native one. Every edition opens the same page ("What's New"); only its content
 * changes.
 */
export function EditionPicker({
  runs,
  current,
}: {
  runs: RunSummaryDto[];
  current: RunSummaryDto;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // The chosen edition shows in the control at once, while its page loads.
  const [shownKey, setShownKey] = useOptimistic(current.runKey);
  // The selected edition may be older than the recent list; it's listed after them.
  const earlier = runs.some((run) => run.runKey === current.runKey) ? null : current;
  const all = earlier ? [...runs, earlier] : runs;

  const choices = editionChoices(all);
  const shown = choices.find((choice) => choice.runKey === shownKey) ?? choices[0]!;

  if (choices.length < 2)
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="eyebrow">Edition</p>
        <p className={control}>
          <CalendarDays aria-hidden className="size-4 shrink-0 text-graphite" />
          <span className="min-w-0 flex-1 truncate">
            <Shown choice={shown} />
          </span>
        </p>
      </div>
    );

  const choose = (runKey: string) =>
    startTransition(() => {
      setShownKey(runKey);
      // The latest edition is the Newsroom's own address, which also says when a newer one is
      // being prepared.
      router.push(runKey === choices[0]?.runKey ? '/' : `/?run=${encodeURIComponent(runKey)}`);
    });

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor="edition-picker" className="eyebrow">
        Select edition
      </label>
      <SelectPrimitive.Root value={shownKey} onValueChange={choose}>
        <SelectPrimitive.Trigger
          id="edition-picker"
          aria-busy={pending || undefined}
          className={cn(
            control,
            'group cursor-pointer transition-colors outline-none hover:border-ink focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink data-[state=open]:border-ink',
          )}
        >
          <CalendarDays aria-hidden className="size-4 shrink-0 text-graphite" />
          {/* Radix doesn't pass a class to the value, so the layout lives on this wrapper. */}
          <span className="block min-w-0 flex-1 truncate">
            <SelectPrimitive.Value>
              <Shown choice={shown} />
            </SelectPrimitive.Value>
          </span>
          <SelectPrimitive.Icon asChild>
            {pending ? (
              <Loader2 className="size-4 shrink-0 animate-spin text-ink" />
            ) : (
              <ChevronDown className="size-4 shrink-0 text-ink transition-transform group-data-[state=open]:rotate-180" />
            )}
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal>
          <SelectPrimitive.Content
            aria-label="Editions"
            position="popper"
            side="bottom"
            align="start"
            sideOffset={6}
            collisionPadding={16}
            className="z-50 max-h-[min(26rem,var(--radix-select-content-available-height))] w-(--radix-select-trigger-width) min-w-68 origin-(--radix-select-content-transform-origin) overflow-hidden rounded-[14px] border border-hairline bg-paper text-ink shadow-float data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95"
          >
            <SelectPrimitive.ScrollUpButton className={scrollButton}>
              <ChevronUp className="size-4" aria-hidden />
            </SelectPrimitive.ScrollUpButton>
            <SelectPrimitive.Viewport className="p-1.5">
              <SelectPrimitive.Group>
                <SelectPrimitive.Label className={groupLabel}>
                  Recent editions
                </SelectPrimitive.Label>
                {choices.slice(0, runs.length).map((choice) => (
                  <Choice key={choice.runKey} choice={choice} />
                ))}
              </SelectPrimitive.Group>
              {earlier ? (
                <SelectPrimitive.Group className="mt-1.5 border-t border-hairline pt-1.5">
                  <SelectPrimitive.Label className={groupLabel}>Earlier</SelectPrimitive.Label>
                  {choices.slice(runs.length).map((choice) => (
                    <Choice key={choice.runKey} choice={choice} />
                  ))}
                </SelectPrimitive.Group>
              ) : null}
            </SelectPrimitive.Viewport>
            <SelectPrimitive.ScrollDownButton className={scrollButton}>
              <ChevronDown className="size-4" aria-hidden />
            </SelectPrimitive.ScrollDownButton>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
    </div>
  );
}
