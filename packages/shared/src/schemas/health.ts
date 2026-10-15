import * as z from 'zod';

/** Response body of `GET /api/health`. */
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  /** Seconds since the API process started. */
  uptime: z.number().nonnegative(),
  timestamp: z.iso.datetime(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
