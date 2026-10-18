'use client';

import type { ApiErrorResponse } from '@repo/shared';
import { Bookmark, BookmarkCheck, Loader2, Undo2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
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
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

type State = 'none' | 'saved' | 'skipped';
type Decision = 'save' | 'unsave' | 'skip' | 'unskip';

async function decide(storyId: string, decision: Decision, reason?: string): Promise<State> {
  const response = await fetch(`/api/stories/${storyId}/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision, reason: reason || undefined }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorResponse | null;
    throw new Error(body?.error.message ?? 'The decision could not be saved.');
  }
  return ((await response.json()) as { editorialState: State }).editorialState;
}

/** Save / skip controls. Server state is the source of truth; the page refreshes after a change. */
export function DecisionButtons({
  storyId,
  state,
  compact = false,
}: {
  storyId: string;
  state: State;
  compact?: boolean;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState<State>(state);
  const [pending, startTransition] = useTransition();
  const [skipOpen, setSkipOpen] = useState(false);
  const [reason, setReason] = useState('');

  function run(decision: Decision, message: string, skipReason?: string) {
    startTransition(async () => {
      try {
        setCurrent(await decide(storyId, decision, skipReason));
        toast.success(message);
        router.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Something went wrong.');
      }
    });
  }

  const size = compact ? 'sm' : 'default';
  // Secondary to opening or researching a story: quiet on cards, outlined on the story page.
  const variant = compact ? 'ghost' : 'outline';
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {current === 'saved' ? (
        <Button
          variant={variant}
          size={size}
          disabled={pending}
          onClick={() => run('unsave', 'Removed from your reading list')}
          aria-label="Saved. Remove from your reading list"
        >
          <BookmarkCheck aria-hidden className="text-ochre" /> Saved
        </Button>
      ) : (
        <Button
          variant={variant}
          size={size}
          disabled={pending || current === 'skipped'}
          onClick={() => run('save', 'Saved to your reading list')}
        >
          {pending ? <Loader2 className="animate-spin" aria-hidden /> : <Bookmark aria-hidden />}
          Save
        </Button>
      )}
      {current === 'skipped' ? (
        <Button variant="quiet" disabled={pending} onClick={() => run('unskip', 'Skip undone')}>
          <Undo2 aria-hidden /> Skipped. Undo
        </Button>
      ) : (
        <Button variant="quiet" disabled={pending} onClick={() => setSkipOpen(true)}>
          Skip
        </Button>
      )}

      <Dialog open={skipOpen} onOpenChange={setSkipOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Skip this story?</DialogTitle>
            <DialogDescription>
              We won’t recommend later reports of this same development. A genuinely new
              development, such as an auction result after an announcement, can still come through.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`skip-reason-${storyId}`}>Why are you skipping it? (optional)</Label>
            <Textarea
              id={`skip-reason-${storyId}`}
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              placeholder="For example: covered last month, or not enough of an Omenai angle"
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button
              onClick={() => {
                setSkipOpen(false);
                run('skip', 'Story skipped', reason.trim());
              }}
            >
              Skip story
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** For the reading list: one explicit action, so "Saved" never doubles as a remove button there. */
export function RemoveFromListButton({ storyId }: { storyId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="quiet"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          try {
            await decide(storyId, 'unsave');
            toast.success('Removed from your reading list');
            router.refresh();
          } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Something went wrong.');
          }
        })
      }
    >
      {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
      Remove from list
    </Button>
  );
}
