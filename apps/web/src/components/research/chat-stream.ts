import type { ChatEvent, ChatFailureCode, ChatMessageDto } from '@repo/core';

/**
 * The chat stream as the browser sees it: one JSON object per line. Kept free of runtime
 * dependencies so the server (lib/chat-stream.ts) and the workspace share the contract.
 */
export type ChatStreamLine =
  | { type: 'accepted'; taskKey: string; messageId: string }
  | Exclude<ChatEvent, { type: 'done' }>
  | { type: 'done'; messageId: string; message: ChatMessageDto | null };

/**
 * Where a reply being written stands:
 * - `sending`: the question is on its way
 * - `connecting`: saved; Omenai is reading the story and its research
 * - `composing`: the research is read; the AI service is putting the answer together
 * - `retrying`: the AI service turned the request away for a moment and it is being re-sent
 * - `generating`: the answer is arriving
 * - `checking`: the whole answer is in; its quotes are being checked before it's saved
 * - `stopping`: the editor pressed Stop
 * - `done` / `failed`: finished either way
 */
export type ChatTurnPhase =
  | 'sending'
  | 'connecting'
  | 'composing'
  | 'retrying'
  | 'generating'
  | 'checking'
  | 'stopping'
  | 'done'
  | 'failed';

export interface ChatTurn {
  /** Tells this reply apart from the next one, which can start as soon as this one is saved. */
  id: string;
  question: string;
  startedAt: string;
  phase: ChatTurnPhase;
  /** When the current phase began (this browser's clock: the whole turn is timed here). */
  phaseAt: number;
  /** What the answer is being written from, once the research has been read. */
  context: { briefs: number; sources: number } | null;
  taskKey: string | null;
  messageId: string | null;
  /** The answer so far: a preview, replaced by the checked reply once saved. */
  text: string;
  failure: { code: ChatFailureCode; message: string } | null;
  reply: ChatMessageDto | null;
}

let turns = 0;

export function startTurn(question: string, now: Date = new Date()): ChatTurn {
  turns += 1;
  return {
    id: `${now.getTime()}-${turns}`,
    question,
    startedAt: now.toISOString(),
    phase: 'sending',
    phaseAt: now.getTime(),
    context: null,
    taskKey: null,
    messageId: null,
    text: '',
    failure: null,
    reply: null,
  };
}

const settled = (turn: ChatTurn) => turn.phase === 'done' || turn.phase === 'failed';

/** The next state after one line of the stream. Stopping stays stopping until the end. */
export function applyLine(turn: ChatTurn, line: ChatStreamLine, now = Date.now()): ChatTurn {
  if (settled(turn)) return turn;
  const stopping = turn.phase === 'stopping';
  const to = (phase: ChatTurnPhase): Pick<ChatTurn, 'phase' | 'phaseAt'> =>
    stopping || phase === turn.phase
      ? { phase: turn.phase, phaseAt: turn.phaseAt }
      : { phase, phaseAt: now };
  switch (line.type) {
    case 'accepted':
      return { ...turn, ...to('connecting'), taskKey: line.taskKey, messageId: line.messageId };
    case 'started':
      return { ...turn, ...to('connecting') };
    case 'context':
      return {
        ...turn,
        ...to('composing'),
        context: { briefs: line.briefs, sources: line.sources },
      };
    case 'retrying':
      // The wait for the answer goes on: its clock doesn't restart.
      return stopping ? turn : { ...turn, phase: 'retrying' };
    case 'text':
      return { ...turn, ...to('generating'), text: line.text };
    case 'checking':
      return { ...turn, ...to('checking') };
    case 'research':
    case 'research_skipped':
      // The saved reply records the same (`followUp`), and the page follows it from there.
      return turn;
    case 'done':
      return { ...turn, phase: 'done', phaseAt: now, reply: line.message };
    case 'failed':
      // Nothing partial survives a failure: the preview goes.
      return {
        ...turn,
        phase: 'failed',
        phaseAt: now,
        text: '',
        failure: { code: line.code, message: line.message },
      };
  }
}

/** Stop is offered once the question is saved and until the answer is complete. */
export function canStop(turn: ChatTurn | null): boolean {
  return Boolean(
    turn?.taskKey &&
    (turn.phase === 'connecting' ||
      turn.phase === 'composing' ||
      turn.phase === 'retrying' ||
      turn.phase === 'generating'),
  );
}

/**
 * The reply's steps before its text arrives, as the progress list shows them: nothing under way
 * while the question is still being sent, then reading the research, then putting the answer
 * together (with what was read, once known).
 */
export function turnProgress(turn: ChatTurn): {
  step: 'read' | 'compose' | null;
  steps: Array<{ step: string; counts: { briefs: number; sources: number } | null }>;
} {
  if (turn.phase === 'sending') return { step: null, steps: [] };
  if (!turn.context) return { step: 'read', steps: [{ step: 'read', counts: null }] };
  return {
    step: 'compose',
    steps: [
      { step: 'read', counts: turn.context },
      { step: 'compose', counts: null },
    ],
  };
}

/**
 * Reads newline-delimited JSON from a response body as it arrives, calling `onLine` for each
 * complete line. A line split across network chunks is joined first; a malformed line is skipped.
 * Resolves when the stream ends, rejects if the connection drops.
 */
export async function readChatStream(
  body: ReadableStream<Uint8Array>,
  onLine: (line: ChatStreamLine) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const emit = (raw: string) => {
    if (!raw.trim()) return;
    try {
      onLine(JSON.parse(raw) as ChatStreamLine);
    } catch {
      // A line that isn't JSON is ignored; the final state comes from the saved records anyway.
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      emit(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
    if (done) break;
  }
  emit(buffer);
}
