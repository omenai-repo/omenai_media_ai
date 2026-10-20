'use client';

import type { DraftProgressDto, DraftTaskDto, DraftVersionDto, DraftsViewDto } from '@repo/core';
import {
  DRAFT_FORMAT_IDS,
  DRAFT_FORMATS,
  measureDraft,
  type ApiErrorResponse,
  type DraftFormat,
} from '@repo/shared';
import { ArrowRight, Copy, Loader2, PenLine, RotateCcw, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { toast } from 'sonner';

import { formatDateTime } from '@/components/editorial/format';
import { Disclosure, EmptyState, StatusNote } from '@/components/editorial/primitives';
import { failureText } from '@/components/progress/steps';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { WorkspaceHeader } from '@/components/workspace/workspace-header';
import { cn } from '@/lib/utils';

import { DraftProgress } from './draft-progress';
import { FormatRail } from './format-rail';
import { limitText } from './format-status';
import { ChecksPanel, VersionHistory, versionOrigin } from './side-panels';

/** While a draft is written, its steps and text are read this often (one small query). */
const PROGRESS_POLL_MS = 1_000;
/** The full view is also read now and then while writing, in case the small query fails. */
const POLL_MS = 10_000;

/** Unsaved text for one version; `fromLatest` records whether editing began on the latest one. */
type Edit = { title: string; body: string; fromLatest?: boolean };
const editKey = (format: DraftFormat, version: number) => `${format}:${version}`;
const clean = (text: string) =>
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();

async function send(url: string, method: 'POST' | 'PUT', body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => null)) as unknown;
  if (!response.ok)
    throw new Error(
      (json as ApiErrorResponse | null)?.error.message ?? 'Something went wrong. Please try again.',
    );
  return json;
}

const START_TITLE: Record<DraftFormat, string> = {
  newsletter_item: 'Write a Weekly Briefing item',
  editorial_article: 'Write an editorial article',
  linkedin_post: 'Write a LinkedIn post',
  instagram_caption: 'Write an Instagram caption',
  x_post: 'Write an X post',
};

const PLACEHOLDER: Record<DraftFormat, string> = {
  newsletter_item: 'For example: lead with the archive, and keep it warm rather than formal',
  editorial_article: 'For example: open in the workshop, and give more room to the history',
  linkedin_post: 'For example: speak to museum and gallery professionals',
  instagram_caption: 'For example: lead with what visitors will see',
  x_post: 'For example: make the why-it-matters sharper',
};

/** The first format with something in it, so a returning editor lands on their work. */
function startingFormat(view: DraftsViewDto, wanted: DraftFormat | null): DraftFormat {
  if (wanted) return wanted;
  return (
    DRAFT_FORMAT_IDS.find((f) => view.formats[f].versions.length || view.formats[f].activeTask) ??
    'newsletter_item'
  );
}

/**
 * The content studio for one story: pick a format, have Omenai write a draft from the research,
 * edit it, and keep every version. Writing runs in the background (polled), saving an edit adds a
 * version, and nothing is published: the editor copies the text when it's ready.
 */
