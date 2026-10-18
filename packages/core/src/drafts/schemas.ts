import * as z from 'zod';

import { claim } from '../research/schemas.js';

/**
 * A draft's statement: the brief's claim, with room for a longer quote. Live on 2026-10-18, two of
 * eight drafts needed a whole repair round (2.3 s and 7.7 s) only because a quote ran past 300
 * characters. The quote is still checked word for word against its source.
 */
const draftClaim = claim.extend({
  excerpt: z
    .string()
    .max(600)
    .describe(
      'A passage copied word for word from the first cited source that supports the claim. Empty for analysis or open_question without sources',
    ),
});

/**
 * Structured output for a draft. The body is plain text the editor can use as it is; the claims
 * list the draft's statements of fact with their sources, so the server can check each one
 * against the stored source text (the body itself carries no labels to strip before copying).
 */
export const draftOutputSchema = z.object({
  title: z
    .string()
    .trim()
    .max(200)
    .describe('The headline for formats that have one; an empty string for social posts'),
  body: z
    .string()
    .trim()
    .min(1)
    .max(14_000)
    .describe(
      'The draft, ready for an editor to revise: plain text, paragraphs separated by a blank line. No source labels, links, markdown or headings',
    ),
  claims: z
    .array(draftClaim)
    .max(15)
    .describe(
      'Every statement of fact in the draft, in order, each with the labels of its sources and a short passage copied word for word from the first one. Your own interpretation may be listed as analysis with no sources',
    ),
});
export type DraftOutput = z.output<typeof draftOutputSchema>;
