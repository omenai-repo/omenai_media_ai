'use client';

import { AlertTriangle } from 'lucide-react';

import { Button } from '@/components/ui/button';

/** Shown when a dashboard page fails to load (e.g. the database is unreachable). */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div
      role="alert"
      className="surface-quiet flex max-w-2xl flex-col items-start gap-4 px-6 py-12 sm:px-10"
    >
      <AlertTriangle className="size-6 text-oxide" aria-hidden />
      <h1 className="display-md">This page couldn’t load</h1>
      <p className="font-serif text-lg leading-relaxed text-graphite">
        Something went wrong while fetching the newsroom’s information. It may be a brief connection
        problem. Try again; if it keeps happening, let whoever looks after the newsroom’s systems
        know.
        {error.digest ? (
          <span className="mt-2 block text-xs">Reference: {error.digest}</span>
        ) : null}
      </p>
      <Button variant="outline" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
