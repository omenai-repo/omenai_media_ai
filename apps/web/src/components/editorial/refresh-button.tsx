'use client';

import { RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

import { Button } from '@/components/ui/button';

/** Reloads the page's server data in place (Operations isn't polled). */
export function RefreshButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      className="h-11 px-4 font-medium"
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
    >
      <RefreshCw aria-hidden className={pending ? 'animate-spin' : undefined} /> Refresh
    </Button>
  );
}
