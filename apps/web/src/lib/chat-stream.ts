import { getChatMessage, streamChatReply, type LlmClient } from '@repo/core';
import { after } from 'next/server';

import { enqueueStoryTask } from '@/lib/story-tasks';

// The line contract is shared with the workspace. `accepted` comes first, as soon as the question
// is saved; then the reply's own events; then `done` with the saved reply (or only its id, if it
// couldn't be read back) or `failed`.
import type { ChatStreamLine } from '@/components/research/chat-stream';

/**
 * Streams a reply to the browser while it is written (ADR-035).
 *
 * The reply itself doesn't depend on the connection: it runs to the end and is saved even if the
 * tab closes or reloads mid-answer (a reload shows its recorded steps and polls until it is
 * saved). `after()` keeps the work alive after the response ends, within the route's
 * `maxDuration`. Only Stop, which flags the task, cancels a reply.
 *
 * When the saved research didn't establish the answer, the reply starts focused research
 * (ADR-038): its task is recorded before `done`, so the page follows it from the record, and it is
 * handed to the background worker once the stream has closed, off the editor's wait.
 */
export function chatStreamResponse(input: {
  storyId: string;
  taskKey: string;
  messageId: string;
  llm: LlmClient;
  /** When the request arrived: the reply's deadline counts from here. */
  receivedAt: number;
}): Response {
  const encoder = new TextEncoder();
  const sink: { output: ReadableStreamDefaultController<Uint8Array> | null } = { output: null };
  const write = (line: ChatStreamLine) => {
    if (!sink.output) return;
    try {
      sink.output.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
    } catch {
      // The reader went away; the reply carries on.
      sink.output = null;
    }
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      sink.output = controller;
    },
    cancel() {
      // A closed tab or a reload: stop sending updates, never the reply.
      sink.output = null;
    },
  });

  write({ type: 'accepted', taskKey: input.taskKey, messageId: input.messageId });
  let reported = false;
  const work = (async () => {
    let followUp: string | null = null;
    try {
      const { messageId, followUp: started } = await streamChatReply({
        taskKey: input.taskKey,
        deps: { llm: input.llm, now: () => new Date() },
        receivedAt: input.receivedAt,
        onEvent: (event) => {
          if (event.type === 'done') return;
          if (event.type === 'failed') reported = true;
          write(event);
        },
      });
      followUp = started?.taskKey ?? null;
      const message = await getChatMessage(input.storyId, messageId).catch(() => null);
      write({ type: 'done', messageId, message });
    } catch (error) {
      // Failures from the reply itself are already on the stream; anything else is reported here.
      if (!reported) {
        console.error('Chat reply failed before it started', error);
        write({
          type: 'failed',
          code: 'error',
          message: 'Something went wrong while writing the reply.',
        });
      }
    } finally {
      try {
        sink.output?.close();
      } catch {
        // Already closed by the reader.
      }
      sink.output = null;
    }
    // A worker that can't be reached marks the task failed, which the page shows with "Try again".
    if (followUp)
      await enqueueStoryTask('research', followUp).catch((error: unknown) => {
        console.error('Follow-up research could not be handed to the worker', error);
      });
  })();
  after(() => work);

  return new Response(body, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      // `no-transform` keeps compression from holding the stream back until it ends.
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
