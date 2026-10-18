import type { ChatMessageDto } from '@repo/core';
import { describe, expect, it } from 'vitest';

import {
  applyLine,
  canStop,
  readChatStream,
  startTurn,
  turnProgress,
  type ChatStreamLine,
} from './chat-stream';

function body(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const reply = { id: 'm2', role: 'assistant', content: 'Yes.' } as ChatMessageDto;

describe('reading the chat stream', () => {
  it('joins lines split across network chunks and skips a malformed one', async () => {
    const lines: ChatStreamLine[] = [];
    await readChatStream(
      body([
        '{"type":"accepted","taskKey":"chat:1","messageId":"m1"}\n{"type":"te',
        'xt","text":"Héllo 🎨"}\nnot json\n',
        '{"type":"done","messageId":"m2","message":null}',
      ]),
      (line) => lines.push(line),
    );
    expect(lines).toEqual([
      { type: 'accepted', taskKey: 'chat:1', messageId: 'm1' },
      { type: 'text', text: 'Héllo 🎨' },
      { type: 'done', messageId: 'm2', message: null },
    ]);
  });

  it('decodes a character split between two chunks', async () => {
    const bytes = new TextEncoder().encode('{"type":"text","text":"é"}\n');
    const lines: ChatStreamLine[] = [];
    await readChatStream(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 24));
          controller.enqueue(bytes.slice(24));
          controller.close();
        },
      }),
      (line) => lines.push(line),
    );
    expect(lines).toEqual([{ type: 'text', text: 'é' }]);
  });
});

describe('a reply’s state', () => {
  it('moves from sending to connecting, generating, checking and done', () => {
    let turn = startTurn('Does this suit Omenai?', new Date('2026-10-16T18:00:00Z'));
    expect(turn.phase).toBe('sending');
    expect(canStop(turn)).toBe(false);
    turn = applyLine(turn, { type: 'accepted', taskKey: 'chat:1', messageId: 'm1' });
    expect(turn).toMatchObject({ phase: 'connecting', taskKey: 'chat:1', messageId: 'm1' });
    expect(canStop(turn)).toBe(true);
    turn = applyLine(turn, { type: 'retrying', status: 503 });
    expect(turn.phase).toBe('retrying');
    turn = applyLine(turn, { type: 'text', text: 'Yes, lar' });
    turn = applyLine(turn, { type: 'text', text: 'Yes, largely.' });
    expect(turn).toMatchObject({ phase: 'generating', text: 'Yes, largely.' });
    turn = applyLine(turn, { type: 'checking' });
    expect(canStop(turn)).toBe(false);
    turn = applyLine(turn, { type: 'done', messageId: 'm2', message: reply });
    expect(turn).toMatchObject({ phase: 'done', reply });
    // Nothing changes a finished reply.
    expect(applyLine(turn, { type: 'text', text: 'late' })).toBe(turn);
  });

  it('says what the answer is written from, and times each phase from when it began', () => {
    let turn = startTurn('Who is behind this?', new Date(1_000));
    // Nothing is under way on the server until the question is saved.
    expect(turnProgress(turn)).toEqual({ step: null, steps: [] });
    turn = applyLine(turn, { type: 'accepted', taskKey: 't', messageId: 'm' }, 1_400);
    turn = applyLine(turn, { type: 'started' }, 1_500);
    expect(turn).toMatchObject({ phase: 'connecting', phaseAt: 1_400 });
    expect(turnProgress(turn)).toEqual({ step: 'read', steps: [{ step: 'read', counts: null }] });

    turn = applyLine(turn, { type: 'context', briefs: 2, sources: 12 }, 2_000);
    expect(turn).toMatchObject({
      phase: 'composing',
      phaseAt: 2_000,
      context: { briefs: 2, sources: 12 },
    });
    expect(canStop(turn)).toBe(true);
    expect(turnProgress(turn)).toEqual({
      step: 'compose',
      steps: [
        { step: 'read', counts: { briefs: 2, sources: 12 } },
        { step: 'compose', counts: null },
      ],
    });
    // A retry doesn't restart the wait: the editor has been waiting since the research was read.
    turn = applyLine(turn, { type: 'retrying', status: 503 }, 9_000);
    expect(turn).toMatchObject({ phase: 'retrying', phaseAt: 2_000 });
    turn = applyLine(turn, { type: 'text', text: 'It is' }, 12_000);
    expect(turn).toMatchObject({ phase: 'generating', phaseAt: 12_000 });
  });

  it('drops the preview on failure, so nothing partial is left on screen', () => {
    let turn = applyLine(startTurn('q'), { type: 'accepted', taskKey: 't', messageId: 'm' });
    turn = applyLine(turn, { type: 'text', text: 'Half an ans' });
    turn = applyLine(turn, { type: 'failed', code: 'unavailable', message: 'busy' });
    expect(turn).toMatchObject({
      phase: 'failed',
      text: '',
      failure: { code: 'unavailable', message: 'busy' },
    });
  });

  it('stays stopping after Stop until the server confirms', () => {
    let turn = applyLine(startTurn('q'), { type: 'accepted', taskKey: 't', messageId: 'm' });
    turn = { ...turn, phase: 'stopping' };
    turn = applyLine(turn, { type: 'text', text: 'more' });
    expect(turn.phase).toBe('stopping');
    turn = applyLine(turn, { type: 'failed', code: 'stopped', message: 'You stopped this reply.' });
    expect(turn).toMatchObject({ phase: 'failed', failure: { code: 'stopped' } });
  });
});