export function DraftStudio({
  story,
  initial,
  initialFormat,
}: {
  story: { id: string; headline: string; eyebrow: string };
  initial: DraftsViewDto;
  initialFormat: DraftFormat | null;
}) {
  const [view, setView] = useState(initial);
  const [format, setFormat] = useState<DraftFormat>(() => startingFormat(initial, initialFormat));
  const [selected, setSelected] = useState<Partial<Record<DraftFormat, number>>>({});
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [instructions, setInstructions] = useState('');
  const [revise, setRevise] = useState(true);
  const [saving, setSaving] = useState(false);
  const [requesting, setRequesting] = useState(false);

  const spec = DRAFT_FORMATS[format];
  const entry = view.formats[format];
  const latest = entry.versions[0] ?? null;
  const shown = entry.versions.find((v) => v.version === selected[format]) ?? latest ?? null;
  const key = shown ? editKey(format, shown.version) : null;
  const edit = key ? edits[key] : undefined;
  const title = edit?.title ?? shown?.title ?? '';
  const body = edit?.body ?? shown?.body ?? '';
  const dirty =
    shown !== null && (clean(title) !== clean(shown.title) || clean(body) !== clean(shown.body));
  const anyDirty = Object.entries(edits).some(([k, e]) => {
    const [f, v] = k.split(':') as [DraftFormat, string];
    const version = view.formats[f]?.versions.find((x) => x.version === Number(v));
    return (
      version && (clean(e.title) !== clean(version.title) || clean(e.body) !== clean(version.body))
    );
  });
  const writing = DRAFT_FORMAT_IDS.some((f) => view.formats[f].activeTask);
  const measure = measureDraft(format, body);
  const checked = shown
    ? (entry.versions.find((v) => v.version === shown.checksFrom) ?? null)
    : null;
  const researched = view.research.briefs > 0;

  const shownView = useRef(view);
  const announced = useRef(new Set<string>());
  useEffect(() => {
    shownView.current = view;
  }, [view]);

  /** Reads the full view, and says so once when a draft that was being written has arrived. */
  const refresh = useCallback(async (): Promise<DraftsViewDto | null> => {
    const before = shownView.current;
    const response = await fetch(`/api/stories/${story.id}/drafts`, { cache: 'no-store' }).catch(
      () => null,
    );
    if (!response?.ok) return null;
    const next = (await response.json()) as DraftsViewDto;
    setView(next);
    for (const f of DRAFT_FORMAT_IDS) {
      const active = before.formats[f].activeTask;
      const latest = next.formats[f].versions[0];
      if (
        !active ||
        next.formats[f].activeTask ||
        announced.current.has(active.key) ||
        !latest ||
        latest.version <= (before.formats[f].versions[0]?.version ?? 0)
      )
        continue;
      announced.current.add(active.key);
      toast.success(`${DRAFT_FORMATS[f].label}: version ${latest.version} is ready.`, {
        description: 'Look over its statement checks before you use it.',
      });
    }
    return next;
  }, [story.id]);

  // Poll only while a draft is being written.
  useEffect(() => {
    if (!writing) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [writing, refresh]);

  // Each draft being written: its steps and the text so far, read every second while it runs. A
  // draft gone from the running list has finished, so the outcome is read at once.
  const [live, setLive] = useState<DraftProgressDto | null>(null);
  useEffect(() => {
    if (!writing) return;
    let current = true;
    const poll = async () => {
      const response = await fetch(`/api/stories/${story.id}/drafts/progress`, {
        cache: 'no-store',
      }).catch(() => null);
      if (!current || !response?.ok) return;
      const progress = (await response.json()) as DraftProgressDto;
      setLive(progress);
      const finished = DRAFT_FORMAT_IDS.some((f) => {
        const active = shownView.current.formats[f].activeTask;
        return active && progress.formats[f]?.key !== active.key;
      });
      if (finished) await refresh();
    };
    void poll();
    const timer = setInterval(() => void poll(), PROGRESS_POLL_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [writing, story.id, refresh]);
  /** The freshest record of a format's draft in progress (the light poll, else the full view). */
  const progressOf = (f: DraftFormat): DraftTaskDto | null => {
    const active = view.formats[f].activeTask;
    if (!active) return null;
    const fresh = live?.formats[f];
    return fresh?.key === active.key ? fresh : active;
  };
  const serverNow = live?.now ?? view.now;

  // Unsaved edits survive switching formats and versions, but not leaving the page.
  useEffect(() => {
    if (!anyDirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [anyDirty]);

  // Keep the chosen format in the address, so a link or a refresh returns to it.
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('format', format);
    window.history.replaceState(null, '', url);
  }, [format]);

  function change(field: keyof Edit, value: string) {
    if (!shown || !key) return;
    // Pin the version being edited, so a new one arriving doesn't swap the text underneath.
    if (selected[format] === undefined) setSelected((s) => ({ ...s, [format]: shown.version }));
    setEdits((all) => ({
      ...all,
      [key]: {
        title,
        body,
        fromLatest: all[key]?.fromLatest ?? shown.version === latest?.version,
        [field]: value,
      },
    }));
  }

  function discard() {
    if (!key) return;
    setEdits(({ [key]: _gone, ...rest }) => rest);
  }

  async function save(text: Edit, base: DraftVersionDto, restoring = false) {
    const pinned = selected[format];
    setSaving(true);
    try {
      const result = (await send(`/api/stories/${story.id}/drafts`, 'PUT', {
        format,
        baseVersion: base.version,
        title: text.title,
        body: text.body,
      })) as { version: number; changed: boolean; savedMeanwhile: boolean };
      // Keep the edits on screen until the history includes them, then show the new version,
      // unless the editor has moved to another version in the meantime.
      await refresh();
      setEdits(({ [editKey(format, base.version)]: _saved, ...rest }) => rest);
      setSelected((s) => (s[format] === pinned ? { ...s, [format]: undefined } : s));
      if (!result.changed) toast.info('Nothing to save: it matches the latest version.');
      else
        toast.success(
          restoring
            ? `Version ${base.version} restored as version ${result.version}.`
            : `Saved as version ${result.version}.`,
          // Only news when the editor began on the latest version; editing an older one is a choice.
          result.savedMeanwhile && text.fromLatest
            ? {
                description:
                  'Someone saved another version while you were editing. Both are in the history.',
              }
            : undefined,
        );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'The draft couldn’t be saved. Please try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  async function request(options: { instructions: string; fromVersion: number | null }) {
    const pinned = selected[format];
    setRequesting(true);
    try {
      await send(`/api/stories/${story.id}/drafts`, 'POST', {
        format,
        instructions: options.instructions.trim() || undefined,
        fromVersion: options.fromVersion ?? undefined,
      });
      setInstructions('');
      // Follow the new version when it arrives, unless the editor has moved on.
      setSelected((s) => (s[format] === pinned ? { ...s, [format]: undefined } : s));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'The draft couldn’t be started. Please try again.',
      );
    } finally {
      await refresh();
      setRequesting(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(
        spec.hasTitle && title.trim() ? `${title.trim()}\n\n${body.trim()}` : body.trim(),
      );
      toast.success('Copied. Paste it into your publishing tool.');
    } catch {
      toast.error('Copying isn’t allowed here. Select the text and copy it instead.');
    }
  }

  function onEditorKey(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (dirty && shown && !saving)
        void save({ title, body, fromLatest: edit?.fromLatest }, shown);
    }
  }

  const unsavedIn = useMemo(
    () =>
      new Set(
        Object.entries(edits).flatMap(([k, e]) => {
          const [f, v] = k.split(':') as [DraftFormat, string];
          const version = view.formats[f]?.versions.find((x) => x.version === Number(v));
          return version &&
            (clean(e.title) !== clean(version.title) || clean(e.body) !== clean(version.body))
            ? [k]
            : [];
        }),
      ),
    [edits, view.formats],
  );
  const unsavedFormats = useMemo(
    () =>
      new Set(DRAFT_FORMAT_IDS.filter((f) => [...unsavedIn].some((k) => k.startsWith(`${f}:`)))),
    [unsavedIn],
  );

  const hasDrafts = DRAFT_FORMAT_IDS.some((f) => view.formats[f].versions.length);
  const status = writing
    ? { label: 'Writing a draft', tone: 'text-graphite' }
    : anyDirty
      ? { label: 'Unsaved changes', tone: 'text-graphite' }
      : hasDrafts
        ? { label: 'All changes saved', tone: 'text-moss' }
        : null;

  return (
    // On wide screens the studio fills the window and each column scrolls on its own: the
    // formats, the draft and the checks. Phones keep one page that scrolls as a whole.
    <div className="flex min-h-dvh flex-col bg-paper lg:h-dvh">
      <WorkspaceHeader
        storyId={story.id}
        eyebrow={story.eyebrow}
        headline={story.headline}
        section="Studio"
      >
        {status ? (
          <p
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 text-[0.8125rem] font-semibold',
              status.tone,
            )}
            role="status"
            aria-label={status.label}
          >
            {writing ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <span aria-hidden className="size-[7px] rounded-full bg-current" />
            )}
            <span className="hidden sm:inline">{status.label}</span>
          </p>
        ) : null}
        <Button asChild variant="outline" size="sm" className="h-10 px-4 pointer-coarse:h-11">
          <Link href={`/stories/${story.id}/research`}>
            <span className="hidden sm:inline">Research</span>
            <span className="sr-only sm:hidden">Research</span>
            <ArrowRight aria-hidden />
          </Link>
        </Button>
      </WorkspaceHeader>

      <div className="grid w-full flex-1 grid-cols-[minmax(0,1fr)] lg:min-h-0 lg:grid-cols-[16rem_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)] min-[87.5rem]:grid-cols-[16rem_minmax(0,1fr)_24rem] 2xl:grid-cols-[17rem_minmax(0,1fr)_26rem]">
        <FormatRail
          view={view}
          format={format}
          unsaved={unsavedFormats}
          storyId={story.id}
          onSelect={setFormat}
        />

        {/* Editor */}
        <section
          aria-label={spec.label}
          className="min-w-0 px-4 pt-6 pb-16 sm:px-6 lg:overflow-y-auto lg:overscroll-contain lg:px-8 lg:pt-7 2xl:px-10"
        >
          <div className="mx-auto max-w-[60rem]">
            {!researched ? (
              <EmptyState
                title="Research this story first"
                className="border border-hairline bg-ivory"
              >
                <p>
                  Drafts are written from the story’s research, so their statements can be traced
                  back to its sources.
                </p>
                <Button asChild className="mt-6">
                  <Link href={`/stories/${story.id}/research`}>
                    Research this story <ArrowRight aria-hidden />
                  </Link>
                </Button>
              </EmptyState>
            ) : !shown ? (
              <StartCard
                format={format}
                briefs={view.research.briefs}
                active={progressOf(format)}
                serverNow={serverNow}
                failure={entry.lastFailure}
                instructions={instructions}
                onInstructions={setInstructions}
                busy={requesting}
                onStart={() => void request({ instructions, fromVersion: null })}
              />
            ) : (
              <div className="space-y-5">
                <div>
                  <h2 className="masthead text-[1.875rem] leading-[0.9] sm:text-[2.125rem]">
                    {spec.label}
                  </h2>
                  <p className="mt-1.5 text-[0.84375rem] text-graphite">
                    {spec.purpose.replace(/\.$/, '')} · {limitText(format).toLowerCase()}
                  </p>
                </div>

                {entry.activeTask ? (
                  <DraftProgress
                    task={progressOf(format) ?? entry.activeTask}
                    format={format}
                    version={(latest?.version ?? 0) + 1}
                    serverNow={serverNow}
                    bounded
                  />
                ) : entry.lastFailure ? (
                  <StatusNote tone="attention" title="The last draft didn’t finish." role="alert">
                    {failureText(entry.lastFailure.lastError)} Nothing from it was saved.{' '}
                    <button
                      type="button"
                      className="text-link font-medium text-ink"
                      disabled={requesting}
                      onClick={() =>
                        void request({
                          instructions: entry.lastFailure?.instructions ?? '',
                          fromVersion: entry.lastFailure?.fromVersion ?? null,
                        })
                      }
                    >
                      Try again
                    </button>
                  </StatusNote>
                ) : null}

                {latest && shown.version !== latest.version ? (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-hairline bg-ivory py-2.5 pr-3 pl-4 text-sm text-ink">
                    <span>
                      You’re looking at version {shown.version}. The latest is version{' '}
                      {latest.version}.
                    </span>
                    <span className="flex flex-wrap gap-2">
                      <Button
                        variant="quiet"
                        size="sm"
                        onClick={() => setSelected((s) => ({ ...s, [format]: undefined }))}
                      >
                        Back to the latest
                      </Button>
                      {!dirty ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={saving}
                          onClick={() =>
                            void save({ title: shown.title, body: shown.body }, shown, true)
                          }
                        >
                          <RotateCcw aria-hidden /> Restore as version {latest.version + 1}
                        </Button>
                      ) : null}
                    </span>
                  </div>
                ) : null}

                <div
                  onKeyDown={onEditorKey}
                  className="overflow-hidden rounded-[18px] border border-hairline bg-ivory"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4.5 sm:px-7">
                    <p className="text-[0.8125rem] text-graphite">
                      <strong className="font-semibold text-ink">Version {shown.version}</strong> ·{' '}
                      {versionOrigin(shown)} · {formatDateTime(shown.createdAt)}
                    </p>
                    <CheckChip shown={shown} checked={checked} />
                  </div>
                  {spec.hasTitle ? (
                    <div className="border-b border-hairline-soft px-5 pt-3.5 pb-3 sm:px-7">
                      <Label
                        htmlFor="draft-title"
                        className="text-xs font-semibold tracking-[0.03em] text-slate uppercase"
                      >
                        Headline
                      </Label>
                      <Input
                        id="draft-title"
                        value={title}
                        maxLength={300}
                        onChange={(event) => change('title', event.target.value)}
                        className="mt-1 h-auto rounded-none border-0 bg-transparent px-0 py-1 font-serif text-[1.75rem] leading-[1.1] font-medium tracking-[-0.015em] shadow-none focus-visible:ring-0 md:text-[2.125rem]"
                      />
                    </div>
                  ) : null}
                  <Label htmlFor="draft-body" className="sr-only">
                    {spec.label} text
                  </Label>
                  <Textarea
                    id="draft-body"
                    value={body}
                    onChange={(event) => change('body', event.target.value)}
                    className={cn(
                      'field-sizing-content max-w-[80ch] rounded-none border-0 bg-transparent px-5 py-5 font-serif text-[1.125rem] leading-[1.7] text-ink shadow-none focus-visible:ring-0 sm:px-7 md:text-[1.1875rem]',
                      format === 'editorial_article' ? 'min-h-[32rem]' : 'min-h-[14rem]',
                    )}
                  />
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline-soft bg-[#fafaf8] py-3 pr-4 pl-5 sm:pl-7">
                    <p
                      className={cn(
                        'text-sm tabular-nums',
                        measure.overLimit
                          ? measure.uncertain
                            ? 'font-medium text-amber'
                            : 'font-medium text-oxide'
                          : 'text-graphite',
                      )}
                      aria-live="polite"
                    >
                      {measure.summary}
                      {measure.uncertain
                        ? '. It has something X may count as a 23-character link. Check the count in X before posting.'
                        : measure.overLimit
                          ? '. Over the limit: shorten it before posting.'
                          : measure.outsideGuidance
                            ? '. Outside the usual length.'
                            : format === 'x_post'
                              ? ', counted as X counts them.'
                              : ''}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      {dirty ? (
                        <Button variant="quiet" size="sm" onClick={discard} disabled={saving}>
                          <Undo2 aria-hidden /> Discard changes
                        </Button>
                      ) : null}
                      <Button variant="outline" size="sm" onClick={() => void copy()}>
                        <Copy aria-hidden /> Copy text
                      </Button>
                      <Button
                        size="sm"
                        disabled={!dirty || saving}
                        onClick={() =>
                          void save({ title, body, fromLatest: edit?.fromLatest }, shown)
                        }
                      >
                        {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
                        {dirty ? `Save as version ${(latest?.version ?? 0) + 1}` : 'Saved'}
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="space-y-3 rounded-[18px] border border-hairline bg-ivory px-5 py-5 sm:px-7">
                  <Label htmlFor="draft-instructions" className="text-sm font-semibold text-ink">
                    Ask Omenai for another version
                  </Label>
                  <Textarea
                    id="draft-instructions"
                    value={instructions}
                    maxLength={1_000}
                    onChange={(event) => setInstructions(event.target.value)}
                    placeholder={PLACEHOLDER[format]}
                    className="min-h-20 bg-ivory"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <label className="flex items-center gap-2 text-sm text-ink">
                      <input
                        type="checkbox"
                        checked={revise}
                        onChange={(event) => setRevise(event.target.checked)}
                        className="size-4 accent-[var(--ink)]"
                      />
                      Revise version {shown.version} (otherwise start fresh)
                    </label>
                    <Button
                      variant="outline"
                      className="border-ink"
                      disabled={Boolean(entry.activeTask) || requesting || dirty}
                      onClick={() =>
                        void request({ instructions, fromVersion: revise ? shown.version : null })
                      }
                    >
                      {requesting ? (
                        <Loader2 className="animate-spin" aria-hidden />
                      ) : (
                        <PenLine aria-hidden />
                      )}
                      Write a new version
                    </Button>
                  </div>
                  <p className="meta">
                    {dirty
                      ? 'Save or discard your changes first.'
                      : 'Your note guides emphasis, tone and length. Omenai is asked to keep to the evidence whatever the note says, so check the result.'}
                  </p>
                </div>

                {/* Below the editor on narrower screens; beside it on wide ones. */}
                <div className="grid gap-3 min-[87.5rem]:hidden">
                  <Disclosure
                    variant="card"
                    summary="Before you use it"
                    hint="Checks and what’s still open"
                  >
                    <ChecksPanel shown={shown} checked={checked} view={view} />
                  </Disclosure>
                  <Disclosure variant="card" summary={`Version history (${entry.versions.length})`}>
                    <VersionHistory
                      versions={entry.versions}
                      shown={shown.version}
                      onSelect={(v) => setSelected((s) => ({ ...s, [format]: v }))}
                    />
                  </Disclosure>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Checks and history beside the editor on wide screens, scrolling within the panel. */}
        {researched && shown ? (
          <aside
            aria-label="Versions and checks"
            className="hidden overflow-y-auto overscroll-contain border-l border-hairline bg-ivory px-5.5 pt-5 pb-8 min-[87.5rem]:block"
          >
            <section>
              <h2 className="masthead text-xl tracking-[0.02em]">Version history</h2>
              <div className="mt-2.5">
                <VersionHistory
                  versions={entry.versions}
                  shown={shown.version}
                  onSelect={(v) => setSelected((s) => ({ ...s, [format]: v }))}
                />
              </div>
            </section>
            <section className="mt-6.5 border-t-2 border-ink pt-4.5">
              <h2 className="masthead mb-3 text-xl tracking-[0.02em]">Before you use it</h2>
              <ChecksPanel shown={shown} checked={checked} view={view} />
            </section>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Whether the text in the editor is the text that was source-checked, without colour: a filled
 * dot when this version's own statements were checked as it was written, an empty one when they
 * weren't (an edited or restored version shows its source version's checks, never as its own).
 */
function CheckChip({
  shown,
  checked,
}: {
  shown: DraftVersionDto;
  checked: DraftVersionDto | null;
}) {
  const own = checked !== null && checked.version === shown.version && checked.claims.length > 0;
  return (
    <span className="inline-flex h-6 items-center gap-[7px] rounded-full border border-tag-line px-2.5 text-xs font-medium text-graphite">
      <span
        aria-hidden
        className={cn(
          'size-[7px] rounded-full border-[1.5px] border-graphite',
          own && 'bg-graphite',
        )}
      />
      {own ? 'Sources checked when written' : 'Text not checked'}
    </span>
  );
}

/** The first draft of a format: what it's for, an optional note, and one clear action. */
function StartCard({
  format,
  briefs,
  active,
  serverNow,
  failure,
  instructions,
  onInstructions,
  busy,
  onStart,
}: {
  format: DraftFormat;
  briefs: number;
  active: DraftTaskDto | null;
  serverNow: string;
  failure: DraftTaskDto | null;
  instructions: string;
  onInstructions: (value: string) => void;
  busy: boolean;
  onStart: () => void;
}) {
  const spec = DRAFT_FORMATS[format];
  if (active)
    return (
      <DraftProgress
        task={active}
        format={format}
        version={1}
        serverNow={serverNow}
        bounded={false}
      />
    );
  return (
    <div className="rounded-[18px] border border-hairline bg-ivory px-6 py-8 sm:px-10 sm:py-10">
      <p className="eyebrow">{limitText(format)}</p>
      <h2 className="display-md mt-2">{START_TITLE[format]}</h2>
      <p className="mt-3 max-w-[60ch] font-serif text-lg leading-relaxed text-graphite">
        {spec.purpose} Omenai writes it from the research (
        {briefs === 1 ? 'one briefing' : `${briefs} briefings`}); you edit it, and every version is
        kept.
      </p>
      {failure ? (
        <StatusNote tone="attention" title="The last attempt didn’t finish." className="mt-6">
          {failureText(failure.lastError)} Nothing from it was saved. You can try again below.
        </StatusNote>
      ) : null}
      <div className="mt-6 grid gap-2">
        <Label htmlFor="first-instructions" className="text-sm font-medium text-ink">
          Anything Omenai should know? (optional)
        </Label>
        <Textarea
          id="first-instructions"
          value={instructions}
          maxLength={1_000}
          onChange={(event) => onInstructions(event.target.value)}
          placeholder={PLACEHOLDER[format]}
          className="min-h-20"
        />
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-4">
        <Button variant="signal" onClick={onStart} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <PenLine aria-hidden />}
          {busy ? 'Starting…' : 'Write the draft'}
        </Button>
        <p className="meta">
          Omenai is asked to state as fact only what the research found. Check the draft before you
          use it; nothing is published from here.
        </p>
      </div>
    </div>
  );
}
