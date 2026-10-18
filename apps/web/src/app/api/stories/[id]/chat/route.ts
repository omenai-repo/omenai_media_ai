import { getLlmClient, isFixtureRuntime, postChatMessage, requestChatStop } from '@repo/core';
import * as z from 'zod';

import { apiHandler, readJson } from '@/lib/api';
import { chatStreamResponse } from '@/lib/chat-stream';
import { requireUser } from '@/lib/session';

/**
 * The platform ends this function after 90 s. A reply has a 60 s deadline of its own (every
 * attempt and retry included), so this only matters if something below it hangs.
 */
export const maxDuration = 90;

const bodySchema = z.object({ message: z.string().trim().min(1).max(2_000) });

/**
 * Posts a question about a story and streams the reply as it is written (newline-delimited JSON,
 * see `lib/chat-stream.ts`). Needs a research brief; the reply comes from the story's research
 * only, and the story is locked until it is done (409 otherwise). Everything that can be refused
 * is refused here, before anything is saved, as a normal JSON error.
 */
export const POST = apiHandler<RouteContext<'/api/stories/[id]/chat'>>(
  async (request, { params }) => {
    const receivedAt = Date.now();
    const user = await requireUser('chat:write');
    const { id } = await params;
    const { message } = await readJson(request, bodySchema);
    // Missing AI configuration fails here, before the question is saved.
    const llm = isFixtureRuntime()
      ? (await import('@repo/core/fixtures')).createFixtureChatLlm()
      : getLlmClient();
    const { taskKey, messageId } = await postChatMessage({
      storyId: id,
      userId: user.id,
      content: message,
    });
    return chatStreamResponse({ storyId: id, taskKey, messageId, llm, receivedAt });
  },
);

const stopSchema = z.object({ taskKey: z.string().min(1).max(200) });

/** Stops a reply that is being written. Nothing of it is saved; the question stays. */
export const DELETE = apiHandler<RouteContext<'/api/stories/[id]/chat'>>(
  async (request, { params }) => {
    await requireUser('chat:write');
    const { id } = await params;
    const { taskKey } = await readJson(request, stopSchema);
    const stopping = await requestChatStop({ storyId: id, taskKey });
    return Response.json(
      { stopping },
      { status: stopping ? 202 : 200, headers: { 'Cache-Control': 'no-store' } },
    );
  },
);
