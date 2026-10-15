import { getConnection } from './client.js';
import { aiUsageModel } from './models/ai-usage.js';
import { authSessionModel, authUserModel } from './models/auth.js';
import { invitationModel } from './models/invitation.js';

/** All Mongoose models, bound to the shared connection. */
export async function getModels() {
  const connection = await getConnection();
  return {
    Invitation: invitationModel(connection),
    AuthUser: authUserModel(connection),
    AuthSession: authSessionModel(connection),
    AiUsage: aiUsageModel(connection),
  };
}

export type Models = Awaited<ReturnType<typeof getModels>>;

/**
 * Better Auth's Mongo adapter only builds indexes its schema declares explicitly, and by default
 * it declares none, not even for `email: unique`. We own these constraints so uniqueness is
 * enforced by the database, not just by application checks.
 */
const AUTH_INDEXES = [
  { collection: 'user', key: { email: 1 }, name: 'omenai_user_email_unique', unique: true },
  { collection: 'session', key: { token: 1 }, name: 'omenai_session_token_unique', unique: true },
  { collection: 'session', key: { userId: 1 }, name: 'omenai_session_user' },
  {
    collection: 'account',
    key: { providerId: 1, accountId: 1 },
    name: 'omenai_account_provider_unique',
    unique: true,
  },
  { collection: 'account', key: { userId: 1 }, name: 'omenai_account_user' },
  { collection: 'verification', key: { identifier: 1 }, name: 'omenai_verification_identifier' },
  // Database-backed rate limiting (one document per client key and path).
  { collection: 'rateLimit', key: { key: 1 }, name: 'omenai_ratelimit_key_unique', unique: true },
] as const;

/** Creates all indexes. Idempotent; run on deploy (`pnpm db:indexes`) and in tests. */
export async function ensureIndexes(): Promise<void> {
  const connection = await getConnection();
  const { Invitation, AiUsage } = await getModels();
  await Invitation.syncIndexes();
  await AiUsage.syncIndexes();

  for (const index of AUTH_INDEXES) {
    await connection.db!.collection(index.collection).createIndex(index.key, {
      name: index.name,
      unique: 'unique' in index ? index.unique : false,
    });
  }
}
