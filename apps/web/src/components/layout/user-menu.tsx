import { requirePageUser } from '@/lib/session';

import { SignOutButton } from './sign-out-button';

/** Server component: resolves the session (redirecting signed-out visitors) and shows who's here. */
export async function UserMenu() {
  const user = await requirePageUser();
  return (
    <div className="flex items-center gap-3">
      <div className="hidden text-right sm:block">
        <p className="text-sm leading-tight">{user.name || user.email}</p>
        <p className="kicker">{user.role}</p>
      </div>
      <SignOutButton />
    </div>
  );
}
