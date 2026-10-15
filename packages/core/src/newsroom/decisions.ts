import { Types } from 'mongoose';

import { getModels } from '../db/models.js';
import { NotFoundError } from '../errors.js';

export const STORY_DECISIONS = ['save', 'unsave', 'skip', 'unskip'] as const;
export type StoryDecision = (typeof STORY_DECISIONS)[number];

const TRANSITION: Record<StoryDecision, { state: 'saved' | 'skipped' | 'none'; logged: string }> = {
  save: { state: 'saved', logged: 'saved' },
  unsave: { state: 'none', logged: 'unsaved' },
  skip: { state: 'skipped', logged: 'skipped' },
  unskip: { state: 'none', logged: 'unskipped' },
};

/**
 * Records an editor's decision on a story and keeps an audit trail (§10: capture decisions and
 * reasons). The state is workspace-wide. A skip tentatively suppresses the same development in
 * later runs; a genuinely new development can still be recommended.
 */
export async function decideStory(input: {
  storyId: string;
  userId: string;
  decision: StoryDecision;
  reason?: string | null;
  now?: Date;
}): Promise<{ editorialState: 'saved' | 'skipped' | 'none' }> {
  if (!Types.ObjectId.isValid(input.storyId)) throw new NotFoundError('Story not found.');
  const { Story } = await getModels();
  const { state, logged } = TRANSITION[input.decision];
  const result = await Story.updateOne(
    { _id: new Types.ObjectId(input.storyId) },
    {
      $set: { editorialState: state },
      $push: {
        decisions: {
          action: logged,
          userId: input.userId,
          reason: input.reason?.trim() || null,
          at: input.now ?? new Date(),
        },
      },
    },
  );
  if (result.matchedCount === 0) throw new NotFoundError('Story not found.');
  return { editorialState: state };
}
