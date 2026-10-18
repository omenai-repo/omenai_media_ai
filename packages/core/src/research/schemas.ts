import * as z from 'zod';

import { CHAT_ASSESSMENTS } from '../db/models/chat-message.js';
import { CLAIM_TYPES, EVIDENCE_LEVELS } from '../db/models/research-brief.js';

/**
 * Structured output for research briefs and chat replies. Source labels are plain strings here
 * (not a pattern) so every provider accepts the schema; they are checked against the persisted
 * source set afterwards, and anything unknown is dropped.
 */
const sourceLabel = z.string().trim().max(6).describe('A source label from the list, e.g. "S2"');
const sourceLabels = z.array(sourceLabel).max(4);

/** One checkable statement with its sources and a word-for-word passage (briefs and drafts). */
export const claim = z.object({
  type: z
    .enum(CLAIM_TYPES)
    .describe(
      'fact: established by the sources; attributed: something a person or organisation says; analysis: your interpretation; open_question: unresolved or needs checking',
    ),
  text: z
    .string()
    .trim()
    .min(1)
    .max(400)
    .describe(
      'One natural sentence that reads well joined to its neighbours in a paragraph. No labels or prefixes',
    ),
  sources: sourceLabels.describe(
    'Labels of the sources that support this claim. Required for fact and attributed; may be empty for analysis or open_question',
  ),
  excerpt: z
    .string()
    .max(300)
    .describe(
      'A short passage copied word for word from the first cited source that supports the claim. Empty for analysis or open_question without sources',
    ),
});

/**
 * Generous array limits on purpose: an over-long answer that fails validation costs a whole
 * retry, so length is steered by the prompt and the descriptions, not enforced here.
 */
export const researchBriefOutputSchema = z.object({
  overview: z
    .array(claim)
    .min(1)
    .max(4)
    .describe('The opening paragraph: what is happening, who, where and when. Two or three claims'),
  whyItMatters: z
    .array(claim)
    .max(3)
    .describe('Why this matters to Omenai’s audience. One or two claims, usually analysis'),
  findings: z
    .array(claim)
    .max(6)
    .describe('The most important findings beyond the overview, strongest first. Two to four'),
  toConfirm: z
    .array(claim)
    .max(5)
    .describe(
      'The key facts or claims that still need verification, and open questions. One to three',
    ),
  background: z
    .array(claim)
    .max(8)
    .describe(
      'Optional deeper context and history, shown only when the editor asks. Empty if it adds little',
    ),
  peopleToApproach: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        role: z.string().max(120),
        why: z.string().max(200).describe('Why they could help, from the sources'),
        sources: z.array(sourceLabel).max(3),
      }),
    )
    .max(6),
  verificationChecklist: z
    .array(z.string().trim().min(1).max(200))
    .max(8)
    .describe('Suggested next steps: concrete checks an editor should make. At most four'),
});
export type ResearchBriefOutput = z.output<typeof researchBriefOutputSchema>;

/**
 * One statement of a chat answer or a focused follow-up: the brief's claim shape with roomier
 * limits, because a validation failure costs a whole repair round (and, in chat, time the editor
 * waits). Each statement carries its own sources and its own quote, so a citation always sits next
 * to the claim it is offered for.
 */
const statement = z.object({
  type: claim.shape.type,
  text: z
    .string()
    .trim()
    .min(1)
    .max(1_000)
    .describe('One natural sentence. No source labels or prefixes in the text'),
  sources: sourceLabels.describe(
    'Labels of the sources that support this statement. Required for fact and attributed; empty for analysis or open_question without sources',
  ),
  excerpt: z
    .string()
    .max(600)
    .describe(
      'A passage copied word for word from the first cited source that supports this statement specifically, including any date or figure it states. Empty when no source is cited',
    ),
});

/**
 * What the saved research means for this question, decided in the answer itself (no separate
 * call): it answers the question; it doesn't establish the specific answer and new sources could
 * (research starts on its own); or the question is outside the newsroom's domain.
 */
export { CHAT_ASSESSMENTS };
/** The kind of in-scope question (an out-of-scope one is stored as `unrelated`). */
export const CHAT_ANSWER_SCOPES = ['about_story', 'editorial', 'related'] as const;
/** focused: one specific fact; broad: the editor explicitly asked for a wider look. */
export const RESEARCH_DEPTHS = ['focused', 'broad'] as const;

/**
 * A chat answer. `assessment` comes first, so a stream reveals it before any answer text (an
 * out-of-scope question is stopped there); the reader doesn't depend on that order, though.
 */
export const chatAnswerSchema = z.object({
  assessment: z
    .enum(CHAT_ASSESSMENTS)
    .describe(
      'sufficient: the research answers this question (with editorial judgement where asked), or no search could settle it; needs_research: in scope, but the research does not establish the specific answer and new sources could; out_of_scope: outside art, culture, Omenai’s editorial work and newsroom research',
    ),
  scope: z
    .enum(CHAT_ANSWER_SCOPES)
    .describe(
      'about_story: the story itself; editorial: how it fits Omenai (priorities, audience, territory, angles); related: wider art and culture questions it raises',
    ),
  statements: z
    .array(statement)
    .max(12)
    .describe(
      'The answer. The first statement answers the exact question, or says plainly what the research does not establish. One to four statements unless the editor asks for detail; one short sentence for an out-of-scope question',
    ),
  evidence: z.enum(EVIDENCE_LEVELS).describe('How fully the research answers the question'),
  researchQuestion: z
    .string()
    .max(300)
    .describe(
      'needs_research only: one precise, self-contained question naming the person, place, work or institution and the exact fact needed; it is searched as written. Otherwise empty',
    ),
  researchDepth: z
    .enum(RESEARCH_DEPTHS)
    .describe(
      'focused for one specific fact; broad only when the editor explicitly asks for wider or deeper investigation',
    ),
});
export type ChatAnswer = z.output<typeof chatAnswerSchema>;

/** A focused follow-up: the answer to one question, not a new brief. */
export const focusedAnswerOutputSchema = z.object({
  answer: z
    .array(statement)
    .min(1)
    .max(4)
    .describe(
      'One to three statements. The first answers the FOCUS directly, or says plainly that the sources do not establish it',
    ),
  evidence: z.enum(EVIDENCE_LEVELS).describe('How fully the sources answer the FOCUS'),
  toConfirm: z
    .array(statement)
    .max(3)
    .describe('At most two points still needing checking to answer the FOCUS. Nothing else'),
  nextSteps: z
    .array(z.string().trim().min(1).max(200))
    .max(3)
    .describe('At most two concrete checks that would settle the FOCUS'),
});
export type FocusedAnswerOutput = z.output<typeof focusedAnswerOutputSchema>;
