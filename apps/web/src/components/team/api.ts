import type { ApiErrorResponse } from '@repo/shared';

/** Small fetch helper for the team screens: throws the server's message on failure. */
export async function teamRequest<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorResponse | null;
    throw new Error(body?.error.message ?? 'The change could not be saved.');
  }
  return (response.status === 204 ? null : await response.json()) as T;
}
