import * as z from 'zod';

/** Body returned by the API for every failed request. */
export const apiErrorResponseSchema = z.object({
  error: z.object({
    /** Stable, machine-readable identifier such as `NOT_FOUND`. */
    code: z.string(),
    /** Human-readable message that is safe to show to clients. */
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
