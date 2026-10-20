'use client';

import type { ApiErrorResponse } from '@repo/shared';
import { Loader2, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

/**
 * Owner-only. Starts a discovery run in the background after an explicit confirmation of cost.
 * Against development fixtures the run is scripted and costs nothing, and the dialog says so.
 */
export function FindStoriesButton({ fixtures = false }: { fixtures?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  async function start() {
    setPending(true);
    const response = await fetch('/api/runs', { method: 'POST' }).catch(() => null);
    setPending(false);
    setOpen(false);
    if (!response?.ok) {
      const body = (await response?.json().catch(() => null)) as ApiErrorResponse | null;
      toast.error(body?.error.message ?? 'The search couldn’t be started.');
      return;
    }
    toast.success('Search started. It runs in the background; refresh this page to follow it.');
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="signal" className="h-12 gap-3 pr-1.5 pl-[1.125rem] text-[0.9375rem]">
          Find today’s stories
          <span className="inline-flex size-[38px] items-center justify-center rounded-full bg-ink text-white">
            <Search aria-hidden />
          </span>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Search for stories now?</DialogTitle>
          <DialogDescription>
            This does what the nightly edition does: it searches the web and has the AI assess what
            it finds. It costs about one night’s worth of search credits and AI usage, and takes
            several minutes. You can leave this page; the new edition appears when it’s ready.
          </DialogDescription>
        </DialogHeader>
        {fixtures ? (
          <p className="rounded-xl bg-amber-soft px-4 py-3 text-sm leading-relaxed text-ink">
            Development fixtures: this search is scripted and runs inside the app. It doesn’t search
            the web or use AI, and costs nothing.
          </p>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button onClick={() => void start()} disabled={pending}>
            {pending ? <Loader2 className="animate-spin" aria-hidden /> : null} Start the search
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
