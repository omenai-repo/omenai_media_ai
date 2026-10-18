import {
  DRAFT_BODY_MAX_CHARS,
  DRAFT_TITLE_MAX_CHARS,
  getDraftsView,
  INSTRUCTIONS_MAX_CHARS,
  requestDraft,
  saveDraftEdit,
} from '@repo/core';
import { DRAFT_FORMAT_IDS } from '@repo/shared';
import * as z from 'zod';

import { apiHandler, readJson } from '@/lib/api';
import { requireUser } from '@/lib/session';
import { assertCanEnqueue, enqueueStoryTask } from '@/lib/story-tasks';

const NO_STORE = { 'Cache-Control': 'no-store' };
const format = z.enum(DRAFT_FORMAT_IDS);
const version = z.number().int().min(1).max(100_000);

/** The studio's state: every version of every format, and any draft being written. Polled. */
export const GET = apiHandler<RouteContext<'/api/stories/[id]/drafts'>>(
  async (_request, { params }) => {
    await requireUser('stories:read');
    const { id } = await params;
    return Response.json(await getDraftsView(id), { headers: NO_STORE });
  },
);

const generateSchema = z.object({
  format,
  instructions: z.string().max(INSTRUCTIONS_MAX_CHARS).optional(),
  /** Revise this version instead of starting fresh. */
  fromVersion: version.optional(),
});

/**
 * Asks Omenai for a new draft version. Records a task holding the story-and-format lock (409 if
 * one is already being written; 409 if the story has no research yet), then hands it to the
 * background worker. Nothing runs inline, and nothing is ever published.
 */
export const POST = apiHandler<RouteContext<'/api/stories/[id]/drafts'>>(
  async (request, { params }) => {
    const user = await requireUser('drafts:generate');
    assertCanEnqueue();
    const { id } = await params;
    const body = await readJson(request, generateSchema);
    const { taskKey } = await requestDraft({ storyId: id, userId: user.id, ...body });
    await enqueueStoryTask('draft', taskKey);
    return Response.json({ taskKey }, { status: 202, headers: NO_STORE });
  },
);

const editSchema = z.object({
  format,
  /** The version the editor started from. */
  baseVersion: version,
  title: z.string().max(DRAFT_TITLE_MAX_CHARS).optional(),
  body: z.string().max(DRAFT_BODY_MAX_CHARS),
});

/** Saves an editor's text as a new version, only if it differs from the latest one. */
export const PUT = apiHandler<RouteContext<'/api/stories/[id]/drafts'>>(
  async (request, { params }) => {
    const user = await requireUser('drafts:edit');
    const { id } = await params;
    const body = await readJson(request, editSchema);
    const result = await saveDraftEdit({ storyId: id, userId: user.id, ...body });
    return Response.json(result, { status: result.changed ? 201 : 200, headers: NO_STORE });
  },
);
