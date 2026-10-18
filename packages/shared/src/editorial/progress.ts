/**
 * The steps a piece of work reports while it runs, shared by the services that record them and
 * the interface that describes them. A step is recorded only when the work actually reaches it,
 * so the interface never shows a stage that didn't happen. Order is the order of the work.
 */
export const RESEARCH_STEPS = ['sources', 'search', 'read', 'write', 'check'] as const;
export const DRAFT_STEPS = ['research', 'write', 'statements', 'shorten', 'check', 'save'] as const;
export const CHAT_STEPS = ['read', 'compose', 'write', 'check'] as const;

export type ResearchStep = (typeof RESEARCH_STEPS)[number];
export type DraftStep = (typeof DRAFT_STEPS)[number];
export type ChatStep = (typeof CHAT_STEPS)[number];
export type WorkStep = ResearchStep | DraftStep | ChatStep;

/** What a step found or used, as counts only (never content). */
export interface StepCounts {
  /** Research briefs read. */
  briefs?: number;
  /** Sources read or written from. */
  sources?: number;
  /** New articles a search found that are about the story. */
  found?: number;
  /** Search results set aside as not about the story. */
  setAside?: number;
  /** Articles an earlier attempt found, used again without searching. */
  reused?: number;
  /** Articles read in full. */
  articles?: number;
  /** A draft's length and its format's limit, in the format's unit (shortening). */
  length?: number;
  limit?: number;
}

/**
 * A passing condition of the current step: the AI service turned a request away and it is being
 * sent again (`retrying`), or a response wasn't in a form that could be checked and the model is
 * being asked to correct it (`repairing`).
 */
export const STEP_NOTICES = ['retrying', 'repairing'] as const;
export type StepNotice = (typeof STEP_NOTICES)[number];

/** One step reached in the current attempt. */
export interface StepRecord<S extends string = WorkStep> {
  step: S;
  startedAt: string;
  counts: StepCounts | null;
}
