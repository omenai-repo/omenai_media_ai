'use client';

import { LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';

/** Signs out and returns to the sign-in page. `iconOnly` is the round header button. */
export function SignOutButton({
  className,
  iconOnly = false,
}: {
  className?: string;
  iconOnly?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const signOut = () =>
    startTransition(async () => {
      await authClient.signOut();
      router.replace('/login');
      router.refresh();
    });

  if (iconOnly)
    return (
      <Button
        variant="outline"
        size="icon"
        className={className}
        disabled={pending}
        onClick={signOut}
        aria-label="Sign out"
        title="Sign out"
      >
        <LogOut aria-hidden />
      </Button>
    );
  return (
    <Button variant="ghost" size="sm" className={className} disabled={pending} onClick={signOut}>
      <LogOut aria-hidden className="text-graphite" />
      Sign out
    </Button>
  );
}
