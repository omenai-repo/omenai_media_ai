'use client';

import type { ChatMessageDto, ResearchBriefDto, ResearchViewDto } from '@repo/core';
import type { ApiErrorResponse } from '@repo/shared';
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  CircleCheck,
  Loader2,
  PenLine,
  RotateCcw,
  Square,
  TriangleAlert,
} from 'lucide-react';
import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { toast } from 'sonner';

import { formatDate } from '@/components/editorial/format';
import { REVEAL } from '@/components/progress/reveal';
import { failureText, NOTICE_TEXT, slowText } from '@/components/progress/steps';
import { useElapsed } from '@/components/progress/use-elapsed';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { WorkspaceHeader } from '@/components/workspace/workspace-header';
import { scrollBehavior } from '@/lib/motion';
import { cn } from '@/lib/utils';

import { digestBrief, sourceChecks } from './brief-digest';
import {
  applyLine,
  canStop,
  readChatStream,
  startTurn,
  turnProgress,
  type ChatStreamLine,
  type ChatTurn,
} from './chat-stream';
import { sourceNote } from './citation';
import {
  AnswerTurn,
  BriefTurn,
  briefRequestText,
  ChatProgressTurn,
  ProgressTurn,
  RecordedChatTurn,
  RequestLine,
  StreamingAnswerTurn,
  UserTurn,
  WelcomeTurn,
  type FollowUpState,
} from './turns';

const POLL_MS = 3_000;
const NEAR_BOTTOM_PX = 160;

class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function post(url: string, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as ApiErrorResponse | null;
    throw new RequestError(
      error?.error.code ?? 'ERROR',
      error?.error.message ?? 'Something went wrong. Please try again.',
    );
  }
}

/**
 * A few questions worth asking after a briefing, built from what it holds. They stay on the
 * story; the server's scope check applies to them like any typed question.
 */
function suggestedQuestions(brief: ResearchBriefDto): string[] {
  const digest = digestBrief(brief);
  return [
    brief.peopleToApproach.length
      ? 'Who should we talk to first, and why?'
      : 'Who are the key people and institutions behind this?',
    digest.toConfirm.length
      ? 'How could we confirm what’s still open?'
      : 'What would make this story stronger?',
    brief.focus
      ? 'How does this change the story overall?'
      : 'What angle would suit Omenai’s readers?',
  ];
}

type Turn =
  | { kind: 'brief'; at: string; brief: ResearchBriefDto }
  | { kind: 'message'; at: string; message: ChatMessageDto };

/**
 * The reply being written in this page: its steps until text arrives, then the text revealed at a
 * steady pace, then (once all of it is on screen) the checked reply that was saved.
 */
function LiveReply({
  turn,
  sources,
  revealed,
  onRevealed,
  followUpFor,
}: {
  turn: ChatTurn;
  sources: ResearchViewDto['sources'];
  revealed: boolean;
  onRevealed: () => void;
  followUpFor: (message: ChatMessageDto) => FollowUpState | null;
}) {
  const waiting = turn.phase === 'composing' || turn.phase === 'retrying';
  const elapsed = useElapsed(waiting ? new Date(turn.phaseAt).toISOString() : null, null);
  if (turn.phase === 'done' && turn.reply && (revealed || !turn.text))
    return (
      <AnswerTurn
        message={turn.reply}
        sources={sources}
        leadState={null}
        onResearchLead={() => undefined}
        followUp={followUpFor(turn.reply)}
      />
    );
  if (turn.text && turn.phase !== 'failed')
    return (
      <StreamingAnswerTurn
        text={turn.text}
        startedAt={turn.startedAt}
        complete={turn.phase === 'checking' || turn.phase === 'done'}
        stopping={turn.phase === 'stopping'}
        onCaughtUp={onRevealed}
      />
    );
  if (turn.phase === 'failed' || turn.phase === 'done') return null;
  return (
    <ChatProgressTurn
      progress={turnProgress(turn)}
      at={turn.startedAt}
      stopping={turn.phase === 'stopping'}
      notes={[
        turn.phase === 'retrying' ? NOTICE_TEXT.retrying : null,
        waiting ? slowText('chat', 'working', elapsed ?? 0) : null,
      ]}
    />
  );
}

