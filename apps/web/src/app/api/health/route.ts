import { connection } from 'next/server';

import { getHealth } from '@/lib/health';

export async function GET() {
  // The response changes on every request, so keep it out of prerendering.
  await connection();

  return Response.json(getHealth(), { headers: { 'Cache-Control': 'no-store' } });
}
