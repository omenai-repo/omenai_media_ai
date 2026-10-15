import type { ApiErrorResponse } from '@repo/shared';
import { AppError, ConfigError } from '@repo/core';
import { isAPIError } from 'better-auth/api';
import { connection } from 'next/server';
import * as z from 'zod';

function errorResponse(status: number, error: ApiErrorResponse['error']): Response {
  return Response.json({ error } satisfies ApiErrorResponse, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

/** Maps thrown errors to the shared `ApiErrorResponse` shape. Unknown errors never leak details. */
export function toErrorResponse(error: unknown): Response {
  if (error instanceof AppError) {
    return errorResponse(error.status, {
      code: error.code,
      message: error.message,
      details: error.details,
    });
  }
  if (isAPIError(error)) {
    // Errors raised inside Better Auth (including our auth hooks) carry a stable code.
    const body = error.body as { code?: string; message?: string } | undefined;
    return errorResponse(error.statusCode, {
      code: body?.code ?? 'AUTH_ERROR',
      message: body?.message ?? 'Authentication failed.',
    });
  }
  if (error instanceof z.ZodError) {
    return errorResponse(400, {
      code: 'VALIDATION_FAILED',
      message: 'The request was not valid.',
      details: z.flattenError(error),
    });
  }
  if (error instanceof ConfigError) {
    console.error(error.message);
    return errorResponse(503, {
      code: 'NOT_CONFIGURED',
      message: `The server is missing configuration (${error.variable}).`,
    });
  }
  console.error(error);
  return errorResponse(500, { code: 'INTERNAL', message: 'Something went wrong.' });
}

type Handler<Ctx> = (request: Request, context: Ctx) => Promise<Response>;

/** Wraps a route handler: opts out of prerendering and converts errors to JSON responses. */
export function apiHandler<Ctx>(handler: Handler<Ctx>): Handler<Ctx> {
  return async (request, context) => {
    await connection();
    try {
      return await handler(request, context);
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

export async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const body: unknown = await request.json().catch(() => {
    throw new z.ZodError([
      { code: 'custom', message: 'Request body must be JSON.', path: [], input: undefined },
    ]);
  });
  return schema.parse(body);
}