const draftKey = (storyId: string) => `omenai:research-draft:${storyId}`;
function readDraft(storyId: string): string {
  try {
    return window.sessionStorage.getItem(draftKey(storyId)) ?? '';
  } catch {
    return '';
  }
}
function writeDraft(storyId: string, value: string) {
  try {
    if (value) window.sessionStorage.setItem(draftKey(storyId), value);
    else window.sessionStorage.removeItem(draftKey(storyId));
  } catch {
    // Storage can be unavailable (private windows); the draft just isn't kept.
  }
}

/**
 * The research workspace for one story: a full-screen conversation in which Omenai's briefing is
 * the first reply and every later brief and answer follows in order. Work runs in the background
 * (the page polls while it does), so closing or refreshing never loses anything.
 */
export function ResearchWorkspace({
  story,
  initial,
}: {
  story: { id: string; headline: string; eyebrow: string };
  initial: ResearchViewDto;
}) {
  const [view, setView] = useState(initial);
  // Opening an unresearched story starts its first briefing straight away.
  const shouldAutoStart = !initial.briefs.length && !initial.activeTask && !initial.lastFailure;
  const [starting, setStarting] = useState(shouldAutoStart);
  // The reply being written right now, streamed into this page (null when none is).
  const [turn, setTurn] = useState<ChatTurn | null>(null);
  const turnRef = useRef<ChatTurn | null>(null);
  const updateTurn = useCallback((next: ChatTurn | null) => {
    turnRef.current = next;
    setTurn(next);
  }, []);
  // The reply whose text is all on screen, and whoever is waiting for that moment.
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const revealed = useRef<{ id: string | null; waiter: (() => void) | null }>({
    id: null,
    waiter: null,
  });
  const onRevealed = useCallback(() => {
    const id = turnRef.current?.id ?? null;
    if (!id || revealed.current.id === id) return;
    revealed.current.id = id;
    setRevealedId(id);
    revealed.current.waiter?.();
  }, []);
  const [draft, setDraft] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  // Whether to keep the newest words in view: while work is under way, unless the reader scrolled up.
  const follow = useRef({ atBottom: true, working: false });
  const composer = useRef<HTMLTextAreaElement>(null);
  const autoStarted = useRef(false);
  const busy = Boolean(view.activeTask) || starting;

  const loadView = useCallback(async (): Promise<ResearchViewDto | null> => {
    const response = await fetch(`/api/stories/${story.id}/research`, { cache: 'no-store' }).catch(
      () => null,
    );
    return response?.ok ? ((await response.json()) as ResearchViewDto) : null;
  }, [story.id]);
  const refresh = useCallback(async () => {
    const next = await loadView();
    if (next) setView(next);
  }, [loadView]);

  // Poll only while something is running.
  useEffect(() => {
    if (!view.activeTask) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [view.activeTask, refresh]);

  const launch = useCallback(
    async (options: { auto?: boolean; fromMessageId?: string }) => {
      try {
        await post(`/api/stories/${story.id}/research`, options);
      } catch (error) {
        // Already running or already researched: reconnect instead of starting again.
        if (!(error instanceof RequestError && /STORY_BUSY|ALREADY_RESEARCHED/.test(error.code)))
          toast.error(
            error instanceof Error
              ? error.message
              : 'The research couldn’t be started. Please try again.',
          );
      } finally {
        await refresh();
        setStarting(false);
      }
    },
    [refresh, story.id],
  );

  const startResearch = (options: { fromMessageId?: string } = {}) => {
    setStarting(true);
    void launch(options);
  };

  // Once per visit, and the server refuses it anyway if a briefing already exists.
  useEffect(() => {
    if (autoStarted.current || !shouldAutoStart) return;
    autoStarted.current = true;
    void launch({ auto: true });
  }, [shouldAutoStart, launch]);

  // Restore an unsent question (kept per story for this browser session).
  useEffect(() => {
    const frame = requestAnimationFrame(() => setDraft(readDraft(story.id)));
    return () => cancelAnimationFrame(frame);
  }, [story.id]);

  // Replies that started research of their own: that research is shown inside the reply.
  const withFollowUp = useMemo(
    () => new Set(view.messages.filter((m) => m.followUp).map((m) => m.id)),
    [view.messages],
  );
  const attached = (fromMessageId: string | null | undefined) =>
    Boolean(fromMessageId && withFollowUp.has(fromMessageId));

  const turns = useMemo<Turn[]>(
    () =>
      [
        ...view.briefs
          .filter((brief) => !(brief.fromMessageId && withFollowUp.has(brief.fromMessageId)))
          .map((brief) => ({ kind: 'brief' as const, at: brief.createdAt, brief })),
        ...view.messages.map((message) => ({
          kind: 'message' as const,
          at: message.createdAt,
          message,
        })),
      ].sort((a, b) => a.at.localeCompare(b.at)),
    [view.briefs, view.messages, withFollowUp],
  );

  // Land on the latest exchange; a lone briefing is read from its top.
  const landed = useRef(false);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || landed.current) return;
    landed.current = true;
    if (view.messages.length) el.scrollTop = el.scrollHeight;
  }, [view.messages.length]);

  // Follow new turns only when the reader is already at the bottom.
  const lastTurnCount = useRef(turns.length);
  const working = `${view.activeTask?.step ?? ''}${turn?.phase ?? ''}`;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const grew = turns.length !== lastTurnCount.current;
    lastTurnCount.current = turns.length;
    if (atBottom && (grew || working))
      el.scrollTo({ top: el.scrollHeight, behavior: scrollBehavior() });
  }, [turns.length, working, atBottom]);

  // Text appears a little every frame while a reply is revealed, so follow the content's own
  // growth (instantly: smooth scrolling would lag behind), but only while work is under way.
  useEffect(() => {
    follow.current.working = Boolean(turn) || Boolean(view.activeTask);
  }, [turn, view.activeTask]);
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const observer = new ResizeObserver(() => {
      if (follow.current.working && follow.current.atBottom) el.scrollTop = el.scrollHeight;
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    follow.current.atBottom = near;
    setAtBottom(near);
  }

  /**
   * Sends the composer's text, or a suggested question (leaving any draft untouched), and shows
   * the reply as it is written. However the stream ends (saved, stopped, failed, or the connection
   * dropped), the saved records then decide what the page shows: the checked reply, a plain
   * failure notice, or "Writing a reply…" while a reply carries on without this page.
   */
  async function send(event?: FormEvent, suggested?: string) {
    event?.preventDefault();
    const question = (suggested ?? draft).trim();
    if (!question || busy || turnRef.current || !view.briefs.length) return;
    const mine = startTurn(question);
    // Only this question's reply is updated or cleared here: the next question can start as soon
    // as this reply is saved, while this function is still refreshing the page.
    const isMine = () => turnRef.current?.id === mine.id;
    updateTurn(mine);
    setAtBottom(true);
    let response: Response;
    try {
      response = await fetch(`/api/stories/${story.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: question }),
      });
    } catch {
      if (isMine()) updateTurn(null);
      toast.error('Your question couldn’t be sent. Check your connection and try again.');
      return;
    }
    if (!response.ok || !response.body) {
      // Refused before anything was saved (busy, no research yet, not configured): the typed
      // question stays in the composer.
      const error = (await response.json().catch(() => null)) as ApiErrorResponse | null;
      if (isMine()) updateTurn(null);
      toast.error(error?.error.message ?? 'Your question couldn’t be sent. Try again.');
      composer.current?.focus();
      return;
    }
    try {
      await readChatStream(response.body, (line: ChatStreamLine) => {
        // Saved: clear the composer, unless it already holds the next question.
        if (line.type === 'accepted' && !suggested) {
          setDraft((current) => (current.trim() === question ? '' : current));
          if (readDraft(story.id).trim() === question) writeDraft(story.id, '');
        }
        const current = turnRef.current;
        if (current?.id !== mine.id) return;
        updateTurn(applyLine(current, line));
      });
    } catch {
      // The connection dropped; the reply carries on on the server regardless.
    }
    // Read through the ref's type: the stream's callbacks changed it after the check above.
    const finished = turnRef.current as ChatTurn | null;
    if (
      finished?.id === mine.id &&
      finished.phase === 'done' &&
      finished.reply &&
      finished.messageId
    ) {
      // Let the last words finish appearing before the checked reply takes their place (bounded,
      // so a hidden tab, where frames pause, doesn't hold the page up).
      if (finished.text && revealed.current.id !== mine.id)
        await new Promise<void>((resolve) => {
          revealed.current.waiter = resolve;
          setTimeout(resolve, REVEAL.catchUpMs + 600);
        });
      revealed.current.waiter = null;
      // The stream hands over the saved reply: show it at once, with the question it answers,
      // so there's no gap before the refresh below (which then replaces both, by id).
      const asked: ChatMessageDto = {
        id: finished.messageId,
        role: 'user',
        content: finished.question,
        author: 'You',
        createdAt: finished.startedAt,
        citations: [],
        droppedLabels: [],
        claims: null,
        droppedClaims: 0,
        scope: null,
        evidence: null,
        evidenceCheck: null,
        suggestedFocus: null,
        assessment: null,
        followUp: null,
      };
      const reply = finished.reply;
      setView((current) => ({
        ...current,
        messages: [
          ...current.messages.filter((m) => m.id !== asked.id && m.id !== reply.id),
          asked,
          reply,
        ],
      }));
      updateTurn(null);
    }
    const next = await loadView();
    // One update: the saved records (the reply, or the notice) replace the preview.
    if (next) setView(next);
    else toast.error('The page couldn’t refresh. Reload it to see the latest reply.');
    if (isMine()) {
      updateTurn(null);
      composer.current?.focus();
    }
  }

  /** Stop: the reply ends within about a second, nothing of it is saved, the question stays. */
  async function stop() {
    const current = turnRef.current;
    if (!current?.taskKey || !canStop(current)) return;
    updateTurn({ ...current, phase: 'stopping' });
    const response = await fetch(`/api/stories/${story.id}/chat`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskKey: current.taskKey }),
    }).catch(() => null);
    if (!response?.ok) toast.error('The reply couldn’t be stopped. It will finish on its own.');
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  // Grow the composer with its content, up to a limit.
  useLayoutEffect(() => {
    const el = composer.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [draft]);

  const researching = view.activeTask?.kind === 'research';
  // Research a reply started is shown inside that reply, not as a turn of its own.
  const researchingApart = researching && !attached(view.activeTask?.fromMessageId);
  const replying = view.activeTask?.kind === 'chat' || Boolean(turn);
  const followedUp = new Set(view.briefs.map((b) => b.fromMessageId).filter(Boolean));
  const failure = view.lastFailure;
  /** A reply's own research: findings, progress or the attempt that stopped (ADR-038). */
  const followUpFor = (message: ChatMessageDto): FollowUpState | null => {
    if (!message.followUp) return null;
    const active = view.activeTask;
    return {
      brief: view.briefs.findLast((b) => b.fromMessageId === message.id) ?? null,
      task: active?.kind === 'research' && active.fromMessageId === message.id ? active : null,
      failure:
        failure?.kind === 'research' && failure.fromMessageId === message.id ? failure : null,
      serverNow: view.now,
      busy,
      onResearch: () => startResearch({ fromMessageId: message.id }),
    };
  };
  const failureApart = failure && !(failure.kind === 'research' && attached(failure.fromMessageId));
  // Stopping a reply is the editor's choice, not a fault.
  const stopped =
    failure?.kind === 'chat' && /stopped by the editor/i.test(failure.lastError ?? '');
  const status = researching
    ? { label: 'Researching…', tone: 'text-ochre' }
    : replying
      ? { label: 'Writing a reply…', tone: 'text-ochre' }
      : stopped
        ? { label: 'Stopped', tone: 'text-graphite' }
        : failure
          ? { label: 'Needs attention', tone: 'text-amber' }
          : view.briefs.length
            ? { label: 'Up to date', tone: 'text-moss' }
            : { label: 'Starting…', tone: 'text-graphite' };
  const lastTurn = turns.at(-1);
  const suggested =
    lastTurn?.kind === 'brief' && !busy && !replying && !failure
      ? suggestedQuestions(lastTurn.brief)
      : [];
  const allSources = Object.values(view.sources);
  const checks = sourceChecks(view);
  const lastQuestion = view.messages.findLast((m) => m.role === 'user')?.content ?? '';

  return (
    <div className="flex h-dvh flex-col bg-paper">
      <a
        href="#composer"
        className="sr-only rounded-sm bg-ink px-3 py-2 text-ivory focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50"
      >
        Skip to the question box
      </a>

      <WorkspaceHeader
        storyId={story.id}
        eyebrow={story.eyebrow}
        headline={story.headline}
        section="Research"
      >
        <p
          className={cn('inline-flex shrink-0 items-center gap-1.5 text-xs', status.tone)}
          role="status"
          aria-label={status.label}
        >
          {busy ? (
            <Loader2 className="size-3 animate-spin" aria-hidden />
          ) : (
            <span aria-hidden className="size-1.5 rounded-full bg-current" />
          )}
          <span className="hidden sm:inline">{status.label}</span>
        </p>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" size="sm" disabled={!allSources.length}>
              <BookOpen aria-hidden /> <span className="hidden sm:inline">Sources</span>
              <span className="text-graphite tabular-nums">{allSources.length || ''}</span>
            </Button>
          </SheetTrigger>
          <SheetContent side="right" className="w-full bg-paper sm:max-w-md">
            <SheetHeader className="border-b border-hairline">
              <SheetTitle className="font-display text-2xl font-normal">Sources</SheetTitle>
              <SheetDescription>
                Every source behind this conversation, and how the passages quoted from it checked
                out.
              </SheetDescription>
            </SheetHeader>
            <ol className="divide-y divide-hairline overflow-y-auto px-4">
              {allSources.map((source) => (
                <li key={source.id} className="py-4">
                  <p className="meta">
                    {source.publisher} ·{' '}
                    {source.publishedAt ? formatDate(source.publishedAt) : 'Date not given'}
                  </p>
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-serif text-[1.0625rem] leading-snug text-ink underline decoration-hairline underline-offset-4 hover:decoration-ochre"
                  >
                    {source.headline}
                  </a>
                  <p className="mt-1 text-xs text-graphite">{sourceNote(source)}</p>
                  {checks[source.id] ? (
                    <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink">
                      {checks[source.id]!.found ? (
                        <span className="inline-flex items-center gap-1">
                          <CircleCheck className="size-3 text-moss" aria-hidden />
                          {checks[source.id]!.found} quoted{' '}
                          {checks[source.id]!.found === 1 ? 'passage' : 'passages'} found
                        </span>
                      ) : null}
                      {checks[source.id]!.notFound ? (
                        <span className="inline-flex items-center gap-1">
                          <TriangleAlert className="size-3 text-amber" aria-hidden />
                          {checks[source.id]!.notFound} couldn’t be checked
                        </span>
                      ) : null}
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
          </SheetContent>
        </Sheet>
        {view.briefs.length ? (
          <Button asChild size="sm">
            <Link href={`/stories/${story.id}/studio`}>
              <PenLine aria-hidden />
              <span className="hidden sm:inline">Write a draft</span>
              <span className="sr-only sm:hidden">Write a draft</span>
            </Link>
          </Button>
        ) : null}
      </WorkspaceHeader>

      {/* Conversation */}
      <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto">
        <div
          ref={content}
          className="mx-auto w-full max-w-[50rem] space-y-12 px-4 pt-10 pb-24 sm:px-6"
        >
          {turns.length === 0 && !researching && !failure ? (
            <WelcomeTurn headline={story.headline} />
          ) : null}
          {turns.map((turn) =>
            turn.kind === 'brief' ? (
              <div key={turn.brief.id} className="space-y-6">
                <RequestLine at={turn.brief.createdAt}>{briefRequestText(turn.brief)}</RequestLine>
                <BriefTurn brief={turn.brief} sources={view.sources} />
              </div>
            ) : turn.message.role === 'user' ? (
              <UserTurn key={turn.message.id} message={turn.message} />
            ) : (
              <AnswerTurn
                key={turn.message.id}
                message={turn.message}
                sources={view.sources}
                leadState={
                  !turn.message.suggestedFocus
                    ? null
                    : followedUp.has(turn.message.id)
                      ? 'done'
                      : busy
                        ? 'busy'
                        : 'offer'
                }
                onResearchLead={() => startResearch({ fromMessageId: turn.message.id })}
                followUp={followUpFor(turn.message)}
              />
            ),
          )}
          {turn ? (
            <>
              <UserTurn
                pending={turn.phase === 'sending'}
                message={{ content: turn.question, author: 'You', createdAt: turn.startedAt }}
              />
              <LiveReply
                turn={turn}
                sources={view.sources}
                revealed={revealedId === turn.id}
                onRevealed={onRevealed}
                followUpFor={followUpFor}
              />
            </>
          ) : null}
          {researchingApart ? (
            <div className="space-y-6">
              <RequestLine>
                {briefRequestText({
                  requestKind: view.activeTask!.requestKind ?? 'manual',
                  requestedBy: view.activeTask!.requestedBy,
                  focus: view.activeTask!.focus,
                })}
              </RequestLine>
              <ProgressTurn
                task={view.activeTask!}
                headline={story.headline}
                serverNow={view.now}
              />
            </div>
          ) : null}
          {view.activeTask?.kind === 'chat' && !turn ? (
            <RecordedChatTurn task={view.activeTask} serverNow={view.now} />
          ) : null}
          {failureApart && failure && !busy && !turn ? (
            <div
              role={stopped ? 'status' : 'alert'}
              className={cn('rounded-lg p-5', stopped ? 'bg-bone/70' : 'bg-amber-wash/70')}
            >
              <p className="font-medium text-ink">
                {failure.kind === 'chat'
                  ? stopped
                    ? 'You stopped the last reply.'
                    : 'Your last question didn’t get a reply.'
                  : view.briefs.length
                    ? 'The latest research didn’t finish.'
                    : 'The research didn’t finish.'}
              </p>
              <p className="mt-1 text-[0.9375rem] text-graphite">
                {stopped ? null : `${failureText(failure.lastError)} `}
                {failure.kind === 'chat'
                  ? 'Your question is saved, so you can ask it again.'
                  : 'Nothing half-finished was saved, and anything already found will be reused when you try again.'}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() =>
                  failure.kind === 'chat'
                    ? setDraft(lastQuestion)
                    : startResearch(
                        failure.fromMessageId ? { fromMessageId: failure.fromMessageId } : {},
                      )
                }
              >
                <RotateCcw aria-hidden /> {failure.kind === 'chat' ? 'Ask again' : 'Try again'}
              </Button>
            </div>
          ) : null}
        </div>
        {!atBottom ? (
          <button
            type="button"
            onClick={() =>
              scroller.current?.scrollTo({
                top: scroller.current.scrollHeight,
                behavior: scrollBehavior(),
              })
            }
            className="sticky bottom-6 left-1/2 z-10 mx-auto flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline bg-ivory px-3.5 py-1.5 text-xs text-ink shadow-sm hover:border-ochre"
          >
            <ArrowDown className="size-3.5" aria-hidden /> Jump to latest
          </button>
        ) : null}
      </div>

      {/* Composer */}
      <div className="relative shrink-0 bg-paper px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
        {/* Lets the conversation fade under the composer instead of stopping at a hard line. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-10 h-10 bg-gradient-to-t from-paper to-transparent"
        />
        <form onSubmit={(event) => void send(event)} className="mx-auto max-w-[47rem]">
          {suggested.length ? (
            <div className="mb-3 flex rise-in [scrollbar-width:none] gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible">
              <span className="meta shrink-0 self-center pr-1">Try asking</span>
              {suggested.map((question) => (
                <button
                  key={question}
                  type="button"
                  onClick={() => void send(undefined, question)}
                  className="shrink-0 rounded-md border border-hairline-soft bg-ivory px-3 py-1.5 text-left text-sm text-ink transition-colors hover:border-ochre/60 hover:bg-ochre-wash/40"
                >
                  {question}
                </button>
              ))}
            </div>
          ) : null}
          <label htmlFor="composer" className="sr-only">
            Ask about this story
          </label>
          <div
            className={cn(
              'rounded-xl border bg-ivory shadow-float transition-[border-color,box-shadow] focus-within:border-ochre focus-within:ring-[3px] focus-within:ring-ochre/15',
              busy || !view.briefs.length ? 'border-hairline' : 'border-rule-strong',
            )}
          >
            <textarea
              id="composer"
              ref={composer}
              rows={1}
              value={draft}
              maxLength={2_000}
              disabled={!view.briefs.length}
              onChange={(event) => {
                setDraft(event.target.value);
                writeDraft(story.id, event.target.value);
              }}
              onKeyDown={onKeyDown}
              placeholder={
                view.briefs.length
                  ? 'Ask anything about this story…'
                  : 'You can ask questions once the briefing is ready.'
              }
              className="block max-h-60 min-h-12 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-base leading-relaxed text-ink outline-none placeholder:text-graphite disabled:cursor-not-allowed sm:px-5"
            />
            <div className="flex items-center justify-between gap-3 px-3 pb-2.5 pl-4 sm:pl-5">
              <p className="meta min-w-0 truncate text-xs">
                {researching
                  ? 'You can ask as soon as this research finishes.'
                  : replying
                    ? 'Writing a reply…'
                    : view.briefs.length
                      ? 'Answers draw on this story’s research.'
                      : 'Getting the briefing ready…'}
              </p>
              {turn && canStop(turn) ? (
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  onClick={() => void stop()}
                  aria-label="Stop the reply"
                  className="shrink-0 rounded-full"
                >
                  <Square className="size-3.5 fill-current" aria-hidden />
                </Button>
              ) : (
                <Button
                  type="submit"
                  size="icon"
                  disabled={!draft.trim() || busy || Boolean(turn) || !view.briefs.length}
                  aria-label="Send question"
                  className="shrink-0 rounded-full"
                >
                  {turn ? (
                    <Loader2 className="animate-spin" aria-hidden />
                  ) : (
                    <ArrowUp aria-hidden />
                  )}
                </Button>
              )}
            </div>
          </div>
          <p className="meta mt-2 hidden text-center text-xs sm:block">
            Enter to send · Shift + Enter for a new line · Every quote is checked against its source
          </p>
        </form>
      </div>
    </div>
  );
}
