/**
 * First-owner provisioning. Run by an operator with direct database access:
 *
 *   pnpm owner:invite you@example.com
 *
 * It issues an owner invitation and prints the link. It refuses to run once an active owner
 * exists, so it cannot be used to escalate privileges later; further owners are invited from
 * the Team page. There is deliberately no HTTP endpoint for this.
 */
import { createInvitation, normalizeEmail } from '../auth/invitations.js';
import { hasActiveOwner } from '../auth/users.js';
import { requireEnv } from '../config/env.js';
import { closeDb } from '../db/client.js';
import { ensureIndexes } from '../db/models.js';

async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error('Usage: pnpm owner:invite <email>');
    process.exitCode = 1;
    return;
  }

  const appUrl = requireEnv('BETTER_AUTH_URL').replace(/\/$/, '');
  await ensureIndexes();

  if (await hasActiveOwner()) {
    console.error(
      'An active owner already exists. Invite further owners from the Team page in the app.',
    );
    process.exitCode = 1;
    return;
  }

  const { token, invitation } = await createInvitation({
    email: normalizeEmail(email),
    role: 'owner',
    invitedBy: 'cli:owner-invite',
  });

  console.log(`Owner invitation created for ${invitation.email}.`);
  console.log(`Expires: ${invitation.expiresAt.toISOString()}`);
  console.log(
    `\nOpen this link to choose a name and password for that account:\n\n  ${appUrl}/invite/${token}\n`,
  );
  console.log('The link is shown only once. Run this command again to issue a new one.');
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
